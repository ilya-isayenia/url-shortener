import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { type Cache, createCache } from '../src/cache.js';
import { type Db, createDb, migrate } from '../src/db.js';
import { LinkService } from '../src/links.js';
import { newSlug } from '../src/slug.js';

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
let redis: Redis;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error('The API tests need DATABASE_URL and REDIS_URL');
  }
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  db = createDb(databaseUrl(databaseName));
  // Dropping the database at teardown ends the pool's connections from the server side: that is
  // expected then, not a failure (57P01 — terminated by an administrator command).
  db.on('error', (err: Error & { code?: string }) => {
    if (err.code !== '57P01') throw err;
  });
  await migrate(db);
  cache = createCache(process.env.REDIS_URL, `test:${run}:`);
  redis = new Redis(process.env.REDIS_URL);
  app = buildApp({ links: new LinkService(db, cache, 60), baseUrl: BASE_URL });
});

async function clearCache(): Promise<void> {
  const keys = await redis.keys(`test:${run}:*`);
  if (keys.length) await redis.del(...keys);
}

beforeEach(async () => {
  await db.query('TRUNCATE links RESTART IDENTITY');
  await clearCache();
});

afterAll(async () => {
  await clearCache();
  await app?.close();
  await cache?.close();
  await redis?.quit();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin?.end();
});

const shorten = (url: unknown) => app.inject({ method: 'POST', url: '/links', payload: { url } });
const shortenAs = (url: unknown, alias: unknown) =>
  app.inject({ method: 'POST', url: '/links', payload: { url, alias } });
const count = async () => Number((await db.query('SELECT count(*) FROM links')).rows[0].count);

describe('POST /links', () => {
  it('shortens a URL', async () => {
    const res = await shorten('https://example.com/docs');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.url).toBe('https://example.com/docs');
    expect(body.shortUrl).toBe(`${BASE_URL}/${body.slug}`);
    expect(body.slug).toMatch(/^[0-9a-zA-Z]{7}$/);
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

describe('POST /links with an alias', () => {
  it('uses the alias as the slug, in lowercase', async () => {
    const res = await shortenAs('https://example.com/docs', 'docs');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slug).toBe('docs');
    expect(body.url).toBe('https://example.com/docs');
    expect(body.shortUrl).toBe(`${BASE_URL}/docs`);

    const mixed = (await shortenAs('https://example.com/docs2', 'MyDocs')).json();
    expect(mixed.slug).toBe('mydocs');
    expect(mixed.shortUrl).toBe(`${BASE_URL}/mydocs`);
  });

  it('resolves and looks up in any case', async () => {
    await shortenAs('https://example.com/docs', 'docs');

    for (const path of ['/docs', '/Docs', '/DOCS']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://example.com/docs');
    }

    const created = (await app.inject({ method: 'GET', url: '/links/docs' })).json();
    for (const path of ['/links/docs', '/links/DoCs']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(created);
    }
  });

  it('keeps a random slug case-sensitive', async () => {
    await db.query("INSERT INTO links (slug, url) VALUES ('AbC1234', 'https://example.com/r')");
    const ok = await app.inject({ method: 'GET', url: '/AbC1234' });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('https://example.com/r');
    const swapped = await app.inject({ method: 'GET', url: '/aBc1234' });
    expect(swapped.statusCode).toBe(404);
  });

  it('refuses a malformed alias, creating no link', async () => {
    const aliases = ['', 'my-docs', 'docs/x', 'dökumente', 'Key', 'a'.repeat(33), null];
    for (const alias of aliases) {
      const res = await shortenAs('https://example.com/docs', alias);
      expect(res.statusCode).toBe(400);
    }
    expect(await count()).toBe(0);
  });

  it('refuses a reserved alias, creating no link', async () => {
    for (const alias of ['health', 'Health', 'LINKS']) {
      const res = await shortenAs('https://example.com/docs', alias);
      expect(res.statusCode).toBe(400);
    }
    expect(await count()).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });

  it('refuses an alias that is taken, ignoring case', async () => {
    await shortenAs('https://example.com/a', 'docs');
    const res = await shortenAs('https://example.com/b', 'Docs');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty('error');
    const redirect = await app.inject({ method: 'GET', url: '/docs' });
    expect(redirect.headers.location).toBe('https://example.com/a');
  });

  it('refuses an alias equal to an existing random slug, ignoring case', async () => {
    await db.query("INSERT INTO links (slug, url) VALUES ('AbC1234', 'https://example.com/r')");
    expect((await shortenAs('https://example.com/x', 'AbC1234')).statusCode).toBe(409);
    expect((await shortenAs('https://example.com/y', 'abc1234')).statusCode).toBe(409);
    const redirect = await app.inject({ method: 'GET', url: '/AbC1234' });
    expect(redirect.headers.location).toBe('https://example.com/r');
  });

  it('never gives a random slug that shadows an existing alias', async () => {
    const queue = ['ABC1234', 'xyz9876'];
    const service = new LinkService(db, cache, 60, () => queue.shift() ?? newSlug());
    const alias = await service.create('https://example.com/alias', 'abc1234');
    expect(alias.slug).toBe('abc1234');

    const other = await service.create('https://example.com/other');
    expect(other.slug).toBe('xyz9876');

    const redirect = await app.inject({ method: 'GET', url: '/abc1234' });
    expect(redirect.headers.location).toBe('https://example.com/alias');
  });

  it('still validates the URL when the alias is good', async () => {
    const res = await shortenAs('ftp://example.com', 'files');
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/links/files' })).statusCode).toBe(404);
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

describe('GET /health', () => {
  it('is ok', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });
});

describe('migrate', () => {
  it('is safe to run again on an already-migrated database', async () => {
    await expect(migrate(db)).resolves.toBeUndefined();
  });
});
