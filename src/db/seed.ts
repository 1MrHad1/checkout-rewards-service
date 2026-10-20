import { fileURLToPath } from 'node:url';
import { pool, closePool, type Client } from './pool.js';

/**
 * Seed catalogue. Prices are in paise.
 *
 * `headphones-studio` deliberately carries a single unit so the oversell and
 * concurrent-checkout behaviour can be exercised without editing the data
 * first, and `cable-usbc` is out of stock so the empty case is reachable too.
 */
export const SEED_PRODUCTS = [
  { id: 'tee-classic', name: 'Classic Cotton T-Shirt', unitPriceMinor: 79_900, inventory: 100 },
  { id: 'mug-enamel', name: 'Enamel Camp Mug', unitPriceMinor: 45_000, inventory: 40 },
  { id: 'notebook-a5', name: 'A5 Dotted Notebook', unitPriceMinor: 29_950, inventory: 25 },
  { id: 'bottle-steel', name: 'Insulated Steel Bottle', unitPriceMinor: 1_49_900, inventory: 12 },
  { id: 'headphones-studio', name: 'Studio Headphones', unitPriceMinor: 8_99_900, inventory: 1 },
  { id: 'cable-usbc', name: 'Braided USB-C Cable', unitPriceMinor: 39_900, inventory: 0 },
] as const;

export async function seed(client: Pick<Client, 'query'> = pool): Promise<void> {
  for (const product of SEED_PRODUCTS) {
    await client.query(
      `INSERT INTO products (id, name, unit_price_minor, inventory)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             unit_price_minor = EXCLUDED.unit_price_minor,
             inventory = EXCLUDED.inventory`,
      [product.id, product.name, product.unitPriceMinor, product.inventory],
    );
  }
}

/** Clears transactional data and restores the catalogue. Used by the test suite. */
export async function resetDatabase(): Promise<void> {
  await pool.query(`
    TRUNCATE idempotency_keys, order_items, coupons, orders, cart_items, carts
    RESTART IDENTITY CASCADE
  `);
  await seed();
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  seed()
    .then(() => {
      console.log(`seeded ${SEED_PRODUCTS.length} products`);
      return closePool();
    })
    .catch((error) => {
      console.error('seed failed:', error);
      process.exitCode = 1;
      return closePool();
    });
}
