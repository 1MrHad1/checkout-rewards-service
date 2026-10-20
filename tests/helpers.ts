import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { resetDatabase } from '../src/db/seed.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    await migrate();
    app = buildApp();
    await app.ready();
  }
  return app;
}

/** Truncates transactional data and reseeds, ensuring the schema exists first. */
export async function reset(): Promise<void> {
  await getApp();
  await resetDatabase();
}

export async function teardown(): Promise<void> {
  if (app) await app.close();
  app = null;
  await pool.end();
}

/** Creates a cart and returns its id. */
export async function createCart(): Promise<string> {
  const instance = await getApp();
  const response = await instance.inject({ method: 'POST', url: '/carts' });
  return response.json().cart.id as string;
}

export async function addItem(cartId: string, productId: string, quantity: number) {
  const instance = await getApp();
  return instance.inject({
    method: 'POST',
    url: `/carts/${cartId}/items`,
    payload: { productId, quantity },
  });
}

export async function checkout(
  cartId: string,
  options: { couponCode?: string; idempotencyKey?: string } = {},
) {
  const instance = await getApp();
  return instance.inject({
    method: 'POST',
    url: `/carts/${cartId}/checkout`,
    headers: options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {},
    payload: options.couponCode ? { couponCode: options.couponCode } : {},
  });
}

/** Creates a cart holding one unit of `productId` and checks it out. */
export async function placeOrder(productId = 'tee-classic', quantity = 1) {
  const cartId = await createCart();
  await addItem(cartId, productId, quantity);
  return checkout(cartId);
}

export async function generateCoupon() {
  const instance = await getApp();
  return instance.inject({ method: 'POST', url: '/admin/coupons' });
}

export async function getReport() {
  const instance = await getApp();
  const response = await instance.inject({ method: 'GET', url: '/admin/report' });
  return response.json().report;
}

export async function inventoryOf(productId: string): Promise<number> {
  const result = await pool.query<{ inventory: number }>(
    'SELECT inventory FROM products WHERE id = $1',
    [productId],
  );
  return result.rows[0]!.inventory;
}

export async function countOrders(): Promise<number> {
  const result = await pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM orders');
  return result.rows[0]!.count;
}
