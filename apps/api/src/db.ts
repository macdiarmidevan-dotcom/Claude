import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

// Return `date` columns as "yyyy-MM-dd" strings rather than JS Dates in the server's time zone.
pg.types.setTypeParser(1082, (value) => value);

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString });
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
