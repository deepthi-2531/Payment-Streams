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
  /** Concrete holding template this asset is funded from / verified against. */
  holdingTemplateId: string;
  /** Registry base for this asset's transfer-instruction factory. Empty string
   *  ⇒ the proxy's global REGISTRY_API_URL (Canton Coin's Scan). A non-CC asset
   *  must set its own base to be streamable. */
  registryApiUrl: string;
  /** Token-standard transfer API version for this asset's money leg. */
  transferVersion: 'v1' | 'v2';
  /** Display decimals. */
  decimals: number;
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
      standard: 'CIP-56 Token Standard',
      note: 'Canton Coin — the DSO admin is resolved for this network.',
      holdingTemplateId: (
        process.env['HOLDING_TEMPLATE_ID'] ?? '#splice-amulet:Splice.Amulet:Amulet'
      ).trim(),
      // Empty ⇒ the global REGISTRY_API_URL (CC's Scan already serves the
      // transfer-instruction factory at /registry/... directly).
      registryApiUrl: '',
      transferVersion: (process.env['TRANSFER_VERSION'] ?? 'v1') === 'v2' ? 'v2' : 'v1',
      decimals: 10,
    });
  }

  const usdcxAdmin = process.env['USDCX_ADMIN_PARTY']?.trim();
  const usdcxRegistry = process.env['USDCX_REGISTRY_API_URL']?.trim();
  // USDCx is streamable only once BOTH its registrar admin and its own
  // transfer-instruction registry base are configured (the Circle xReserve
  // token-standard registry, distinct from CC's Scan). Until then it stays off
  // the whitelist so a stream can't be created against an unroutable asset.
  if (usable(usdcxAdmin) && usdcxRegistry) {
    out.push({
      key: 'usdcx',
      displayName: 'USDCx',
      instrumentAdmin: usdcxAdmin,
      instrumentId: (process.env['USDCX_INSTRUMENT_ID'] ?? 'USDCx').trim(),
      standard: 'CIP-56 Token Standard',
      note: 'Circle USDC on Canton via xReserve.',
      holdingTemplateId: (process.env['USDCX_HOLDING_TEMPLATE_ID'] ?? '').trim(),
      registryApiUrl: usdcxRegistry.replace(/\/+$/, ''),
      transferVersion: (process.env['USDCX_TRANSFER_VERSION'] ?? 'v1') === 'v2' ? 'v2' : 'v1',
      decimals: Number(process.env['USDCX_DECIMALS'] ?? '6'),
    });
  }

  return out;
}

/** Resolve a whitelisted asset by its registry key, or undefined if the key is
 *  unknown / not configured for this deployment (used to gate stream creation). */
export function resolveStreamAsset(key: string): SupportedAsset | undefined {
  return getSupportedAssets().find((a) => a.key === key);
}
