/**
 * @module components/streams/AssetSelect
 *
 * Asset picker for the create-stream / create-flow forms. Replaces the two
 * free-text "Instrument admin" + "Instrument id" inputs with a dropdown of the
 * deployment's supported assets (fetched from `GET /api/assets`, so Canton
 * Coin prefills the *correct* network DSO) plus a "Custom asset…" entry that
 * reveals the original text inputs for anything unlisted.
 *
 * It drives the same two react-hook-form fields the schemas already validate
 * (`instrumentAdmin`, `instrumentId` by default) via `setValue`, so no schema
 * or submit-path change is needed — this is purely an input affordance.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useFormContext } from 'react-hook-form';
import { useAssets } from '../../hooks/useAssets.js';
import { FormField } from '../forms/FormField.js';

const CUSTOM = '__custom__';

const inputClass =
  'block w-full rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500 transition-colors';

const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-sm)',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--fg)',
  outline: 'none',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--fg-2)',
  marginBottom: 6,
};

export interface AssetSelectProps {
  /** Form field holding the instrument admin party. */
  readonly adminName?: string;
  /** Form field holding the instrument id. */
  readonly idName?: string;
  /**
   * When set, the selected asset's whitelist `key` is written to this form
   * field too. The V1 create lane submits an `assetKey` (not an admin/id pair),
   * so it passes `keyName="assetKey"` to thread the choice into the payload.
   */
  readonly keyName?: string;
  /**
   * Offer the "Custom asset…" escape hatch (free-text admin/id). The V1 lane
   * only accepts server-whitelisted keys, so it passes `false`. Default true.
   */
  readonly allowCustom?: boolean;
  /**
   * Preselect the first supported asset when both fields start empty, so the
   * correct network admin is prefilled. Suppressed when the fields already
   * carry values (query prefill / editing). Default true.
   */
  readonly autoDefault?: boolean;
}

export function AssetSelect({
  adminName = 'instrumentAdmin',
  idName = 'instrumentId',
  keyName,
  allowCustom = true,
  autoDefault = true,
}: AssetSelectProps) {
  const { setValue, watch } = useFormContext();
  const { data: assets = [], isLoading } = useAssets();

  const admin = (watch(adminName) as string | undefined) ?? '';
  const id = (watch(idName) as string | undefined) ?? '';
  const matched = assets.find((a) => a.instrumentAdmin === admin && a.instrumentId === id);

  const [custom, setCustom] = useState(false);
  const didInit = useRef(false);

  // Seed the initial selection once the asset list resolves. Existing field
  // values (deep-link prefill, editing) win; otherwise default to the first
  // supported asset so the deployment-correct admin is filled in for the user.
  useEffect(() => {
    if (didInit.current || isLoading) return;
    didInit.current = true;
    if (admin || id) {
      if (!matched) {
        if (allowCustom) setCustom(true);
      } else if (keyName) {
        setValue(keyName, matched.key, { shouldValidate: true });
      }
      return;
    }
    if (autoDefault && assets.length > 0) {
      const first = assets[0]!;
      setValue(adminName, first.instrumentAdmin, { shouldValidate: true });
      setValue(idName, first.instrumentId, { shouldValidate: true });
      if (keyName) setValue(keyName, first.key, { shouldValidate: true });
    }
  }, [isLoading, assets, admin, id, matched, autoDefault, adminName, idName, keyName, allowCustom, setValue]);

  const selected = custom ? CUSTOM : matched ? matched.key : '';

  const onChange = (key: string) => {
    if (key === CUSTOM) {
      setCustom(true);
      if (keyName) setValue(keyName, '', { shouldValidate: true, shouldDirty: true });
      return;
    }
    setCustom(false);
    const asset = assets.find((a) => a.key === key);
    if (asset) {
      setValue(adminName, asset.instrumentAdmin, { shouldValidate: true, shouldDirty: true });
      setValue(idName, asset.instrumentId, { shouldValidate: true, shouldDirty: true });
      if (keyName) setValue(keyName, asset.key, { shouldValidate: true, shouldDirty: true });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label htmlFor="asset-select" style={labelStyle}>
          Asset
          <span style={{ color: 'var(--danger, #f43f5e)', marginLeft: 2 }}>*</span>
        </label>
        <select
          id="asset-select"
          className={inputClass}
          style={inputStyle}
          value={selected}
          onChange={(e) => onChange(e.target.value)}
          disabled={isLoading}
        >
          <option value="" disabled>
            {isLoading ? 'Loading assets…' : 'Select an asset…'}
          </option>
          {assets.map((a) => (
            <option key={a.key} value={a.key}>
              {a.displayName} · {a.instrumentId}
            </option>
          ))}
          {allowCustom && <option value={CUSTOM}>Custom asset…</option>}
        </select>
        {!custom && matched && (
          <p className="mono" style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--fg-4)' }}>
            admin {shortParty(matched.instrumentAdmin)} · id {matched.instrumentId}
          </p>
        )}
      </div>

      {custom && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 14 }}>
          <FormField name={adminName} label="Instrument admin" required>
            <input className={inputClass} style={inputStyle} placeholder="AmuletAdmin::1220…" />
          </FormField>
          <FormField name={idName} label="Instrument id" required>
            <input className={inputClass} style={inputStyle} placeholder="Amulet" />
          </FormField>
        </div>
      )}
    </div>
  );
}

function shortParty(p: string): string {
  const sep = p.indexOf('::');
  if (sep <= 0) return p.length > 16 ? `${p.slice(0, 8)}…${p.slice(-4)}` : p;
  return `${p.slice(0, sep)}::${p.slice(sep + 2, sep + 10)}…`;
}
