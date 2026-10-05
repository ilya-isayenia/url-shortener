import { buildApp } from './app.js';
import { createCache } from './cache.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { LinkService } from './links.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);
await migrate(db);
const cache = createCache(config.redisUrl);
const links = new LinkService(db, cache, config.cacheTtlSeconds);
const app = buildApp({ links, baseUrl: config.baseUrl, logger: true });

const shutdown = async () => {
  await app.close();
  await cache.close();
  await db.end();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
