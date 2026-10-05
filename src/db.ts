import pg from 'pg';

/** PostgreSQL is the store of record: every link lives here. */
export type Db = pg.Pool;

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  // Without a listener, pg turns an error on an idle client (e.g. Postgres closing it, as
  // DROP DATABASE ... WITH (FORCE) does in the API tests' teardown) into an uncaught exception.
  pool.on('error', () => {});
  return pool;
}

/** Creates the schema if it isn't there and adds columns that are missing; safe to run on every start. */
export async function migrate(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS links (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      url text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query('ALTER TABLE links ADD COLUMN IF NOT EXISTS clicks bigint NOT NULL DEFAULT 0');
}
