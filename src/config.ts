/**
 * Runtime configuration. Every value has a working default so the service can
 * be started and evaluated without a .env file.
 */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',

  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/checkout_dev',

  rewards: {
    /** A coupon becomes available after every `orderInterval`-th placed order. */
    orderInterval: Number(process.env.REWARD_ORDER_INTERVAL ?? 5),
    /** Percentage taken off the order subtotal. */
    percentOff: Number(process.env.REWARD_PERCENT_OFF ?? 10),
  },

  /** ISO 4217 code used for display only; all arithmetic is in minor units. */
  currency: process.env.CURRENCY ?? 'INR',
} as const;

if (!Number.isInteger(config.rewards.orderInterval) || config.rewards.orderInterval < 1) {
  throw new Error('REWARD_ORDER_INTERVAL must be a positive integer');
}

if (
  !Number.isInteger(config.rewards.percentOff) ||
  config.rewards.percentOff < 1 ||
  config.rewards.percentOff > 100
) {
  throw new Error('REWARD_PERCENT_OFF must be an integer between 1 and 100');
}
