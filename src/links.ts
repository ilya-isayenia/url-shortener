import type { Cache } from './cache.js';
import type { Db } from './db.js';
import { newSlug } from './slug.js';

export interface Link {
  slug: string;
  url: string;
  createdAt: string;
  clicks: number;
}

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
  clicks: string;
}

const toLink = (row: LinkRow): Link => ({
  slug: row.slug,
  url: row.url,
  createdAt: row.created_at.toISOString(),
  clicks: Number(row.clicks),
});

const cacheKey = (slug: string) => `link:${slug}`;

/** A slug collision is retried with a new slug this many times. */
const MAX_ATTEMPTS = 5;

export class LinkService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly cacheTtlSeconds: number,
  ) {}

  async create(input: string): Promise<Link> {
    const url = normalizeUrl(input);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = await this.db.query<LinkRow>(
        `INSERT INTO links (slug, url) VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING
         RETURNING slug, url, created_at, clicks`,
        [newSlug(), url],
      );
      if (result.rows[0]) return toLink(result.rows[0]);
    }
    throw new Error('No free slug found');
  }

  async get(slug: string): Promise<Link | null> {
    const result = await this.db.query<LinkRow>(
      'SELECT slug, url, created_at, clicks FROM links WHERE slug = $1',
      [slug],
    );
    return result.rows[0] ? toLink(result.rows[0]) : null;
  }

  /** The URL a slug redirects to: from the cache when it's there, else from the database. */
  async resolve(slug: string): Promise<string | null> {
    const cached = await this.cache.get(cacheKey(slug));
    if (cached !== null) return cached;
    const link = await this.get(slug);
    if (!link) return null;
    await this.cache.set(cacheKey(slug), link.url, this.cacheTtlSeconds);
    return link.url;
  }
}
