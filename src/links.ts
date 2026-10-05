import type { Cache } from './cache.js';
import type { Db } from './db.js';
import { newSlug } from './slug.js';

export interface Link {
  slug: string;
  url: string;
  createdAt: string;
  /** When the link stops redirecting; null — never. */
  expiresAt: string | null;
}

/** What a slug resolves to: its URL, or why there is none. */
export type Resolved = { status: 'found'; url: string } | { status: 'expired' } | { status: 'missing' };

/** The URL can't be shortened: the API answers 400 with the message. */
export class InvalidUrlError extends Error {}

/** Only absolute http(s) URLs are shortened, in their normalized form. */
export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InvalidUrlError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError('Only http and https URLs can be shortened');
  }
  return url.toString();
}

interface LinkRow {
  slug: string;
  url: string;
  created_at: Date;
  expires_at: Date | null;
}

const toLink = (row: LinkRow): Link => ({
  slug: row.slug,
  url: row.url,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at?.toISOString() ?? null,
});

const COLUMNS = 'slug, url, created_at, expires_at';

/**
 * How long a link may stay cached: never past its expiry, so a cached link is always a live one.
 * 0 — don't cache it.
 */
export function cacheTtl(link: Link, ttlSeconds: number, now = Date.now()): number {
  if (!link.expiresAt) return ttlSeconds;
  const left = Math.floor((Date.parse(link.expiresAt) - now) / 1000);
  return Math.max(0, Math.min(ttlSeconds, left));
}

const cacheKey = (slug: string) => `link:${slug}`;

/** A slug collision is retried with a new slug this many times. */
const MAX_ATTEMPTS = 5;

export class LinkService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly cacheTtlSeconds: number,
  ) {}

  /** `expiresInSeconds` — the link stops redirecting that long after it is made. */
  async create(input: string, expiresInSeconds?: number): Promise<Link> {
    const url = normalizeUrl(input);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = await this.db.query<LinkRow>(
        `INSERT INTO links (slug, url, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3::int))
         ON CONFLICT (slug) DO NOTHING
         RETURNING ${COLUMNS}`,
        [newSlug(), url, expiresInSeconds ?? null],
      );
      if (result.rows[0]) return toLink(result.rows[0]);
    }
    throw new Error('No free slug found');
  }

  async get(slug: string): Promise<Link | null> {
    const result = await this.db.query<LinkRow>(`SELECT ${COLUMNS} FROM links WHERE slug = $1`, [
      slug,
    ]);
    return result.rows[0] ? toLink(result.rows[0]) : null;
  }

  /**
   * The URL a slug redirects to: from the cache when it's there, else from the database. The
   * cache never holds a link past its expiry, so only the database can say it expired.
   */
  async resolve(slug: string): Promise<Resolved> {
    const cached = await this.cache.get(cacheKey(slug));
    if (cached !== null) return { status: 'found', url: cached };
    const link = await this.get(slug);
    if (!link) return { status: 'missing' };
    const ttl = cacheTtl(link, this.cacheTtlSeconds);
    if (link.expiresAt && ttl === 0) return { status: 'expired' };
    await this.cache.set(cacheKey(slug), link.url, ttl);
    return { status: 'found', url: link.url };
  }
}
