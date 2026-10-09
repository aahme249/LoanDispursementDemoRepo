/**
 * Money crosses process boundaries (HTTP, Temporal payloads) as a decimal string
 * of integer cents, because JSON has no bigint and a JS number loses precision
 * above 2^53. Inside the process it is always a bigint.
 */
export type CentsString = string & { readonly __brand: 'CentsString' };

const POSITIVE_INTEGER = /^[1-9]\d*$/;

export function parseCents(value: string): bigint {
  if (!POSITIVE_INTEGER.test(value)) {
    throw new RangeError(`amount must be a positive integer number of cents, got "${value}"`);
  }
  return BigInt(value);
}

export function toCentsString(value: bigint): CentsString {
  if (value <= 0n) throw new RangeError(`amount must be positive, got ${value}`);
  return value.toString() as CentsString;
}
