import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { formatMinor } from '../domain/money.js';

export interface ReportView {
  generatedAt: string;
  currency: string;
  rewardPolicy: { orderInterval: number; percentOff: number };
  totals: {
    ordersPlaced: number;
    itemsPurchased: number;
    grossRevenueMinor: number;
    discountsGrantedMinor: number;
    netRevenueMinor: number;
    grossRevenueFormatted: string;
    discountsGrantedFormatted: string;
    netRevenueFormatted: string;
  };
  purchasedByProduct: Array<{
    productId: string;
    productName: string;
    quantity: number;
    grossRevenueMinor: number;
  }>;
  coupons: {
    generated: number;
    available: number;
    redeemed: number;
    items: Array<{
      code: string;
      milestoneIndex: number;
      percentOff: number;
      status: string;
      orderId: string | null;
    }>;
  };
}

/**
 * Administrative summary.
 *
 * Read-only by construction: a single read-only transaction at REPEATABLE READ,
 * so every figure below is computed from one consistent snapshot. Without that,
 * an order committing between the revenue query and the coupon query could
 * produce a report whose totals do not reconcile with its own coupon list.
 *
 * Gross revenue is the sum of order subtotals (before discount), net is the sum
 * of order totals, and gross - discounts = net holds by the CHECK constraint on
 * `orders`.
 *
 * The ::bigint casts are load-bearing: SUM() over bigint widens to numeric in
 * Postgres, which node-postgres hands back as a string to avoid precision loss.
 * Without the cast the totals arrive as strings and arithmetic on them silently
 * becomes concatenation.
 */
export async function buildReport(): Promise<ReportView> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');

    const totals = await client.query<{
      orders_placed: number;
      gross: number;
      discounts: number;
      net: number;
    }>(`
      SELECT COUNT(*)::int                      AS orders_placed,
             COALESCE(SUM(subtotal_minor), 0)::bigint AS gross,
             COALESCE(SUM(discount_minor), 0)::bigint AS discounts,
             COALESCE(SUM(total_minor), 0)::bigint      AS net
        FROM orders
    `);

    const byProduct = await client.query<{
      product_id: string;
      product_name: string;
      quantity: number;
      gross: number;
    }>(`
      SELECT product_id,
             -- Products can be renamed between orders; report the most recent
             -- name the customer actually saw.
             (ARRAY_AGG(product_name ORDER BY order_id DESC))[1] AS product_name,
             SUM(quantity)::int                                  AS quantity,
             SUM(line_total_minor)::bigint                       AS gross
        FROM order_items
       GROUP BY product_id
       ORDER BY quantity DESC, product_id
    `);

    const coupons = await client.query<{
      code: string;
      milestone_index: number;
      percent_off: number;
      status: string;
      order_id: string | null;
    }>(`
      SELECT code, milestone_index, percent_off, status, order_id
        FROM coupons
       ORDER BY milestone_index
    `);

    await client.query('COMMIT');

    const row = totals.rows[0]!;
    const itemsPurchased = byProduct.rows.reduce((sum, product) => sum + product.quantity, 0);

    return {
      generatedAt: new Date().toISOString(),
      currency: config.currency,
      rewardPolicy: {
        orderInterval: config.rewards.orderInterval,
        percentOff: config.rewards.percentOff,
      },
      totals: {
        ordersPlaced: row.orders_placed,
        itemsPurchased,
        grossRevenueMinor: row.gross,
        discountsGrantedMinor: row.discounts,
        netRevenueMinor: row.net,
        grossRevenueFormatted: formatMinor(row.gross, config.currency),
        discountsGrantedFormatted: formatMinor(row.discounts, config.currency),
        netRevenueFormatted: formatMinor(row.net, config.currency),
      },
      purchasedByProduct: byProduct.rows.map((product) => ({
        productId: product.product_id,
        productName: product.product_name,
        quantity: product.quantity,
        grossRevenueMinor: product.gross,
      })),
      coupons: {
        generated: coupons.rows.length,
        available: coupons.rows.filter((coupon) => coupon.status === 'available').length,
        redeemed: coupons.rows.filter((coupon) => coupon.status === 'redeemed').length,
        items: coupons.rows.map((coupon) => ({
          code: coupon.code,
          milestoneIndex: coupon.milestone_index,
          percentOff: coupon.percent_off,
          status: coupon.status,
          orderId: coupon.order_id,
        })),
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
