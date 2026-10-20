-- Schema for the checkout + rewards service.
--
-- Money is stored as BIGINT in minor units (paise). See DECISIONS.md.
-- Several invariants are enforced here rather than in application code, so that
-- they hold even when two requests race: a database constraint cannot be lost
-- to an interleaving the way an application-level check can.

CREATE TABLE IF NOT EXISTS products (
  id               TEXT PRIMARY KEY,
  name             TEXT   NOT NULL,
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  inventory        INT    NOT NULL CHECK (inventory >= 0)
);

CREATE TABLE IF NOT EXISTS carts (
  id         UUID PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out')),
  -- Set when the cart is checked out. Lets a retried checkout return the
  -- original order instead of creating a second one.
  order_id   UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id    UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity   INT  NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY,
  -- One order per cart: the database, not the service, is what makes a cart
  -- single-use under concurrent checkouts.
  cart_id         UUID   NOT NULL UNIQUE REFERENCES carts(id),
  subtotal_minor  BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor     BIGINT NOT NULL CHECK (total_minor >= 0),
  coupon_code     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An order total can never be negative, and a discount can never exceed the
  -- subtotal it was applied to.
  CONSTRAINT discount_within_subtotal CHECK (discount_minor <= subtotal_minor),
  CONSTRAINT total_is_consistent      CHECK (total_minor = subtotal_minor - discount_minor)
);

-- Line items snapshot the product name and unit price at the moment of
-- checkout, so an order still explains itself after the catalogue changes.
CREATE TABLE IF NOT EXISTS order_items (
  order_id         UUID   NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       TEXT   NOT NULL,
  product_name     TEXT   NOT NULL,
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  quantity         INT    NOT NULL CHECK (quantity > 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  code            TEXT PRIMARY KEY,
  -- The 1-based milestone this coupon rewards. UNIQUE is what stops two
  -- concurrent admin requests from both generating a coupon for milestone 2.
  milestone_index INT  NOT NULL UNIQUE CHECK (milestone_index > 0),
  percent_off     INT  NOT NULL CHECK (percent_off > 0 AND percent_off <= 100),
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'redeemed')),
  order_id        UUID REFERENCES orders(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at     TIMESTAMPTZ,
  -- A redeemed coupon must say which order consumed it, and an available one
  -- must not point at an order. Keeps the report reconcilable.
  CONSTRAINT redemption_is_consistent CHECK (
    (status = 'redeemed'  AND order_id IS NOT NULL AND redeemed_at IS NOT NULL) OR
    (status = 'available' AND order_id IS NULL     AND redeemed_at IS NULL)
  )
);

-- Replay protection for checkout. The PRIMARY KEY is the mechanism: a second
-- request carrying the same key cannot insert a second row.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  cart_id    UUID NOT NULL REFERENCES carts(id),
  order_id   UUID REFERENCES orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
