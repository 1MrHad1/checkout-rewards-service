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
import { percentageDiscount, lineTotal } from '../src/domain/money.js';
import { nextUnrewardedMilestone } from '../src/services/coupon.service.js';
import { setPaymentGateway, resetPaymentGateway, alwaysFails } from '../src/services/payment.js';

beforeEach(async () => {
  resetPaymentGateway();
  await reset();
});
afterAll(teardown);

describe('money', () => {
  it('rounds a percentage discount half up, in minor units', () => {
    expect(percentageDiscount(10_000, 10)).toBe(1_000);
    // 999 paise * 10% = 99.9 -> 100
    expect(percentageDiscount(999, 10)).toBe(100);
    // 1050 paise * 5% = 52.5 -> 53 (half up, not banker's rounding)
    expect(percentageDiscount(1_050, 5)).toBe(53);
    expect(percentageDiscount(0, 10)).toBe(0);
  });

  it('never lets a discount exceed the subtotal', () => {
    expect(percentageDiscount(5_000, 100)).toBe(5_000);
  });

  it('refuses non-integer amounts rather than silently rounding', () => {
    expect(() => lineTotal(10.5, 2)).toThrow(/integer/);
    expect(() => lineTotal(100, 0)).toThrow(/positive/);
  });

  it('keeps repeated additions exact where floats would drift', () => {
    // 0.1 + 0.2 !== 0.3 in float; in paise it is just 10 + 20 === 30.
    const total = [10, 20, 30].reduce((a, b) => a + b, 0);
    expect(total).toBe(60);
  });
});

describe('milestone arithmetic', () => {
  it('rewards the lowest earned milestone that has no coupon', () => {
    expect(nextUnrewardedMilestone(4, [], 5)).toBeNull();
    expect(nextUnrewardedMilestone(5, [], 5)).toBe(1);
    expect(nextUnrewardedMilestone(9, [1], 5)).toBeNull();
    expect(nextUnrewardedMilestone(10, [1], 5)).toBe(2);
    // A gap is filled before moving on, so no milestone is ever skipped.
    expect(nextUnrewardedMilestone(15, [1, 3], 5)).toBe(2);
  });
});

describe('cart validation', () => {
  it('rejects an unknown product', async () => {
    const cartId = await createCart();
    const response = await addItem(cartId, 'no-such-product', 1);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('rejects a zero or negative quantity', async () => {
    const cartId = await createCart();
    for (const quantity of [0, -3]) {
      const response = await addItem(cartId, 'tee-classic', quantity);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    }
    const cart = await (await getApp()).inject({ method: 'GET', url: `/carts/${cartId}` });
    expect(cart.json().cart.items).toHaveLength(0);
  });

  it('rejects a fractional quantity', async () => {
    const cartId = await createCart();
    const response = await addItem(cartId, 'tee-classic', 1.5);
    expect(response.statusCode).toBe(400);
  });

  it('refuses to add more than the stock on hand', async () => {
    const cartId = await createCart();
    const response = await addItem(cartId, 'headphones-studio', 2);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INSUFFICIENT_INVENTORY');
    expect(response.json().error.details.available).toBe(1);
  });

  it('accumulates quantity when the same product is added twice', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'tee-classic', 2);
    const response = await addItem(cartId, 'tee-classic', 3);
    expect(response.json().cart.items[0].quantity).toBe(5);
  });

  it('reports totals that match the line items', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'tee-classic', 2); // 79900 * 2
    await addItem(cartId, 'mug-enamel', 1); // 45000
    const response = await (await getApp()).inject({ method: 'GET', url: `/carts/${cartId}` });
    expect(response.json().cart.subtotalMinor).toBe(79_900 * 2 + 45_000);
  });

  it('cannot be modified after checkout', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'tee-classic', 1);
    await checkout(cartId);

    const response = await addItem(cartId, 'mug-enamel', 1);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CART_ALREADY_CHECKED_OUT');
  });

  it('404s for an unknown cart and 400s for a malformed id', async () => {
    const app = await getApp();
    const unknown = await app.inject({
      method: 'GET',
      url: '/carts/11111111-1111-4111-8111-111111111111',
    });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({ method: 'GET', url: '/carts/not-a-uuid' });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('price changes before checkout', () => {
  it('charges the price in effect at checkout, and records it on the order', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'tee-classic', 1);

    await pool.query('UPDATE products SET unit_price_minor = 99_900 WHERE id = $1', ['tee-classic']);

    const response = await checkout(cartId);
    expect(response.json().order.subtotalMinor).toBe(99_900);
    expect(response.json().order.items[0].unitPriceMinor).toBe(99_900);
  });

  it('keeps the order readable after the catalogue changes again', async () => {
    const response = await placeOrder('tee-classic', 1);
    const orderId = response.json().order.id;

    await pool.query(
      `UPDATE products SET name = 'Renamed Tee', unit_price_minor = 1 WHERE id = $1`,
      ['tee-classic'],
    );

    const order = await (await getApp()).inject({ method: 'GET', url: `/orders/${orderId}` });
    expect(order.json().order.items[0].productName).toBe('Classic Cotton T-Shirt');
    expect(order.json().order.items[0].unitPriceMinor).toBe(79_900);
  });
});

describe('checkout', () => {
  it('refuses an empty cart', async () => {
    const cartId = await createCart();
    const response = await checkout(cartId);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('CART_EMPTY');
  });

  it('decrements inventory by the quantity ordered', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'notebook-a5', 4);
    await checkout(cartId);
    expect(await inventoryOf('notebook-a5')).toBe(21);
  });

  it('rejects an unknown coupon without placing the order', async () => {
    const cartId = await createCart();
    await addItem(cartId, 'tee-classic', 1);

    const response = await checkout(cartId, { couponCode: 'NOPE-123' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('COUPON_NOT_FOUND');
    expect(await countOrders()).toBe(0);
    expect(await inventoryOf('tee-classic')).toBe(100);
  });
});

describe('a failed payment leaves nothing behind', () => {
  it('returns the coupon, the stock and the cart when the charge is declined', async () => {
    for (let i = 0; i < 5; i += 1) await placeOrder('tee-classic', 1);
    const couponCode = (await generateCoupon()).json().coupon.code as string;

    const stockBefore = await inventoryOf('mug-enamel');
    const ordersBefore = await countOrders();

    const cartId = await createCart();
    await addItem(cartId, 'mug-enamel', 2);

    setPaymentGateway(alwaysFails);
    const response = await checkout(cartId, { couponCode });
    resetPaymentGateway();

    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe('PAYMENT_FAILED');

    // Nothing was consumed: this is the whole point of charging inside the
    // transaction.
    expect(await countOrders()).toBe(ordersBefore);
    expect(await inventoryOf('mug-enamel')).toBe(stockBefore);

    const coupon = await pool.query<{ status: string }>(
      'SELECT status FROM coupons WHERE code = $1',
      [couponCode],
    );
    expect(coupon.rows[0]!.status).toBe('available');

    // And the cart is still usable, so the customer can simply try again.
    const retry = await checkout(cartId, { couponCode });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().order.discountMinor).toBe(9_000);
  });
});

describe('coupons', () => {
  it('is not generated before the milestone is reached', async () => {
    for (let i = 0; i < 4; i += 1) await placeOrder('tee-classic', 1);

    const response = await generateCoupon();
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('MILESTONE_NOT_REACHED');
    expect(response.json().error.details.ordersUntilNextMilestone).toBe(1);
  });

  it('is generated once per milestone, not once per request', async () => {
    for (let i = 0; i < 5; i += 1) await placeOrder('tee-classic', 1);

    expect((await generateCoupon()).statusCode).toBe(201);
    const second = await generateCoupon();
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe('MILESTONE_NOT_REACHED');

    // Five more orders earn the next milestone.
    for (let i = 0; i < 5; i += 1) await placeOrder('tee-classic', 1);
    const third = await generateCoupon();
    expect(third.statusCode).toBe(201);
    expect(third.json().coupon.milestoneIndex).toBe(2);
  });

  it('applies the discount and cannot be used a second time', async () => {
    for (let i = 0; i < 5; i += 1) await placeOrder('tee-classic', 1);
    const couponCode = (await generateCoupon()).json().coupon.code as string;

    const firstCart = await createCart();
    await addItem(firstCart, 'bottle-steel', 1); // 149900
    const first = await checkout(firstCart, { couponCode });
    expect(first.json().order.discountMinor).toBe(14_990);
    expect(first.json().order.totalMinor).toBe(149_900 - 14_990);

    const secondCart = await createCart();
    await addItem(secondCart, 'bottle-steel', 1);
    const second = await checkout(secondCart, { couponCode });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('COUPON_ALREADY_REDEEMED');
  });

  it('counts discounted orders towards the next milestone', async () => {
    for (let i = 0; i < 5; i += 1) await placeOrder('tee-classic', 1);
    const couponCode = (await generateCoupon()).json().coupon.code as string;

    const cartId = await createCart();
    await addItem(cartId, 'tee-classic', 1);
    await checkout(cartId, { couponCode });

    for (let i = 0; i < 4; i += 1) await placeOrder('tee-classic', 1);
    expect((await generateCoupon()).statusCode).toBe(201);
  });
});
