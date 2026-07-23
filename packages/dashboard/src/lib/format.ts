/**
 * Human-facing display formatters. The goal is that a normal person never sees
 * over-precise decimals, raw party fingerprints, or internal ids on screen.
 */

/** A Canton Coin amount, trailing zeros trimmed and the symbol appended:
 * "3.0000000000" -> "3 CC", "3.5000" -> "3.5 CC", "0.2500" -> "0.25 CC". */
export function fmtCc(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return `${raw}`;
  const s = n.toFixed(4).replace(/\.?0+$/, '');
  return `${s} CC`;
}

/** Just the numeric part, trailing zeros trimmed (no symbol). */
export function fmtAmount(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return '0';
  const n = Number(raw);
  if (!Number.isFinite(n)) return `${raw}`;
  return n.toFixed(4).replace(/\.?0+$/, '');
}

/** A party's human short name (the readable prefix before "::"). Falls back to
 * the raw value. Pair with a `title={party}` so the full id is a hover away. */
export function displayName(party: string | null | undefined): string {
  if (!party) return '—';
  const local = party.split('::')[0];
  return local && local.length > 0 ? local : party;
}

/** A friendly asset symbol from an instrument id. Defaults to CC. */
export function instrumentLabel(id?: string | null): string {
  if (!id) return 'CC';
  if (/usdc/i.test(id)) return 'USDCx';
  if (/amulet|coin|^cc$|numeric/i.test(id)) return 'CC';
  return id;
}

/** A locale date-time, or a dash for anything unparseable. */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
