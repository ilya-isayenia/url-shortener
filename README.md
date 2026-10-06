# url-shortener

A small URL shortener: an HTTP API on [Fastify](https://fastify.dev), links stored in
PostgreSQL, recently resolved links cached in Redis.

## API

| Method | Path | What it does |
|---|---|---|
| `POST` | `/links` | Shortens `{ "url": "https://…", "alias": "docs" }` (`alias` optional): `201` with `{ slug, url, createdAt, shortUrl }`; `400` for anything but an absolute http(s) URL, or for a malformed or reserved `alias`; `409` if `alias` is already taken. |
| `GET` | `/:slug` | `302` to the link's URL; `404` for an unknown slug. |
| `GET` | `/links/:slug` | The link: `{ slug, url, createdAt, shortUrl }`; `404` for an unknown slug. |
| `GET` | `/health` | `{ "status": "ok" }`. |

A slug is 7 random letters and digits, case-sensitive; every `POST` without an `alias` makes a new
one, even for a URL shortened before. An `alias` becomes the slug instead: 1 to 32 ASCII letters
and digits, case-insensitive — stored and returned in lowercase, and `GET /<alias>` and
`GET /links/<alias>` resolve it in any case. `health` and `links` are reserved and refused with
`400`. An `alias` equal, ignoring case, to any existing slug (alias or random) is `409`.

## How it works

- `src/app.ts` — routes and validation; `buildApp` takes its dependencies, so tests build it
  against their own database and cache.
- `src/links.ts` — the link service: URL validation, slug collisions (retried), resolving.
- `src/db.ts` — the PostgreSQL pool and the schema, created on start (`migrate`).
- `src/cache.ts` — the Redis cache. A redirect reads the cache first and falls back to the
  database; a link stays cached for `CACHE_TTL_SECONDS`.
- `src/slug.ts` — slug generation and the slug format.
- `src/config.ts`, `src/server.ts` — settings from the environment, start and shutdown.

## Running

```sh
docker compose up -d          # PostgreSQL on 5433, Redis on 6380
npm ci
export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/app
export REDIS_URL=redis://localhost:6380
npm run dev                   # http://localhost:3000
```

Settings:

- `DATABASE_URL`, `REDIS_URL` — required;
- `PORT` — default 3000;
- `BASE_URL` — what short links start with, default `http://localhost:$PORT`;
- `CACHE_TTL_SECONDS` — how long a resolved link stays cached, default 3600.

## Tests

```sh
npm test            # vitest: unit tests and the API against PostgreSQL and Redis
npm run typecheck   # tsc
```

The API tests need `DATABASE_URL` and `REDIS_URL`. Each run creates a database of its own
(`url_shortener_test_<id>`) and a key prefix of its own in Redis, and drops the database at the
end. CI (`.github/workflows/ci.yml`) runs both commands with PostgreSQL 17 and Redis 7.

## Conventions

- TypeScript, ES modules, `strict`; 2 spaces, single quotes, semicolons.
- A route's behavior is covered by an API test in `test/api.test.ts` (`app.inject`); pure logic
  by a unit test in `test/unit.test.ts`.
- Commits: one change each, the message in English in the imperative mood ("Add link expiry").
