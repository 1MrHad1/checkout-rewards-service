import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

/** Applies schema.sql. Every statement is idempotent, so this is safe to re-run. */
export async function migrate(): Promise<void> {
  const sql = await readFile(schemaPath, 'utf8');
  await pool.query(sql);
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  migrate()
    .then(() => {
      console.log('migrations applied');
      return closePool();
    })
    .catch((error) => {
      console.error('migration failed:', error);
      process.exitCode = 1;
      return closePool();
    });
}
