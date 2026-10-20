/**
 * Money handling.
 *
 * Every amount in this service is an integer count of minor units (paise).
 * Nothing is ever stored or computed as a floating-point rupee value, because
 * 0.1 + 0.2 !== 0.3 in IEEE-754 and those fractions accumulate across line
 * items and percentage discounts. See DECISIONS.md.
 */

/** Largest amount we accept, to keep every intermediate product inside Number.MAX_SAFE_INTEGER. */
const MAX_MINOR = 1_000_000_000_000; // 10 billion rupees

export function assertMinor(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer number of minor units, received ${value}`);
  }
  if (value < 0) {
    throw new Error(`${label} must not be negative, received ${value}`);
  }
  if (value > MAX_MINOR) {
    throw new Error(`${label} exceeds the maximum supported amount`);
  }
}

/** Multiplies a unit price by a quantity. Both are integers, so the result is exact. */
export function lineTotal(unitPriceMinor: number, quantity: number): number {
  assertMinor(unitPriceMinor, 'unitPriceMinor');
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`quantity must be a positive integer, received ${quantity}`);
  }
  const total = unitPriceMinor * quantity;
  assertMinor(total, 'lineTotal');
  return total;
}

/**
 * Applies a whole-percent discount, rounding half up to the nearest minor unit.
 *
 * Half-up is the conventional rounding for retail money in India and is what a
 * customer reading the invoice expects. The result is clamped to the subtotal,
 * so a total can never go negative even if percentOff were ever misconfigured
 * above 100.
 */
export function percentageDiscount(subtotalMinor: number, percentOff: number): number {
  assertMinor(subtotalMinor, 'subtotalMinor');
  if (!Number.isInteger(percentOff) || percentOff < 0 || percentOff > 100) {
    throw new Error(`percentOff must be an integer between 0 and 100, received ${percentOff}`);
  }

  // Integer arithmetic throughout: (subtotal * percent + 50) / 100, floored.
  // Adding half the divisor before flooring is round-half-up without touching
  // a float. Both operands are non-negative, so there is no sign asymmetry.
  const discount = Math.floor((subtotalMinor * percentOff + 50) / 100);
  return Math.min(discount, subtotalMinor);
}

export function sumMinor(values: readonly number[]): number {
  const total = values.reduce((acc, value) => acc + value, 0);
  assertMinor(total, 'sum');
  return total;
}

/** Formats minor units for display. Presentation only; never fed back into arithmetic. */
export function formatMinor(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${sign}${currency} ${major}.${fraction}`;
}
