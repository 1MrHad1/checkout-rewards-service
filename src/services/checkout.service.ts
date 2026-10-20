import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool, withTransaction, isUniqueViolation, type Client } from '../db/pool.js';
import { AppError } from '../domain/errors.js';
import { formatMinor, lineTotal, percentageDiscount, sumMinor } from '../domain/money.js';
import { getPaymentGateway } from './payment.js';

export interface OrderLine {
  productId: string;
  productName: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface OrderView {
  id: string;
  cartId: string;
  items: OrderLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  totalFormatted: string;
  currency: string;
  couponCode: string | null;
  createdAt: string;
}

export interface CheckoutResult {
  order: OrderView;
  /** False when this response replays an order created by an earlier attempt. */
  created: boolean;
}

/**
 * Places an order for a cart.
 *
 * The whole operation is one transaction. Locks are always taken in the same
 * order — cart, then products ascending by id, then coupon — so two concurrent
 * checkouts can queue behind each other but can never form a deadlock cycle.
 *
 * Retry safety has two independent layers:
 *   1. The cart itself. A cart carries its order_id once checked out, so a
 *      retry (with or without an idempotency key) returns the original order
 *      instead of creating a second one.
 *   2. The optional Idempotency-Key header, which additionally catches a replay
 *      that arrives while the first attempt is still in flight, and detects a
 *      key being reused against a different cart.
 */
export async function checkout(input: {
  cartId: string;
  couponCode?: string | undefined;
  idempotencyKey?: string | undefined;
}): Promise<CheckoutResult> {
  const { cartId, couponCode, idempotencyKey } = input;

  return withTransaction(async (client) => {
    // ---- 1. Lock the cart. A concurrent checkout of the same cart waits here.
    const cartResult = await client.query<{ status: string; order_id: string | null }>(
      'SELECT status, order_id FROM carts WHERE id = $1 FOR UPDATE',
      [cartId],
    );

    const cart = cartResult.rows[0];
    if (!cart) {
      throw new AppError('CART_NOT_FOUND', `No cart with id ${cartId}`, { cartId });
    }

    // Already placed: this is a retry. Return the original order, not an error.
    // The client asked for "this cart is paid for", and it is.
    if (cart.status === 'checked_out' && cart.order_id) {
      return { order: await loadOrder(cart.order_id, client), created: false };
    }

    // ---- 2. Claim the idempotency key, if one was supplied.
    if (idempotencyKey) {
      const replay = await claimIdempotencyKey(client, idempotencyKey, cartId);
      if (replay) {
        return { order: await loadOrder(replay, client), created: false };
      }
    }

    // ---- 3. Read the cart lines.
    const itemsResult = await client.query<{ product_id: string; quantity: number }>(
      'SELECT product_id, quantity FROM cart_items WHERE cart_id = $1 ORDER BY product_id',
      [cartId],
    );

    if (itemsResult.rows.length === 0) {
      throw new AppError('CART_EMPTY', 'Cannot check out an empty cart', { cartId });
    }

    const requested = new Map(itemsResult.rows.map((row) => [row.product_id, row.quantity]));
    const productIds = [...requested.keys()].sort();

    // ---- 4. Lock the product rows, ascending by id. This is both the oversell
    // guard and the deadlock-avoidance rule: every checkout locks in the same
    // order, so no two transactions can hold what the other needs.
    const productsResult = await client.query<{
      id: string;
      name: string;
      unit_price_minor: number;
      inventory: number;
    }>(
      `SELECT id, name, unit_price_minor, inventory
         FROM products
        WHERE id = ANY($1::text[])
        ORDER BY id
          FOR UPDATE`,
      [productIds],
    );

    if (productsResult.rows.length !== productIds.length) {
      const found = new Set(productsResult.rows.map((row) => row.id));
      const missing = productIds.filter((id) => !found.has(id));
      throw new AppError('PRODUCT_NOT_FOUND', 'A product in this cart no longer exists', {
        productIds: missing,
      });
    }

    // ---- 5. Verify stock under the lock, and snapshot prices.
    const shortfalls = productsResult.rows
      .filter((product) => requested.get(product.id)! > product.inventory)
      .map((product) => ({
        productId: product.id,
        name: product.name,
        requested: requested.get(product.id)!,
        available: product.inventory,
      }));

    if (shortfalls.length > 0) {
      throw new AppError('INSUFFICIENT_INVENTORY', 'One or more items are no longer available', {
        items: shortfalls,
      });
    }

    const lines: OrderLine[] = productsResult.rows.map((product) => {
      const quantity = requested.get(product.id)!;
      return {
        productId: product.id,
        productName: product.name,
        unitPriceMinor: product.unit_price_minor,
        quantity,
        lineTotalMinor: lineTotal(product.unit_price_minor, quantity),
      };
    });

    const subtotalMinor = sumMinor(lines.map((line) => line.lineTotalMinor));

    // ---- 6. Lock the coupon, if one was supplied. A second checkout presenting
    // the same code blocks here, then finds it redeemed once we commit.
    let discountMinor = 0;
    let lockedCouponCode: string | null = null;

    if (couponCode) {
      const couponResult = await client.query<{ status: string; percent_off: number }>(
        'SELECT status, percent_off FROM coupons WHERE code = $1 FOR UPDATE',
        [couponCode],
      );

      const coupon = couponResult.rows[0];
      if (!coupon) {
        throw new AppError('COUPON_NOT_FOUND', `Coupon ${couponCode} does not exist`, { couponCode });
      }
      if (coupon.status !== 'available') {
        throw new AppError('COUPON_ALREADY_REDEEMED', `Coupon ${couponCode} has already been used`, {
          couponCode,
        });
      }

      discountMinor = percentageDiscount(subtotalMinor, coupon.percent_off);
      lockedCouponCode = couponCode;
    }

    const totalMinor = subtotalMinor - discountMinor;

    // ---- 7. Persist the order and its snapshot lines.
    const orderId = randomUUID();
    await client.query(
      `INSERT INTO orders (id, cart_id, subtotal_minor, discount_minor, total_minor, coupon_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, cartId, subtotalMinor, discountMinor, totalMinor, lockedCouponCode],
    );

    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items
           (order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, line.productId, line.productName, line.unitPriceMinor, line.quantity, line.lineTotalMinor],
      );
    }

    // ---- 8. Commit the inventory. The CHECK (inventory >= 0) is a backstop:
    // if the lock discipline above were ever wrong, this fails loudly instead
    // of quietly overselling.
    for (const line of lines) {
      await client.query('UPDATE products SET inventory = inventory - $2 WHERE id = $1', [
        line.productId,
        line.quantity,
      ]);
    }

    // ---- 9. Consume the coupon, now that there is an order to attribute it to.
    if (lockedCouponCode) {
      await client.query(
        `UPDATE coupons
            SET status = 'redeemed', order_id = $2, redeemed_at = now()
          WHERE code = $1 AND status = 'available'`,
        [lockedCouponCode, orderId],
      );
    }

    // ---- 10. Close the cart and point it at its order.
    await client.query(
      `UPDATE carts SET status = 'checked_out', order_id = $2, updated_at = now() WHERE id = $1`,
      [cartId, orderId],
    );

    if (idempotencyKey) {
      await client.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [
        idempotencyKey,
        orderId,
      ]);
    }

    // ---- 11. Take payment last, still inside the transaction.
    //
    // Deliberate: if the charge fails, the ROLLBACK returns the inventory *and*
    // the coupon, which is exactly the "a coupon must not be consumed by a
    // failed checkout" requirement. The cost is holding row locks across the
    // gateway call, which does not scale to a real gateway — DECISIONS.md
    // describes the reserve/charge/confirm design that replaces it.
    await getPaymentGateway().charge({ orderId, amountMinor: totalMinor, currency: config.currency });

    return { order: await loadOrder(orderId, client), created: true };
  });
}

/**
 * Inserts the key row, or detects a replay.
 *
 * Returns the order id of a previous attempt when this is a replay, or null
 * when this request owns the key and should proceed.
 */
async function claimIdempotencyKey(
  client: Client,
  key: string,
  cartId: string,
): Promise<string | null> {
  // A failed INSERT aborts the enclosing transaction, which would drop the cart
  // lock taken above. The savepoint confines the failure so the lock survives.
  await client.query('SAVEPOINT idempotency_claim');

  try {
    await client.query('INSERT INTO idempotency_keys (key, cart_id) VALUES ($1, $2)', [key, cartId]);
    await client.query('RELEASE SAVEPOINT idempotency_claim');
    return null;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT idempotency_claim');

    const existing = await client.query<{ cart_id: string; order_id: string | null }>(
      'SELECT cart_id, order_id FROM idempotency_keys WHERE key = $1',
      [key],
    );

    const row = existing.rows[0];
    if (!row) {
      throw new AppError('CONFLICT', 'Idempotency key conflict; please retry', { idempotencyKey: key });
    }

    if (row.cart_id !== cartId) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different cart',
        { idempotencyKey: key, originalCartId: row.cart_id },
      );
    }

    if (!row.order_id) {
      // The original attempt holds the key but has not finished. Telling the
      // client to retry is safer than guessing an outcome we cannot see.
      throw new AppError('CONFLICT', 'A checkout for this cart is already in progress', {
        idempotencyKey: key,
      });
    }

    return row.order_id;
  }
}

export async function getOrder(orderId: string): Promise<OrderView> {
  return loadOrder(orderId, pool);
}

async function loadOrder(orderId: string, client: Pick<Client, 'query'>): Promise<OrderView> {
  const orderResult = await client.query<{
    id: string;
    cart_id: string;
    subtotal_minor: number;
    discount_minor: number;
    total_minor: number;
    coupon_code: string | null;
    created_at: Date;
  }>(
    `SELECT id, cart_id, subtotal_minor, discount_minor, total_minor, coupon_code, created_at
       FROM orders WHERE id = $1`,
    [orderId],
  );

  const order = orderResult.rows[0];
  if (!order) {
    throw new AppError('ORDER_NOT_FOUND', `No order with id ${orderId}`, { orderId });
  }

  const itemsResult = await client.query<{
    product_id: string;
    product_name: string;
    unit_price_minor: number;
    quantity: number;
    line_total_minor: number;
  }>(
    `SELECT product_id, product_name, unit_price_minor, quantity, line_total_minor
       FROM order_items WHERE order_id = $1 ORDER BY product_name`,
    [orderId],
  );

  return {
    id: order.id,
    cartId: order.cart_id,
    items: itemsResult.rows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      unitPriceMinor: row.unit_price_minor,
      quantity: row.quantity,
      lineTotalMinor: row.line_total_minor,
    })),
    subtotalMinor: order.subtotal_minor,
    discountMinor: order.discount_minor,
    totalMinor: order.total_minor,
    totalFormatted: formatMinor(order.total_minor, config.currency),
    currency: config.currency,
    couponCode: order.coupon_code,
    createdAt: order.created_at.toISOString(),
  };
}
