import pg from 'pg';

/** PostgreSQL is the store of record: every link lives here. */
export type Db = pg.Pool;

export function createDb(connectionString: string): Db {
  return new pg.Pool({ connectionString });
}

/** Creates the schema if it isn't there; safe to run on every start. */
export async function migrate(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS links (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      url text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // A link may expire; null — it never does.
  await db.query('ALTER TABLE links ADD COLUMN IF NOT EXISTS expires_at timestamptz');
}
