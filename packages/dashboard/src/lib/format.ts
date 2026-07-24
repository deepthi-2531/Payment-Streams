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

/** A display asset: symbol + decimals for a stream/vault's settlement asset.
 *  `assetKey` absent or 'cc' means Canton Coin. */
export interface DisplayAsset {
  assetKey?: string;
  symbol?: string;
  decimals?: number;
}

/** True when the asset is (or defaults to) Canton Coin. */
function isCcAsset(asset?: DisplayAsset): boolean {
  const key = asset?.assetKey?.trim().toLowerCase();
  return !key || key === 'cc';
}

/** Derive a DisplayAsset from a view carrying `assetKey` + `instrument`. */
export function assetOfView(
  view: { assetKey?: string; instrument?: { id?: string; decimals?: number } } | null | undefined,
): DisplayAsset {
  return {
    assetKey: view?.assetKey,
    symbol: view?.instrument?.id,
    decimals: view?.instrument?.decimals,
  };
}

/** An amount with its asset's unit. For CC (assetKey absent or 'cc') this is
 * byte-for-byte `fmtCc`; a non-CC asset uses its instrument id as the unit and
 * trims trailing zeros: "1 USDCx", "0.5 USDCx". */
export function fmtAsset(raw: string | number | null | undefined, asset?: DisplayAsset): string {
  if (isCcAsset(asset)) return fmtCc(raw);
  if (raw === null || raw === undefined || raw === '') return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return `${raw}`;
  const dp = Math.min(Math.max(asset?.decimals ?? 4, 0), 10);
  const s = n.toFixed(dp).replace(/\.?0+$/, '');
  return `${s} ${asset?.symbol || instrumentLabel(asset?.assetKey)}`;
}

/** A locale date-time, or a dash for anything unparseable. */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
