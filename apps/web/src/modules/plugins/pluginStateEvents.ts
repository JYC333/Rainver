const CHANGED = 'rainver:plugin-state-changed'

/** Tell every mounted reader of plugin install/enablement state in this tab to read it again. */
export function announcePluginStateChanged() {
  window.dispatchEvent(new CustomEvent(CHANGED))
}

/** Subscribe to plugin install/enablement changes announced in this tab; returns the unsubscribe. */
export function onPluginStateChanged(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener)
  return () => window.removeEventListener(CHANGED, listener)
}
