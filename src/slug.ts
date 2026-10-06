import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const SLUG_LENGTH = 7;

/** A random slug: 62^7 ≈ 3.5·10^12 values, so collisions are rare and retried. */
export function newSlug(length = SLUG_LENGTH): string {
  let slug = '';
  for (let i = 0; i < length; i++) slug += ALPHABET[randomInt(ALPHABET.length)];
  return slug;
}

/** Whether a path segment can be a slug at all; anything else is a 404 without a lookup. */
export const isSlug = (value: string): boolean => /^[0-9a-zA-Z]{1,32}$/.test(value);

/** Names no alias may take: `health` is the API's own route, `links` its collection path. */
export const RESERVED_ALIASES = ['health', 'links'];

/**
 * An alias in its canonical (lowercase) form, or null if it can't be one. `isSlug` runs on the
 * value as received, before lowercasing: `toLowerCase` maps some non-ASCII characters to ASCII
 * (the Kelvin sign U+212A becomes `k`), so lowercasing first would let `"Key"` through as `key`.
 */
export function toAlias(value: string): string | null {
  if (!isSlug(value)) return null;
  const alias = value.toLowerCase();
  return RESERVED_ALIASES.includes(alias) ? null : alias;
}
