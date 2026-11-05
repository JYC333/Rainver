export const EVOLUTION_ASSET_PARAM = 'asset'

/** The Evolution page with one asset's versions, lifecycle and promotion selected. */
export function evolutionAssetPath(assetId?: string | null): string {
  const id = assetId?.trim()
  return id ? `/evolution?${EVOLUTION_ASSET_PARAM}=${encodeURIComponent(id)}` : '/evolution'
}
