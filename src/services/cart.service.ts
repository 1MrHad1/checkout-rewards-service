import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool, withTransaction, type Client } from '../db/pool.js';
import { AppError } from '../domain/errors.js';
import { formatMinor, lineTotal, sumMinor } from '../domain/money.js';

export interface CartItemView {
  productId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  /** Inventory on hand right now. Advisory: stock is only committed at checkout. */
  availableInventory: number;
  /** True when `quantity` currently exceeds `availableInventory`. */
  insufficientInventory: boolean;
}

export interface CartView {
  id: string;
  status: 'open' | 'checked_out';
  orderId: string | null;
  items: CartItemView[];
  subtotalMinor: number;
  subtotalFormatted: string;
  currency: string;
  /** True when any line currently exceeds stock, so a client can warn before checkout. */
  hasInventoryIssues: boolean;
}

export async function createCart(): Promise<CartView> {
  const id = randomUUID();
  await pool.query('INSERT INTO carts (id) VALUES ($1)', [id]);
  return getCart(id);
}

/**
 * Loads a cart with current prices and stock.
 *
 * Prices are resolved at read time rather than frozen when the item was added:
 * the cart reflects the live catalogue, and the price is only fixed when the
 * order is created. See the "price changes before checkout" decision.
 */
export async function getCart(cartId: string, client: Pick<Client, 'query'> = pool): Promise<CartView> {
  const cart = await client.query<{ id: string; status: 'open' | 'checked_out'; order_id: string | null }>(
    'SELECT id, status, order_id FROM carts WHERE id = $1',
    [cartId],
  );

  const row = cart.rows[0];
  if (!row) {
    throw new AppError('CART_NOT_FOUND', `No cart with id ${cartId}`, { cartId });
  }

  const items = await client.query<{
    product_id: string;
    name: string;
    quantity: number;
    unit_price_minor: number;
    inventory: number;
  }>(
    `SELECT ci.product_id, p.name, ci.quantity, p.unit_price_minor, p.inventory
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY p.name`,
    [cartId],
  );

  const view: CartItemView[] = items.rows.map((item) => ({
    productId: item.product_id,
    name: item.name,
    quantity: item.quantity,
    unitPriceMinor: item.unit_price_minor,
    lineTotalMinor: lineTotal(item.unit_price_minor, item.quantity),
    availableInventory: item.inventory,
    insufficientInventory: item.quantity > item.inventory,
  }));

  const subtotalMinor = sumMinor(view.map((item) => item.lineTotalMinor));

  return {
    id: row.id,
    status: row.status,
    orderId: row.order_id,
    items: view,
    subtotalMinor,
    subtotalFormatted: formatMinor(subtotalMinor, config.currency),
    currency: config.currency,
    hasInventoryIssues: view.some((item) => item.insufficientInventory),
  };
}

/** Loads a cart for mutation, rejecting carts that have already been checked out. */
async function requireOpenCart(client: Client, cartId: string): Promise<void> {
  const result = await client.query<{ status: string; order_id: string | null }>(
    'SELECT status, order_id FROM carts WHERE id = $1 FOR UPDATE',
    [cartId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError('CART_NOT_FOUND', `No cart with id ${cartId}`, { cartId });
  }
  if (row.status !== 'open') {
    throw new AppError('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out', {
      cartId,
      orderId: row.order_id,
    });
  }
}

async function requireProduct(client: Client, productId: string): Promise<void> {
  const result = await client.query('SELECT 1 FROM products WHERE id = $1', [productId]);
  if (result.rowCount === 0) {
    throw new AppError('PRODUCT_NOT_FOUND', `No product with id ${productId}`, { productId });
  }
}

/**
 * Adds a quantity of a product, accumulating if the line already exists.
 *
 * Stock is checked here so an obviously impossible cart is rejected early, but
 * it is *not* reserved: the authoritative check happens under a row lock at
 * checkout. Adding to a cart is not a claim on inventory.
 */
export async function addItem(cartId: string, productId: string, quantity: number): Promise<CartView> {
  return withTransaction(async (client) => {
    await requireOpenCart(client, cartId);
    await requireProduct(client, productId);

    const result = await client.query<{ quantity: number }>(
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id)
         DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
       RETURNING quantity`,
      [cartId, productId, quantity],
    );

    await assertWithinInventory(client, productId, result.rows[0]!.quantity);
    await touchCart(client, cartId);
    return getCart(cartId, client);
  });
}

/** Replaces the quantity of an existing line. */
export async function updateItemQuantity(
  cartId: string,
  productId: string,
  quantity: number,
): Promise<CartView> {
  return withTransaction(async (client) => {
    await requireOpenCart(client, cartId);

    const result = await client.query(
      'UPDATE cart_items SET quantity = $3 WHERE cart_id = $1 AND product_id = $2',
      [cartId, productId, quantity],
    );

    if (result.rowCount === 0) {
      throw new AppError('ITEM_NOT_IN_CART', `Product ${productId} is not in this cart`, {
        cartId,
        productId,
      });
    }

    await assertWithinInventory(client, productId, quantity);
    await touchCart(client, cartId);
    return getCart(cartId, client);
  });
}

export async function removeItem(cartId: string, productId: string): Promise<CartView> {
  return withTransaction(async (client) => {
    await requireOpenCart(client, cartId);

    const result = await client.query('DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2', [
      cartId,
      productId,
    ]);

    if (result.rowCount === 0) {
      throw new AppError('ITEM_NOT_IN_CART', `Product ${productId} is not in this cart`, {
        cartId,
        productId,
      });
    }

    await touchCart(client, cartId);
    return getCart(cartId, client);
  });
}

async function assertWithinInventory(client: Client, productId: string, quantity: number): Promise<void> {
  const result = await client.query<{ inventory: number; name: string }>(
    'SELECT inventory, name FROM products WHERE id = $1',
    [productId],
  );

  const product = result.rows[0]!;
  if (quantity > product.inventory) {
    throw new AppError(
      'INSUFFICIENT_INVENTORY',
      `Only ${product.inventory} unit(s) of ${product.name} are available`,
      { productId, requested: quantity, available: product.inventory },
    );
  }
}

const touchCart = (client: Client, cartId: string) =>
  client.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);

export async function listProducts() {
  const result = await pool.query<{
    id: string;
    name: string;
    unit_price_minor: number;
    inventory: number;
  }>('SELECT id, name, unit_price_minor, inventory FROM products ORDER BY name');

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    unitPriceMinor: row.unit_price_minor,
    priceFormatted: formatMinor(row.unit_price_minor, config.currency),
    inventory: row.inventory,
  }));
}
