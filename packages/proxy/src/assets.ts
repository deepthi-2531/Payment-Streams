/**
 * Supported assets for the create-stream / create-flow asset picker.
 *
 * The instrument admin (the DSO for Canton Coin, the registrar for USDCx) is
 * network-specific, so it is resolved from the proxy's environment at runtime
 * rather than hard-coded — the committed `config/asset-registry.json` carries
 * reference values, but the live admin differs per deployment. Any asset whose
 * admin is unset (or a `TBD` placeholder) is omitted; the picker always offers
 * a "Custom" entry on top of this list, so an unlisted asset stays reachable.
 */

export interface SupportedAsset {
  key: string;
  displayName: string;
  instrumentAdmin: string;
  instrumentId: string;
  standard: string;
  note?: string;
}

function usable(party: string | undefined): party is string {
  return typeof party === 'string' && party.includes('::') && !party.startsWith('TBD');
}

/** Assets this deployment can address, admin parties resolved from the env. */
export function getSupportedAssets(): SupportedAsset[] {
  const out: SupportedAsset[] = [];

  // Trim at read time — like the V1 lane's config loader — so a file/secret
  // sourced env value with a trailing newline doesn't emit a party id that
  // fails Canton's exact-match comparison.
  const ccAdmin = (process.env['CC_ADMIN_PARTY'] ?? process.env['CANTON_CC_ADMIN'])?.trim();
  if (usable(ccAdmin)) {
    out.push({
      key: 'cc',
      displayName: 'Canton Coin (Amulet)',
      instrumentAdmin: ccAdmin,
      instrumentId: (process.env['CC_INSTRUMENT_ID'] ?? 'Amulet').trim(),
      standard: 'CIP-56 V1 (transitional)',
      note: 'Canton Coin — the DSO admin is resolved for this network.',
    });
  }

  const usdcxAdmin = process.env['USDCX_ADMIN_PARTY']?.trim();
  if (usable(usdcxAdmin)) {
    out.push({
      key: 'usdcx',
      displayName: 'USDCx',
      instrumentAdmin: usdcxAdmin,
      instrumentId: (process.env['USDCX_INSTRUMENT_ID'] ?? 'USDCx').trim(),
      standard: 'CIP-56 V1 (transitional)',
      note: 'Circle USDC on Canton via xReserve.',
    });
  }

  return out;
}
