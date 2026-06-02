/**
 * @module lib/cantonTime
 *
 * Tolerant parser for Canton timestamp values that come back over the
 * REST proxy in two shapes depending on which endpoint produced them:
 *
 *   1. ISO-8601 strings, e.g. `"2026-06-02T15:30:32Z"`.
 *      Stream config (`startTime`, `endTime`) returns these via
 *      `deserializeConfig` in api/client.ts.
 *
 *   2. Microsecond-epoch numeric strings, e.g. `"1748789432000000"`.
 *      DelegatedPolicy fields (`expiresAt`, `createdAt`) come straight
 *      from the JSON Ledger API's Time → microsecond serialization and
 *      are NOT re-formatted by the proxy.
 *
 * `new Date(value)` only works for case (1). For case (2), JS interprets
 * the all-digit string as a year, producing `Invalid Date`. The dashboard
 * previously crashed-to-`Invalid Date` on the Policies page for this
 * reason.
 *
 * `parseCantonTime` accepts either form and returns a `Date` (or `null`
 * if neither shape can be parsed). It does not throw — callers render
 * `'—'` on `null`.
 */

/** Canton microsecond epochs are 16 digits today; allow a small range
 * around that to be defensive against clock-skew edge cases without
 * mis-classifying short ISO substrings. */
const MICROSECOND_NUMERIC = /^\d{15,19}$/;

export function parseCantonTime(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value) : null;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  // Case 2: all-digits microsecond epoch string.
  if (MICROSECOND_NUMERIC.test(trimmed)) {
    const micros = BigInt(trimmed);
    // Convert micros → ms with bigint to avoid precision loss; JS Date
    // accepts ms ≤ 8.64e15 (year ≈ 275760).
    const millis = Number(micros / 1000n);
    if (!Number.isFinite(millis)) return null;
    return new Date(millis);
  }

  // Case 1: any string Date can parse (ISO, RFC2822, etc).
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Render a Canton timestamp as a localized short date, with a graceful
 * fallback when the value is missing or unparseable.
 */
export function formatCantonDate(
  value: string | number | Date | null | undefined,
  fallback = '—',
): string {
  const d = parseCantonTime(value);
  return d ? d.toLocaleDateString() : fallback;
}

/**
 * Render a Canton timestamp as a localized date + time, with a graceful
 * fallback.
 */
export function formatCantonDateTime(
  value: string | number | Date | null | undefined,
  fallback = '—',
): string {
  const d = parseCantonTime(value);
  return d ? d.toLocaleString() : fallback;
}
