export function promptLibraryPath(assetKey?: string | null): string {
  const key = assetKey?.trim()
  return key ? `/prompts?asset=${encodeURIComponent(key)}` : '/prompts'
}

/** The workbench owns its Reader/Project return link; generic settings own the default entry. */
export function isPromptWorkbench(search: URLSearchParams): boolean {
  return search.get('advanced') !== '1' && !search.has('asset') && !search.has('tab')
}

export function hasReadingMethodOrigin(search: URLSearchParams): boolean {
  return isPromptWorkbench(search) && ['reading_method', 'item_id', 'project_id', 'reader', 'artifact_id'].some(key => search.has(key))
}
