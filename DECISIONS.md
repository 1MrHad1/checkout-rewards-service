# Decisions

Time spent: approximately 5 hours.

This document is the part of the submission I'd most want discussed. The
endpoints were straightforward; everything interesting is in what happens when
two of them run at the same time.

---

## Invariants

These are the properties that must hold no matter how requests interleave. Each
names where it is enforced, because an invariant stated only in prose is an
invariant waiting to be broken.

| # | Invariant | Enforced by |
|---|-----------|-------------|
| 1 | Inventory never goes negative; the store never sells units it does not have | `SELECT … FOR UPDATE` on product rows in `checkout.service.ts`, backed by `CHECK (inventory >= 0)` in `schema.sql` |
| 2 | A cart yields at most one order | `UNIQUE` on `orders.cart_id`, plus `SELECT … FOR UPDATE` on the cart row at the top of checkout |
| 3 | A retried checkout never creates a second order or charges inventory twice | The cart's `order_id`, plus the `idempotency_keys` primary key |
| 4 | A coupon is redeemed at most once | `SELECT … FOR UPDATE` on the coupon row inside the checkout transaction |
| 5 | A coupon is never consumed by a checkout that ultimately fails | Redemption happens inside the checkout transaction, so `ROLLBACK` returns it |
| 6 | At most one coupon exists per milestone | `UNIQUE` on `coupons.milestone_index` |
| 7 | An order total is never negative, and `total = subtotal - discount` | `CHECK` constraints `discount_within_subtotal` and `total_is_consistent` |
| 8 | An order explains itself after the catalogue changes | `order_items` snapshots name and unit price at checkout |
| 9 | The report reconciles with the orders and coupons it reports on | Single `READ ONLY REPEATABLE READ` transaction in `report.service.ts` |

The pattern throughout: where a rule can be expressed as a database constraint,
it is. A constraint cannot be lost to an interleaving the way an
application-level `if` can, and it keeps holding if someone later adds a second
write path that forgets the check.

---

## Ambiguities and the semantics I chose

The brief deliberately leaves several things open. These are the calls I made.

**A coupon applies to the order subtotal, not to a single line.** Simplest rule
that matches "10% off", and it makes the discount independent of how the
customer split their basket.

**One coupon per order.** Stacking opens questions (apply in which order? cap
the combined discount?) that the brief does not need answered. Rejecting a
second coupon is easy to explain to a customer.

**Coupons are bearer tokens.** There is no authentication in this service, so a
coupon is not bound to a customer. Whoever presents the code first redeems it.

**Coupons do not expire.** An `expires_at` column and a check at redemption is a
small addition; I deferred it rather than invent a policy.

**A discounted order still counts towards the next milestone.** The reward is
for purchasing activity, and excluding discounted orders would make the
milestone sequence depend on coupon usage. Tested in `rules.test.ts`.

**Milestones are never skipped.** If milestone 2 somehow has no coupon while
milestone 3 is earned, the next generation fills milestone 2 first. This keeps
"one coupon per milestone" literally true rather than approximately true.

**Coupon generation is manual, not automatic.** The brief says an administrator
requests generation. Checkout therefore does not mint coupons as a side effect,
which keeps the checkout transaction smaller and makes the admin endpoint the
single place where coupons come into existence.

**Adding to a cart does not reserve stock.** See the decision below.

---

## Decision: money as integer minor units

**Context.** Totals, percentage discounts and per-line multiplication all have
to agree, and the report's gross minus discounts has to equal net exactly.

**Options considered.** (a) Floating-point rupees. (b) A decimal library such as
`decimal.js`. (c) Integer paise end to end, `NUMERIC` in the database.

**Choice.** Integer paise everywhere: `BIGINT` columns, `number` in TypeScript,
no fractional value ever created.

**Why.** Floats are disqualified outright: `0.1 + 0.2 !== 0.3`, and those errors
compound across lines and percentages until a report fails to reconcile. A
decimal library would work but adds a dependency and a second numeric type to
remember to use. Integers need no library, and the one operation that can
produce a fraction — a percentage — is isolated in `percentageDiscount()`.

**Consequences.** Every amount must be an integer, so `assertMinor()` guards the
boundaries and fails loudly rather than rounding silently. Formatting for
display is a separate function whose output never re-enters arithmetic. Amounts
are bounded well below `Number.MAX_SAFE_INTEGER`, which is checked.

A genuine bug came out of this. `SUM()` over `BIGINT` widens to `NUMERIC` in
Postgres, and node-postgres returns `NUMERIC` as a *string* to avoid precision
loss. The report's totals therefore arrived as strings, and `gross - discounts`
silently became string arithmetic. The report test caught it; the fix is the
explicit `::bigint` casts in `report.service.ts`.

---

## Decision: pessimistic row locks rather than optimistic retries

**Context.** Concurrent checkouts must not oversell, and the conflict rate on a
scarce item is high by definition — everyone wants the last one.

**Options considered.** (a) Optimistic concurrency: read inventory, write with a
version check, retry on conflict. (b) A conditional update,
`UPDATE products SET inventory = inventory - $1 WHERE id = $2 AND inventory >= $1`.
(c) `SELECT … FOR UPDATE` on every product in the cart, then validate and write.

**Choice.** (c), locking all product rows in one statement ordered by `id`.

**Why.** Option (b) is elegant for a single product but a multi-item cart has to
be all-or-nothing, and reasoning about partial failure across several
conditional updates is harder than holding the locks. Option (a) degrades badly
under exactly the contention this feature creates: on a one-unit product, eight
concurrent buyers mean seven retries that will each fail again. Pessimistic
locking makes them queue instead, and each learns the truth once.

Locking in a consistent order — cart, then products ascending by id, then
coupon — is what prevents deadlock. Two carts containing the same two products
in different orders would otherwise be able to hold each other's next lock.

**Consequences.** Checkout serialises on contended products, which is the
correct trade for a correctness-critical path. A `statement_timeout` keeps a
pathological transaction from holding the pool. The `CHECK (inventory >= 0)`
remains as a backstop: if the lock discipline were ever wrong, the transaction
aborts rather than quietly overselling.

---

## Decision: two independent layers of retry protection

**Context.** A client that times out does not know whether its checkout
succeeded, so it retries. That must not produce a second order.

**Options considered.** (a) Require an `Idempotency-Key` header and key
everything off it. (b) Rely only on the cart being single-use. (c) Both.

**Choice.** (c).

**Why.** The cart is the stronger guarantee and needs no client cooperation: a
cart carries its `order_id` once checked out, so *any* retry — with a key,
without one, concurrent or minutes later — finds the cart closed and receives
the original order. That alone satisfies the requirement.

The idempotency key adds two things the cart cannot. It detects a key reused
against a *different* cart, which signals a client bug worth surfacing rather
than silently placing a second order. And where the cart-row lock serialises
retries for one cart, the key's primary key does the same across carts.

A retry returns `200` with `created: false`; the original returns `201` with
`created: true`. A client can distinguish them without keeping state.

**Consequences.** The key insert can fail with a unique violation, which aborts
the enclosing transaction — and would drop the cart lock taken moments earlier.
`claimIdempotencyKey()` therefore wraps the insert in a `SAVEPOINT`, so the
conflict is confined and the lock survives. This is subtle and is the first
thing I would point a reviewer at.

---

## Decision: charge payment inside the checkout transaction

**Context.** "A coupon must not be lost or consumed by a checkout that
ultimately fails." That is only testable if a checkout can fail *after* the
coupon has been marked redeemed.

**Options considered.** (a) Charge before opening the transaction. (b) Charge
inside it, immediately before commit. (c) Reserve inventory and coupon, charge
outside the transaction, then confirm or compensate.

**Choice.** (b), with a small injectable `PaymentGateway` seam.

**Why.** It makes the requirement structural rather than aspirational: a declined
charge throws, the transaction rolls back, and the coupon, the inventory and the
cart are all returned untouched. `rules.test.ts` asserts exactly this, then
checks out the same cart again successfully. Option (a) can't work — the total
isn't known until the cart is priced under lock. Option (c) is what production
needs, but it is a distributed-transaction problem (reservations, expiry,
compensating refunds) well beyond this timebox.

**Consequences.** Row locks are held across a network call, which does not scale
against a real gateway: a slow provider becomes a store-wide stall. In
production I would move to (c): reserve under lock and commit, charge outside
the transaction, then confirm or compensate via an outbox, with a reaper
releasing reservations that were never confirmed. I have written the trade-off
down rather than shipped a half-built saga.

---

## Decision: cart prices are live; order prices are frozen

**Context.** The brief asks explicitly what happens when a product's price or
availability changes after an item is added but before checkout.

**Options considered.** (a) Freeze the price when the item is added. (b) Price
the cart live, and freeze at checkout. (c) Freeze at add, but warn and re-price
if it changed.

**Choice.** (b). `cart_items` stores only product and quantity; prices are
resolved on read; `order_items` snapshots name, unit price and line total at
checkout.

**Why.** A cart is an intention, not a contract. Honouring a stale price
indefinitely is a pricing-error exploit: leave an item in a cart, wait for the
price to rise, check out at yesterday's price. Pricing live means the customer
is charged what the catalogue says at the moment they commit. The order snapshot
is what makes this safe in the other direction — once placed, an order explains
itself forever, even after the product is renamed or repriced.

**Consequences.** A price can change between viewing the cart and checking out,
so the customer could be charged more than the page last showed. The honest fix
is a confirmation step when the total moved, which I deferred; the groundwork is
there, since the cart response already exposes current prices and totals.

**Availability** follows the same philosophy. Adding to a cart does *not* reserve
stock, because a reservation that nothing expires is a denial-of-service vector:
fill carts with the last unit and never check out. Add-to-cart does a courtesy
check so an impossible cart is rejected early, the cart view flags any line that
now exceeds stock (`insufficientInventory`), and the authoritative check happens
under lock at checkout.

---

## Decision: milestones derived from a live order count

**Context.** "Every *n*th successfully placed order" has to be counted somehow.

**Options considered.** (a) A `BIGSERIAL` order number, rewarding when
`number % n == 0`. (b) A counter row incremented at checkout. (c) `COUNT(*)` of
orders at generation time.

**Choice.** (c), with `UNIQUE (milestone_index)` making concurrent generation safe.

**Why.** (a) is subtly wrong: a sequence value is consumed even by a transaction
that rolls back, so a failed checkout burns an order number and the service
would silently skip a milestone. (b) adds a row every checkout contends on, for
a number the `orders` table already holds. (c) is derived from the truth and
cannot drift, and the uniqueness constraint turns the concurrent case into a
clean "already rewarded" error rather than a duplicate coupon.

**Consequences.** `COUNT(*)` is a sequential scan that grows with the table. At
this scale it is irrelevant, and it is only on an administrative endpoint; at
millions of orders I would keep a maintained counter and reconcile against the
count periodically.

---

## Decision: a closed set of error codes

**Context.** "Return errors that are distinguishable and useful to an API client."

**Options considered.** (a) HTTP status codes alone. (b) Status plus a stable
machine-readable code and structured details.

**Choice.** (b). Every response is `{ error: { code, message, details? } }`, with
`code` drawn from a closed union in `domain/errors.ts` that maps to a status.

**Why.** Status alone is too coarse: `409` could mean the cart was already
checked out, the coupon was already redeemed, or stock ran out, and a client
should handle those differently. A client branches on `code`; `details` carries
the specifics — which product ran short and how many remain — so the client can
build its own message without parsing prose.

The status mapping is deliberate. `409` means "well-formed but conflicts with
current state, and repeating it unchanged will not help". `422` means "valid
syntax, but the request cannot be fulfilled as asked" — an empty cart, an
unknown coupon. `402` is reserved for payment, because the correct client
response is a different instrument, not a different cart.

---

## What I implemented versus deferred

**Implemented.** Products and inventory; cart create, read, add, update, remove;
checkout with optional coupon; order retrieval; admin coupon generation and
reporting; idempotent retries; concurrency-safe inventory and coupon handling;
integer money; the error model; 33 tests including nine concurrency and retry
scenarios.

**Deferred, deliberately.**

- **Authentication and authorisation.** Permitted by the brief. Admin routes are
  namespaced under `/admin` to mark exactly what would sit behind a role.
- **Coupon expiry and per-customer binding.** Needs a customer concept first.
- **Price-change confirmation at checkout.** Discussed above.
- **Partial fulfilment.** A cart is all-or-nothing today.
- **Pagination** on product and coupon listings. Fine at seed scale, not at real scale.
- **Structured request logging and metrics.** Fastify's logger is on; there is no
  correlation id or latency histogram.
- **Rate limiting**, which the idempotency endpoint in particular would want.

---

## How this would change for multiple instances and production scale

The design is already multi-instance safe, and that was the point of putting the
invariants in Postgres rather than in process memory. Row locks and unique
constraints are held by the database, so N instances behave like one. There is
no in-process cache and no singleton state; the only module-level mutable value
is the payment gateway seam, which tests swap.

What would actually need to change:

1. **Payment moves out of the transaction.** The reserve/charge/confirm design
   described above, with an outbox and a reservation reaper. This is the single
   biggest change and the one that matters first.
2. **Connection pooling in front of Postgres.** Many instances times a pool each
   exhausts `max_connections` quickly; PgBouncer in transaction mode, which this
   code is compatible with since it holds no session state between transactions.
3. **Milestone counting becomes a maintained counter**, reconciled against
   `COUNT(*)` on a schedule.
4. **Reporting moves off the primary**, to a read replica or a nightly rollup.
   `REPEATABLE READ` over the full `orders` table is fine at this size and will
   not stay fine.
5. **Idempotency keys get a TTL and a stored response body**, so a replay
   returns a byte-identical response and the table does not grow without bound.
6. **Hot-row contention on a popular product** becomes the bottleneck, since
   checkouts serialise on it. The usual answer is to move stock out of a single
   row — bucketed inventory, or a reservation queue — at the cost of exactness.

---

## How I used AI tools

I used Claude Code throughout, in a loop: I decided the invariants and the
locking strategy first, had it draft implementations against that design, then
reviewed and corrected. It is good at producing a plausible shape quickly and
unreliable about exactly the things this assignment is testing.

Three places I rejected or redirected its output:

**1. Idempotency conflict handling (a correctness bug).** The first version
caught the unique-violation on the idempotency insert and issued a raw
`ROLLBACK` followed by `BEGIN` to inspect the existing row. That looks fine and
is wrong: the rollback discards the entire transaction, including the
`SELECT … FOR UPDATE` on the cart taken a few lines earlier, so the cart is
unlocked for the rest of the request while the code still assumes it holds it.
I replaced it with a `SAVEPOINT`, which confines the failed insert and keeps the
lock. I would not have seen this from reading the code alone; I saw it from
asking what state the transaction is actually in after a constraint violation.

**2. Report aggregation returning strings.** Generated SQL used
`COALESCE(SUM(subtotal_minor), 0)`, which is correct SQL and broken in this
codebase: `SUM()` over `BIGINT` yields `NUMERIC`, which node-postgres returns as
a string to avoid precision loss, so `gross - discounts` became string
arithmetic. The custom `INT8` parser in `pool.ts` does not apply, because the
type is no longer `INT8`. The report test caught it; the fix is explicit
`::bigint` casts. This is the clearest example of why a test that asserts a real
number, not just a `200`, is worth writing.

**3. Rounding by `Math.round` on a float.** The draft discount calculation was
`Math.round(subtotal * percent / 100)`, which reintroduces the float arithmetic
the integer-paise decision exists to avoid. I replaced it with
`Math.floor((subtotal * percent + 50) / 100)` — round-half-up in pure integers —
and clamped the result to the subtotal.

The broader rule I worked to: AI drafts the mechanism, I own the invariant. Any
generated code touching locking, transactions or money got read line by line
against the question "what happens if a second request is here right now".

---

## What I would look at first with another two hours

1. **A test that asserts the lock ordering actually prevents deadlock** — two
   carts with the same two products in opposite orders, hammered concurrently.
   The current ordering is correct by construction, but nothing fails if someone
   later removes the `ORDER BY id`.
2. **Price-change confirmation at checkout**, with an optional
   `expectedTotalMinor` the client can send; the server rejects on mismatch.
   That closes the honesty gap in the live-pricing decision.
3. **Storing the response body with the idempotency key**, plus a TTL, so a
   replay is byte-identical rather than merely equivalent.
4. **Property-based tests on the money functions**, checking that
   `discount <= subtotal` and `total >= 0` hold for arbitrary inputs, rather than
   the handful of worked examples there now.
5. **A load test on the contended-product path**, to find where lock queueing
   starts to hurt and put a number on the claim that pessimistic locking was the
   right trade.
