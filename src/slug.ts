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
