// Like analysis.vite.config.mts, plus `<ANALYSIS_OUT>.graph.json`: each module's
// static and dynamic imports, for tracing why a module is in the boot closure
// (node ../../tools/perf-baselines/shell-closure.mjs <ANALYSIS_OUT>).
import { writeFileSync } from 'node:fs'
import analysis from './analysis.vite.config.mts'

export default async (env: Parameters<typeof analysis>[0]) => {
  const cfg = await analysis(env)
  cfg.plugins = [...(cfg.plugins ?? []), { name: 'module-graph', apply: 'build', generateBundle() {
    const out: Record<string, { s: string[], d: string[] }> = {}
    for (const id of (this as any).getModuleIds()) { const m = (this as any).getModuleInfo(id); out[id] = { s: m.importedIds, d: m.dynamicallyImportedIds } }
    writeFileSync(`${process.env.ANALYSIS_OUT}.graph.json`, JSON.stringify(out))
  } }]
  return cfg
}
