import { Redis } from 'ioredis';

/** Redis keeps recently resolved links, so a redirect usually skips the database. */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

/** `prefix` keeps keys apart when several apps or test runs share one Redis. */
export function createCache(url: string, prefix = ''): Cache {
  const redis = new Redis(url, { keyPrefix: prefix });
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
    async close() {
      await redis.quit();
    },
  };
}
