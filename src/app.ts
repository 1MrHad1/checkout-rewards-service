import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from './domain/errors.js';
import * as carts from './services/cart.service.js';
import * as checkoutService from './services/checkout.service.js';
import * as coupons from './services/coupon.service.js';
import { buildReport } from './services/report.service.js';

const uuid = z.string().uuid('must be a UUID');
const productId = z.string().min(1).max(64);
const quantity = z
  .number({ invalid_type_error: 'quantity must be a number' })
  .int('quantity must be a whole number')
  .positive('quantity must be greater than zero')
  .max(10_000, 'quantity is implausibly large');

const cartParams = z.object({ cartId: uuid });
const cartItemParams = z.object({ cartId: uuid, productId });

/**
 * Parses with zod and rethrows as the service-wide error type, so validation
 * failures reach the client in the same envelope as every other error.
 */
function parse<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new AppError('VALIDATION_FAILED', `Invalid ${where}`, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || where,
      message: issue.message,
    })),
  });
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send(error.toResponse());
    }

    // Fastify's own 400s (malformed JSON, etc.) keep their status but adopt
    // our envelope so clients only ever parse one error shape.
    const { statusCode, message } = (error ?? {}) as { statusCode?: number; message?: string };
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: 'VALIDATION_FAILED', message: message ?? 'Invalid request' },
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // ---- Catalogue -----------------------------------------------------------

  app.get('/products', async () => ({ products: await carts.listProducts() }));

  // ---- Carts ---------------------------------------------------------------

  app.post('/carts', async (_request, reply) => {
    const cart = await carts.createCart();
    return reply.status(201).send({ cart });
  });

  app.get('/carts/:cartId', async (request) => {
    const { cartId } = parse(cartParams, request.params, 'path');
    return { cart: await carts.getCart(cartId) };
  });

  app.post('/carts/:cartId/items', async (request, reply) => {
    const { cartId } = parse(cartParams, request.params, 'path');
    const body = parse(z.object({ productId, quantity }), request.body, 'request body');
    const cart = await carts.addItem(cartId, body.productId, body.quantity);
    return reply.status(201).send({ cart });
  });

  app.patch('/carts/:cartId/items/:productId', async (request) => {
    const params = parse(cartItemParams, request.params, 'path');
    const body = parse(z.object({ quantity }), request.body, 'request body');
    return { cart: await carts.updateItemQuantity(params.cartId, params.productId, body.quantity) };
  });

  app.delete('/carts/:cartId/items/:productId', async (request) => {
    const params = parse(cartItemParams, request.params, 'path');
    return { cart: await carts.removeItem(params.cartId, params.productId) };
  });

  // ---- Checkout and orders -------------------------------------------------

  app.post('/carts/:cartId/checkout', async (request, reply) => {
    const { cartId } = parse(cartParams, request.params, 'path');
    const body = parse(
      z.object({ couponCode: z.string().min(1).max(64).optional() }),
      request.body ?? {},
      'request body',
    );

    const header = request.headers['idempotency-key'];
    const idempotencyKey = parse(
      z.string().min(8, 'Idempotency-Key must be at least 8 characters').max(128).optional(),
      Array.isArray(header) ? header[0] : header,
      'Idempotency-Key header',
    );

    const result = await checkoutService.checkout({
      cartId,
      couponCode: body.couponCode,
      idempotencyKey,
    });

    // 201 when this request created the order, 200 when it replayed an existing
    // one. A retrying client can tell the difference without extra state.
    return reply.status(result.created ? 201 : 200).send({
      order: result.order,
      created: result.created,
    });
  });

  app.get('/orders/:orderId', async (request) => {
    const { orderId } = parse(z.object({ orderId: uuid }), request.params, 'path');
    return { order: await checkoutService.getOrder(orderId) };
  });

  // ---- Administrative ------------------------------------------------------
  // No authentication is implemented, as permitted by the brief. These routes
  // are namespaced under /admin to mark exactly which operations would sit
  // behind an administrator role.

  app.post('/admin/coupons', async (_request, reply) => {
    const coupon = await coupons.generateCoupon();
    return reply.status(201).send({ coupon });
  });

  app.get('/admin/coupons', async () => ({ coupons: await coupons.listCoupons() }));

  app.get('/admin/report', async () => ({ report: await buildReport() }));

  return app;
}
