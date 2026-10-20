import pg from 'pg';
import { config } from '../config.js';

/**
 * Postgres is the concurrency control. The invariants this service has to hold
 * (don't oversell, don't check a cart out twice, don't redeem a coupon twice)
 * are enforced with row locks and unique constraints inside a transaction,
 * not with in-process mutexes, so they survive running several instances.
 */

// BIGINT arrives from pg as a string by default, to avoid silent precision loss
// above 2^53. Every BIGINT in this schema is a money amount bounded well below
// that, so parsing to Number is safe and keeps the arithmetic in one type.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 10_000,
  // Checkout holds row locks; a stuck transaction should surface as an error
  // rather than block the pool indefinitely.
  statement_timeout: 10_000,
});

export type Client = pg.PoolClient;

/**
 * Runs `fn` inside a single transaction and rolls back on any throw.
 *
 * Every write path in this service goes through here. Taking the client as an
 * explicit argument (rather than reaching for an ambient one) makes it visible
 * at each call site which statements share a transaction, which is the thing
 * that actually determines whether an invariant holds under concurrency.
 */
export async function withTransaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      // The connection is already broken; the pool will discard it. Surface the
      // original error rather than masking it with the rollback failure.
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/** Postgres error codes we branch on. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code !== PG_UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  const name = (error as { constraint?: string }).constraint;
  return name === constraint;
}
