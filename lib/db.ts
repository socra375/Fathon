import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";
import { SCHEMA_SQL } from "./generated/assets";

declare global {
  // eslint-disable-next-line no-var
  var __minutaPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __minutaSchema: Promise<void> | undefined;
}

function needsSsl(url: string): boolean {
  if (/sslmode=disable/.test(url)) return false;
  return !/(localhost|127\.0\.0\.1)/.test(url);
}

export function pool(): Pool {
  if (!globalThis.__minutaPool) {
    const url = env.databaseUrl();
    if (!url) throw new Error("DATABASE_URL no está configurada");
    globalThis.__minutaPool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 10_000,
      ssl: needsSsl(url) ? { rejectUnauthorized: true } : undefined,
    });
  }
  return globalThis.__minutaPool;
}

/** Crea las tablas la primera vez (idempotente). */
export function ensureSchema(): Promise<void> {
  if (!globalThis.__minutaSchema) {
    globalThis.__minutaSchema = (async () => {
      await pool().query(SCHEMA_SQL);
    })().catch((err) => {
      globalThis.__minutaSchema = undefined;
      throw err;
    });
  }
  return globalThis.__minutaSchema;
}

export async function q<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const res = await pool().query<T>(text, params);
  return res.rows;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
