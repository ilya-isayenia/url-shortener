import type { Cache } from './cache.js';
import type { Db } from './db.js';
import { newSlug, toAlias } from './slug.js';

export interface Link {
  slug: string;
  url: string;
  createdAt: string;
}

/** The URL can't be shortened: the API answers 400 with the message. */
export class InvalidUrlError extends Error {}

/** The alias isn't 1 to 32 ASCII letters and digits, or is a reserved name: the API answers 400. */
export class InvalidAliasError extends Error {}

/** The alias is already someone's slug, ignoring case: the API answers 409. */
export class AliasTakenError extends Error {}

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
}

const toLink = (row: LinkRow): Link => ({
  slug: row.slug,
  url: row.url,
  createdAt: row.created_at.toISOString(),
});

const cacheKey = (slug: string) => `link:${slug}`;

/** A slug collision is retried with a new slug this many times. */
const MAX_ATTEMPTS = 5;

export class LinkService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly cacheTtlSeconds: number,
    private readonly slugs: () => string = newSlug,
  ) {}

  async create(input: string, alias?: string): Promise<Link> {
    const url = normalizeUrl(input);

    if (alias !== undefined) {
      const slug = toAlias(alias);
      if (slug === null) {
        throw new InvalidAliasError('An alias is 1 to 32 letters and digits and not a reserved name');
      }
      const result = await this.db.query<LinkRow>(
        `INSERT INTO links (slug, url, is_alias)
         SELECT $1, $2, true
         WHERE NOT EXISTS (SELECT 1 FROM links WHERE lower(slug) = $1)
         ON CONFLICT (slug) DO NOTHING
         RETURNING slug, url, created_at`,
        [slug, url],
      );
      if (!result.rows[0]) throw new AliasTakenError('This alias is taken');
      return toLink(result.rows[0]);
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = await this.db.query<LinkRow>(
        `INSERT INTO links (slug, url)
         SELECT $1, $2
         WHERE NOT EXISTS (SELECT 1 FROM links WHERE is_alias AND slug = lower($1))
         ON CONFLICT (slug) DO NOTHING
         RETURNING slug, url, created_at`,
        [this.slugs(), url],
      );
      if (result.rows[0]) return toLink(result.rows[0]);
    }
    throw new Error('No free slug found');
  }

  async get(slug: string): Promise<Link | null> {
    const result = await this.db.query<LinkRow>(
      'SELECT slug, url, created_at FROM links WHERE slug = $1 OR (is_alias AND slug = lower($1))',
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
