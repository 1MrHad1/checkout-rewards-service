import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  getApp,
  reset,
  teardown,
  createCart,
  addItem,
  checkout,
  generateCoupon,
  inventoryOf,
  countOrders,
  placeOrder,
} from './helpers.js';
import { pool } from '../src/db/pool.js';

/**
 * The tests that matter. Each one puts requests in flight at the same moment
 * and asserts that exactly one of them wins, because a sequential happy path
 * would pass against an implementation with no locking at all.
 */

beforeEach(reset);
afterAll(teardown);

describe('concurrent checkout', () => {
  it('does not oversell the last unit when many carts check out at once', async () => {
    // 'headphones-studio' is seeded with inventory 1.
    const carts = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const cartId = await createCart();
        await addItem(cartId, 'headphones-studio', 1);
        return cartId;
      }),
    );

    const responses = await Promise.all(carts.map((cartId) => checkout(cartId)));
    const statuses = responses.map((response) => response.statusCode);

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(7);

    const rejected = responses.filter((response) => response.statusCode === 409);
    for (const response of rejected) {
      expect(response.json().error.code).toBe('INSUFFICIENT_INVENTORY');
    }

    expect(await inventoryOf('headphones-studio')).toBe(0);
    expect(await countOrders()).toBe(1);
  });

  it('never drives inventory negative when demand exceeds stock', async () => {
    // 12 bottles in stock, 10 carts wanting 3 each: at most 4 can succeed.
    const carts = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const cartId = await createCart();
        await addItem(cartId, 'bottle-steel', 3);
        return cartId;
      }),
    );

    const responses = await Promise.all(carts.map((cartId) => checkout(cartId)));
    const succeeded = responses.filter((response) => response.statusCode === 201).length;

    expect(succeeded).toBe(4);
    expect(await inventoryOf('bottle-steel')).toBe(0);
    expect(await countOrders()).toBe(succeeded);
  });

  it('serialises two checkouts of the same cart into a single order', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'tee-classic', 2);

    const [first, second] = await Promise.all([checkout(cartId), checkout(cartId)]);

    const statuses = [first!.statusCode, second!.statusCode].sort();
    // One creates the order (201); the other finds the cart already closed and
    // replays the same order (200).
    expect(statuses).toEqual([200, 201]);

    const orderIds = [first!.json().order.id, second!.json().order.id];
    expect(orderIds[0]).toBe(orderIds[1]);

    expect(await countOrders()).toBe(1);
    expect(await inventoryOf('tee-classic')).toBe(98);
  });
});

describe('concurrent coupon redemption', () => {
  it('lets only one of two simultaneous checkouts redeem the same coupon', async () => {
    for (let i = 0; i < 5; i += 1) await placeOrder('tee-classic', 1);

    const couponCode = (await generateCoupon()).json().coupon.code as string;

    const [cartA, cartB] = await Promise.all([createCart(), createCart()]);
    await Promise.all([addItem(cartA!, 'mug-enamel', 1), addItem(cartB!, 'mug-enamel', 1)]);

    const responses = await Promise.all([
      checkout(cartA!, { couponCode }),
      checkout(cartB!, { couponCode }),
    ]);

    const created = responses.filter((response) => response.statusCode === 201);
    const refused = responses.filter((response) => response.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.json().error.code).toBe('COUPON_ALREADY_REDEEMED');

    // The winning order carries the discount; the coupon points back at it.
    expect(created[0]!.json().order.discountMinor).toBe(4_500); // 10% of 45000
    const coupon = await pool.query<{ status: string; order_id: string }>(
      'SELECT status, order_id FROM coupons WHERE code = $1',
      [couponCode],
    );
    expect(coupon.rows[0]!.status).toBe('redeemed');
    expect(coupon.rows[0]!.order_id).toBe(created[0]!.json().order.id);
  });

  it('awards a milestone coupon only once when admins request it simultaneously', async () => {
    for (let i = 0; i < 5; i += 1) await placeOrder('tee-classic', 1);

    const responses = await Promise.all(Array.from({ length: 4 }, () => generateCoupon()));
    const created = responses.filter((response) => response.statusCode === 201);

    expect(created).toHaveLength(1);
    for (const response of responses.filter((r) => r.statusCode !== 201)) {
      // Either the milestone was taken by the race winner, or the request
      // observed that no unrewarded milestone remains. Both are correct.
      expect(['MILESTONE_ALREADY_REWARDED', 'MILESTONE_NOT_REACHED']).toContain(
        response.json().error.code,
      );
    }

    const coupons = await pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM coupons');
    expect(coupons.rows[0]!.count).toBe(1);
  });
});

describe('retried checkout', () => {
  it('returns the original order for a replayed idempotency key', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'notebook-a5', 2);

    const key = 'retry-key-0001';
    const first = await checkout(cartId, { idempotencyKey: key });
    const second = await checkout(cartId, { idempotencyKey: key });

    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().order.id).toBe(first.json().order.id);

    // Inventory charged once, not twice.
    expect(await inventoryOf('notebook-a5')).toBe(23);
    expect(await countOrders()).toBe(1);
  });

  it('survives a burst of identical retries', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'mug-enamel', 1);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => checkout(cartId, { idempotencyKey: 'burst-key-0001' })),
    );

    const created = responses.filter((response) => response.json().created === true);
    expect(created).toHaveLength(1);

    const orderIds = new Set(
      responses.filter((r) => r.statusCode < 400).map((r) => r.json().order.id as string),
    );
    expect(orderIds.size).toBe(1);
    expect(await countOrders()).toBe(1);
    expect(await inventoryOf('mug-enamel')).toBe(39);
  });

  it('rejects an idempotency key reused for a different cart', async () => {
    const key = 'shared-key-0001';

    const cartA = await createCart();
    await addItem(cartA, 'tee-classic', 1);
    await checkout(cartA, { idempotencyKey: key });

    const cartB = await createCart();
    await addItem(cartB, 'tee-classic', 1);
    const response = await checkout(cartB, { idempotencyKey: key });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await countOrders()).toBe(1);
  });
});

describe('report consistency under load', () => {
  it('reconciles with orders and coupons after concurrent activity', async () => {
    await getApp();

    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const cartId = await createCart();
        await addItem(cartId, 'tee-classic', 1);
        return checkout(cartId);
      }),
    );

    const couponCode = (await generateCoupon()).json().coupon.code as string;
    const discountedCart = await createCart();
    await addItem(discountedCart, 'mug-enamel', 2);
    await checkout(discountedCart, { couponCode });

    const report = await getReportFresh();

    expect(report.totals.ordersPlaced).toBe(11);
    expect(report.totals.netRevenueMinor).toBe(
      report.totals.grossRevenueMinor - report.totals.discountsGrantedMinor,
    );
    expect(report.totals.discountsGrantedMinor).toBe(9_000); // 10% of 90000
    expect(report.coupons.generated).toBe(1);
    expect(report.coupons.redeemed).toBe(1);
    expect(report.coupons.available).toBe(0);

    const tees = report.purchasedByProduct.find((p: { productId: string }) => p.productId === 'tee-classic');
    expect(tees.quantity).toBe(10);
  });

  it('does not mutate state when requested repeatedly', async () => {
    await placeOrder('tee-classic', 1);

    const before = await getReportFresh();
    await Promise.all([getReportFresh(), getReportFresh(), getReportFresh()]);
    const after = await getReportFresh();

    expect(after.totals).toEqual(before.totals);
    expect(after.coupons.generated).toBe(before.coupons.generated);
    expect(await countOrders()).toBe(1);
  });
});

async function getReportFresh() {
  const instance = await getApp();
  const response = await instance.inject({ method: 'GET', url: '/admin/report' });
  return response.json().report;
}
