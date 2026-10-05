import { describe, expect, it } from 'vitest';
import { InvalidUrlError, normalizeUrl } from '../src/links.js';
import { SLUG_LENGTH, isSlug, newSlug } from '../src/slug.js';

describe('newSlug', () => {
  it('makes slugs of letters and digits, of the default length', () => {
    const slug = newSlug();
    expect(slug).toHaveLength(SLUG_LENGTH);
    expect(isSlug(slug)).toBe(true);
  });

  it('does not repeat itself', () => {
    const slugs = new Set(Array.from({ length: 1000 }, () => newSlug()));
    expect(slugs.size).toBe(1000);
  });
});

describe('isSlug', () => {
  it('refuses anything but letters and digits', () => {
    expect(isSlug('abc123')).toBe(true);
    expect(isSlug('')).toBe(false);
    expect(isSlug('a-b')).toBe(false);
    expect(isSlug('a'.repeat(33))).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('accepts http and https and normalizes them', () => {
    expect(normalizeUrl(' https://Example.com ')).toBe('https://example.com/');
    expect(normalizeUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
  });

  it('refuses other schemes and non-URLs', () => {
    expect(() => normalizeUrl('ftp://example.com')).toThrow(InvalidUrlError);
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(InvalidUrlError);
    expect(() => normalizeUrl('example.com')).toThrow(InvalidUrlError);
  });
});
