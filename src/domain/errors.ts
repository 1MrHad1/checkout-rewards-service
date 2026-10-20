/**
 * Error model.
 *
 * Every failure an API client can provoke is one of these codes. A client can
 * branch on `error.code` without parsing prose, and `details` carries the
 * machine-readable specifics (which product ran out, how much was left).
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'CART_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'ITEM_NOT_IN_CART'
  | 'CART_EMPTY'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'INSUFFICIENT_INVENTORY'
  | 'COUPON_NOT_FOUND'
  | 'COUPON_ALREADY_REDEEMED'
  | 'MILESTONE_NOT_REACHED'
  | 'MILESTONE_ALREADY_REWARDED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PAYMENT_FAILED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  CART_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  ITEM_NOT_IN_CART: 404,
  CART_EMPTY: 422,
  // 409: the request was well-formed but conflicts with current state, and
  // repeating it unchanged will not succeed.
  CART_ALREADY_CHECKED_OUT: 409,
  INSUFFICIENT_INVENTORY: 409,
  COUPON_ALREADY_REDEEMED: 409,
  MILESTONE_ALREADY_REWARDED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  CONFLICT: 409,
  COUPON_NOT_FOUND: 422,
  MILESTONE_NOT_REACHED: 422,
  // 402: the cart was valid; the payment step is what failed. A client should
  // offer a different instrument rather than change the cart.
  PAYMENT_FAILED: 402,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const notFound = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, details);
