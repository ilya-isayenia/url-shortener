/** Settings come from the environment; DATABASE_URL and REDIS_URL are required. */
export interface Config {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** Short links are built on it: `${baseUrl}/${slug}`. */
  baseUrl: string;
  /** How long a resolved link stays in the cache. */
  cacheTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS ?? 3600),
  };
}
