# Checkout and Rewards Service

A backend for an ecommerce store: carts, checkout, inventory, and a coupon
awarded after every *n*th order.

The endpoints are the easy part. What this service is actually about is
behaving correctly when requests are retried, when customers check out at the
same moment, and when two operations compete for the same coupon.
**[DECISIONS.md](./DECISIONS.md)** explains how and why, and is the document I'd
most want read.

- **Stack:** Node.js 20+, TypeScript, Fastify, PostgreSQL 16, Vitest
- **Tests:** 33, of which 9 exercise concurrent or repeated requests

---

## Running it

Requires Docker (for Postgres) and Node 20+.

```bash
docker compose up -d        # Postgres on :5432, creates both databases
npm install
npm run setup               # apply schema, seed the catalogue
npm start                   # http://localhost:3000
```

### Running the tests

```bash
npm test
```

The suite needs the same Postgres container running and uses the separate
`checkout_test` database, which `docker compose` creates on first boot.

### Using an existing Postgres instead of Docker

```bash
createdb checkout_dev && createdb checkout_test
export DATABASE_URL="postgres://<user>@localhost:5432/checkout_dev"
npm run setup && npm start

# and for the tests
export TEST_DATABASE_URL="postgres://<user>@localhost:5432/checkout_test"
npm test
```

### Configuration

Every value has a working default; `.env` is optional. See `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/checkout_dev` | Connection string |
| `PORT` | `3000` | HTTP port |
| `REWARD_ORDER_INTERVAL` | `5` | A coupon is earned every *n*th order |
| `REWARD_PERCENT_OFF` | `10` | Discount percentage |
| `CURRENCY` | `INR` | Display only; all arithmetic is in minor units |

### Seed catalogue

Prices are in paise. `headphones-studio` has **one unit** so the oversell path
can be exercised without editing data, and `cable-usbc` is out of stock.

| id | name | price | inventory |
|---|---|---|---|
| `tee-classic` | Classic Cotton T-Shirt | ₹799.00 | 100 |
| `mug-enamel` | Enamel Camp Mug | ₹450.00 | 40 |
| `notebook-a5` | A5 Dotted Notebook | ₹299.50 | 25 |
| `bottle-steel` | Insulated Steel Bottle | ₹1499.00 | 12 |
| `headphones-studio` | Studio Headphones | ₹8999.00 | **1** |
| `cable-usbc` | Braided USB-C Cable | ₹399.00 | **0** |

---

## Money

Every amount in every request and response is an **integer number of minor units
(paise)**. `799.00` is sent and stored as `79900`. No value is ever a float.
Fields ending in `Minor` are amounts; `*Formatted` fields are for display only.

---

## API

Base URL `http://localhost:3000`. All bodies are JSON.

Errors always have the same shape, so a client parses one envelope:

```json
{
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "One or more items are no longer available",
    "details": { "items": [{ "productId": "headphones-studio", "requested": 1, "available": 0 }] }
  }
}
```

Branch on `code`, not on the message. The full set is in
[`src/domain/errors.ts`](./src/domain/errors.ts).

### Catalogue

#### `GET /products`
Lists products with current price and inventory. → `200`

### Carts

#### `POST /carts`
Creates an empty cart. → `201` `{ cart }`

#### `GET /carts/:cartId`
Returns the cart with live prices, totals, and an `insufficientInventory` flag
per line. → `200` · `404 CART_NOT_FOUND` · `400 VALIDATION_FAILED` (malformed id)

#### `POST /carts/:cartId/items`
```json
{ "productId": "tee-classic", "quantity": 2 }
```
Adds a product, accumulating if the line already exists. → `201` `{ cart }`

- `400 VALIDATION_FAILED` — quantity not a positive whole number
- `404 PRODUCT_NOT_FOUND` — unknown product
- `409 INSUFFICIENT_INVENTORY` — more than the stock on hand
- `409 CART_ALREADY_CHECKED_OUT`

#### `PATCH /carts/:cartId/items/:productId`
```json
{ "quantity": 5 }
```
Replaces the quantity. → `200` · `404 ITEM_NOT_IN_CART` · `409 INSUFFICIENT_INVENTORY`

#### `DELETE /carts/:cartId/items/:productId`
→ `200` `{ cart }` · `404 ITEM_NOT_IN_CART`

### Checkout

#### `POST /carts/:cartId/checkout`

```
Idempotency-Key: <optional, 8–128 chars>
```
```json
{ "couponCode": "SAVE10-M1-A1B2C3D4" }
```
Body may be omitted entirely. Returns `{ order, created }`.

- **`201`** — this request created the order (`created: true`)
- **`200`** — this request replayed an existing one (`created: false`)
- `422 CART_EMPTY`
- `409 INSUFFICIENT_INVENTORY` — stock went in the meantime
- `422 COUPON_NOT_FOUND` · `409 COUPON_ALREADY_REDEEMED`
- `409 IDEMPOTENCY_KEY_REUSED` — same key, different cart
- `409 CONFLICT` — an attempt with this key is still in flight
- `402 PAYMENT_FAILED` — nothing is consumed; retry the same cart

A retry is always safe. Even without an idempotency key, a second checkout of
the same cart returns the original order rather than creating another.

#### `GET /orders/:orderId`
Returns the order with line items as they were priced at checkout, unaffected by
later catalogue changes. → `200` · `404 ORDER_NOT_FOUND`

### Administrative

No authentication is implemented, as the brief permits. These routes are
namespaced to mark exactly which operations are administrative.

#### `POST /admin/coupons`
Mints a coupon for the next unrewarded milestone. → `201` `{ coupon }`

- `422 MILESTONE_NOT_REACHED` — `details.ordersUntilNextMilestone` says how many more orders are needed
- `409 MILESTONE_ALREADY_REWARDED` — a concurrent request won the race

#### `GET /admin/coupons`
→ `200` `{ coupons }`

#### `GET /admin/report`
Read-only summary, computed from a single consistent snapshot: quantity
purchased per product, gross revenue, discounts granted, net revenue, coupon
counts by state, and total orders. Repeated calls never mutate state.

---

## Worked example

Place five orders, earn a coupon, spend it.

```bash
BASE=http://localhost:3000

# 1. Five orders, to reach the milestone
for i in 1 2 3 4 5; do
  CART=$(curl -s -X POST $BASE/carts | jq -r .cart.id)
  curl -s -X POST $BASE/carts/$CART/items \
    -H 'content-type: application/json' \
    -d '{"productId":"tee-classic","quantity":1}' > /dev/null
  curl -s -X POST $BASE/carts/$CART/checkout > /dev/null
done

# 2. Earn the coupon
COUPON=$(curl -s -X POST $BASE/admin/coupons | jq -r .coupon.code)
echo "coupon: $COUPON"

# 3. Spend it
CART=$(curl -s -X POST $BASE/carts | jq -r .cart.id)
curl -s -X POST $BASE/carts/$CART/items \
  -H 'content-type: application/json' \
  -d '{"productId":"bottle-steel","quantity":1}' > /dev/null

curl -s -X POST $BASE/carts/$CART/checkout \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: demo-key-0001" \
  -d "{\"couponCode\":\"$COUPON\"}" | jq '.order | {subtotalMinor, discountMinor, totalMinor}'
# => { "subtotalMinor": 149900, "discountMinor": 14990, "totalMinor": 134910 }

# 4. Retry the same request — same order, no second charge
curl -s -X POST $BASE/carts/$CART/checkout \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: demo-key-0001" \
  -d "{\"couponCode\":\"$COUPON\"}" | jq '{created, orderId: .order.id}'
# => { "created": false, ... same id as above }

# 5. Report
curl -s $BASE/admin/report | jq '.report.totals'
```

### Seeing the oversell guard work

```bash
# Two carts, both wanting the single unit of headphones
A=$(curl -s -X POST $BASE/carts | jq -r .cart.id)
B=$(curl -s -X POST $BASE/carts | jq -r .cart.id)
for C in $A $B; do
  curl -s -X POST $BASE/carts/$C/items -H 'content-type: application/json' \
    -d '{"productId":"headphones-studio","quantity":1}' > /dev/null
done

curl -s -X POST $BASE/carts/$A/checkout &
curl -s -X POST $BASE/carts/$B/checkout &
wait
# One order; the other gets 409 INSUFFICIENT_INVENTORY. Inventory lands at 0, never -1.
```

---

## Layout

```
src/
  config.ts               environment and reward policy
  app.ts                  routes, validation, error envelope
  server.ts               startup and graceful shutdown
  db/
    schema.sql            tables and the constraints that enforce the invariants
    pool.ts               connection pool, withTransaction
    migrate.ts  seed.ts
  domain/
    money.ts              integer minor units, half-up percentage rounding
    errors.ts             closed set of error codes → HTTP status
  services/
    cart.service.ts       cart mutations, live pricing
    checkout.service.ts   the transaction: locks, idempotency, coupon, payment
    coupon.service.ts     milestone arithmetic and generation
    report.service.ts     read-only consistent snapshot
    payment.ts            injectable gateway seam
tests/
  rules.test.ts           business rules, validation, money, failure paths
  concurrency.test.ts     races, retries, report reconciliation
```

## Notes on scope

Frontend not included; the brief marks it optional and explicitly says it does
not compensate for an unreliable backend, so the time went into concurrency,
retry semantics and tests instead.

Deferred items — authentication, coupon expiry, partial fulfilment, pagination,
rate limiting — are listed with reasoning in
[DECISIONS.md](./DECISIONS.md#what-i-implemented-versus-deferred).
