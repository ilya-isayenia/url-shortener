import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { type Cache, createCache } from '../src/cache.js';
import { type Db, createDb, migrate } from '../src/db.js';
import { LinkService } from '../src/links.js';

// The API against a real PostgreSQL and Redis (DATABASE_URL, REDIS_URL). The run gets a database
// of its own and a key prefix of its own, and drops them at the end.
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `url_shortener_test_${run}`;
const BASE_URL = 'http://sho.rt';

function databaseUrl(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.pathname = `/${name}`;
  return url.toString();
}

let admin: pg.Client;
let db: Db;
let cache: Cache;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error('The API tests need DATABASE_URL and REDIS_URL');
  }
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  db = createDb(databaseUrl(databaseName));
  await migrate(db);
  cache = createCache(process.env.REDIS_URL, `test:${run}:`);
  app = buildApp({ links: new LinkService(db, cache, 60), baseUrl: BASE_URL });
});

beforeEach(async () => {
  await db.query('TRUNCATE links RESTART IDENTITY');
});

afterAll(async () => {
  await app?.close();
  await cache?.close();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin?.end();
});

const shorten = (url: unknown, expiresInSeconds?: unknown) =>
  app.inject({ method: 'POST', url: '/links', payload: { url, expiresInSeconds } });

describe('POST /links', () => {
  it('shortens a URL', async () => {
    const res = await shorten('https://example.com/docs');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.url).toBe('https://example.com/docs');
    expect(body.shortUrl).toBe(`${BASE_URL}/${body.slug}`);
  });

  it('gives the same URL a new slug each time', async () => {
    const a = (await shorten('https://example.com')).json();
    const b = (await shorten('https://example.com')).json();
    expect(a.slug).not.toBe(b.slug);
  });

  it('refuses what it cannot shorten', async () => {
    expect((await shorten('ftp://example.com')).statusCode).toBe(400);
    expect((await shorten('not a url')).statusCode).toBe(400);
    expect((await shorten('')).statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/links', payload: {} });
    expect(missing.statusCode).toBe(400);
  });
});

describe('GET /:slug', () => {
  it('redirects to the URL', async () => {
    const { slug } = (await shorten('https://example.com/a')).json();
    const res = await app.inject({ method: 'GET', url: `/${slug}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/a');
  });

  it('answers 404 for an unknown or malformed slug', async () => {
    expect((await app.inject({ method: 'GET', url: '/nope123' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/no-pe' })).statusCode).toBe(404);
  });

  it('serves a resolved link from the cache', async () => {
    const { slug } = (await shorten('https://example.com/cached')).json();
    await app.inject({ method: 'GET', url: `/${slug}` });
    // Gone from the database, still in the cache: the redirect doesn't need the database.
    await db.query('DELETE FROM links WHERE slug = $1', [slug]);
    const res = await app.inject({ method: 'GET', url: `/${slug}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/cached');
  });
});

describe('GET /links/:slug', () => {
  it('shows a link', async () => {
    const created = (await shorten('https://example.com/info')).json();
    const res = await app.inject({ method: 'GET', url: `/links/${created.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
  });

  it('answers 404 for an unknown slug', async () => {
    expect((await app.inject({ method: 'GET', url: '/links/nope123' })).statusCode).toBe(404);
  });
});

describe('link expiry', () => {
  it('stores when a link expires', async () => {
    const before = Date.now();
    const body = (await shorten('https://example.com/soon', 3600)).json();
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_599_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_601_000);
    expect((await shorten('https://example.com/forever')).json().expiresAt).toBeNull();
  });

  it('redirects until the link expires, then answers 410', async () => {
    const { slug } = (await shorten('https://example.com/soon', 3600)).json();
    expect((await app.inject({ method: 'GET', url: `/${slug}` })).statusCode).toBe(302);
    // Expired in the database, and the cache must not outlive it.
    await db.query("UPDATE links SET expires_at = now() - interval '1 second' WHERE slug = $1", [
      slug,
    ]);
    await cache.set(`link:${slug}`, 'https://example.com/soon', 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const res = await app.inject({ method: 'GET', url: `/${slug}` });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'Link expired' });
  });

  it('still shows an expired link', async () => {
    const { slug } = (await shorten('https://example.com/old', 60)).json();
    await db.query("UPDATE links SET expires_at = now() - interval '1 hour' WHERE slug = $1", [
      slug,
    ]);
    const res = await app.inject({ method: 'GET', url: `/links/${slug}` });
    expect(res.statusCode).toBe(200);
    expect(Date.parse(res.json().expiresAt)).toBeLessThan(Date.now());
  });

  it('refuses an expiry out of range or not a whole number', async () => {
    expect((await shorten('https://example.com', 59)).statusCode).toBe(400);
    expect((await shorten('https://example.com', 366 * 24 * 3600)).statusCode).toBe(400);
    expect((await shorten('https://example.com', 90.5)).statusCode).toBe(400);
  });
});

describe('GET /health', () => {
  it('is ok', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });
});
