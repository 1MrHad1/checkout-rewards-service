import { AppError } from '../domain/errors.js';

/**
 * A deliberately small payment seam.
 *
 * No real gateway is integrated. The seam exists for one reason: the
 * requirement that a coupon must not be consumed by a checkout that ultimately
 * fails is only meaningful if a checkout can fail *after* the coupon has been
 * marked redeemed. Without an injectable failure there is no way to test that
 * the rollback actually returns the coupon.
 */
export interface PaymentGateway {
  charge(input: { orderId: string; amountMinor: number; currency: string }): Promise<void>;
}

/** Default gateway: treats every charge as successful. */
export const alwaysSucceeds: PaymentGateway = {
  async charge() {
    /* no-op */
  },
};

/** Test double that rejects, to exercise the failure path. */
export const alwaysFails: PaymentGateway = {
  async charge() {
    throw new AppError('PAYMENT_FAILED', 'The payment was declined by the gateway');
  },
};

let gateway: PaymentGateway = alwaysSucceeds;

export const getPaymentGateway = (): PaymentGateway => gateway;

/** Swaps the gateway. Only tests call this; production keeps the default. */
export const setPaymentGateway = (next: PaymentGateway): void => {
  gateway = next;
};

export const resetPaymentGateway = (): void => {
  gateway = alwaysSucceeds;
};
