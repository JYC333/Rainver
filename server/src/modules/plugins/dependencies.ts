import type { RainverPlugin } from '@rainver/protocol';
/** Whole graph is checked before activation or DDL. Missing dependencies stay pending. */
export function pluginOrder(plugins: readonly RainverPlugin[]): {
  ordered: RainverPlugin[];
  pending: string[];
} {
  const map = new Map<string, RainverPlugin>();
  for (const p of plugins) {
    if (map.has(p.id)) throw new Error('Duplicate plugin');
    map.set(p.id, p);
  }
  const state = new Map<string, number>(),
    ordered: RainverPlugin[] = [],
    pending = new Set<string>();
  function visit(id: string): boolean {
    if (state.get(id) === 1) throw new Error('Plugin dependency cycle');
    if (state.get(id) === 2) return !pending.has(id);
    const p = map.get(id);
    if (!p) return false;
    state.set(id, 1);
    let ready = true;
    for (const dep of p.operationManifest?.requires ?? []) if (!visit(dep)) ready = false;
    state.set(id, 2);
    if (ready) ordered.push(p);else pending.add(id);
    return ready;
  }
  for (const id of map.keys()) visit(id);
  return {
    ordered,
    pending: [...pending]
  };
}
