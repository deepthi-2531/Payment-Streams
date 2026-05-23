/**
 * AssetGlyph — monogram token icon for an asset.
 *
 * Ported from `Canton Streams/src/icons.jsx`. The mock hardcoded a fixed
 * 4-asset map (USDCx / CC / CBTC / ETHx); we accept the asset key plus an
 * optional `color` so callers wiring through the real asset registry
 * (Phase 5) can pass per-asset colors from config without us baking them
 * in here. Falls back to a neutral gradient if no color is provided.
 *
 * The letter mapping:
 *   - `USDCx` / any `USD*` → `$`
 *   - `CC` → `C`
 *   - `CBTC` / any `*BTC*` → `₿`
 *   - `ETHx` / any `*ETH*` → `Ξ`
 *   - everything else → first letter, uppercased
 *
 * Phase 1 — STR-111.
 */
import type { CSSProperties } from 'react';

export interface AssetGlyphProps {
  readonly asset: string;
  readonly size?: number;
  readonly color?: string;
}

function letterFor(asset: string): string {
  if (asset.startsWith('USD')) return '$';
  if (asset === 'CC') return 'C';
  if (asset.includes('BTC')) return '₿';
  if (asset.includes('ETH')) return 'Ξ';
  return (asset[0] ?? '?').toUpperCase();
}

const DEFAULT_COLOR = 'oklch(0.72 0.10 200)';

export function AssetGlyph({ asset, size = 22, color }: AssetGlyphProps) {
  const c = color ?? DEFAULT_COLOR;
  const letter = letterFor(asset);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(135deg, ${c}, color-mix(in oklab, ${c} 30%, var(--card)))`,
    color: '#0a0c12',
    fontFamily: 'var(--font-mono)',
    fontWeight: 600,
    fontSize: size * 0.5,
    flexShrink: 0,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 35%, transparent)`,
  };

  return <div style={style}>{letter}</div>;
}
