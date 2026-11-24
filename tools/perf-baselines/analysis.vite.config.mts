// The web production build plus a chunk → module map (`<ANALYSIS_OUT>.chunks.json`),
// written beside a separate output directory so `apps/web/dist` is untouched.
// Run from apps/web: ANALYSIS_OUT=/tmp/x node node_modules/vite/bin/vite.js build --config ../../tools/perf-baselines/analysis.vite.config.mts
import { writeFileSync } from 'node:fs'
import base from '../../apps/web/vite.config.ts'

export default async (env: Parameters<Exclude<typeof base, object>>[0]) => {
  const cfg = typeof base === 'function' ? await base(env) : base
  cfg.build = { ...cfg.build, outDir: process.env.ANALYSIS_OUT, emptyOutDir: true }
  cfg.plugins = [...(cfg.plugins ?? []), { name: 'chunk-dump', apply: 'build', generateBundle(_options: unknown, bundle: Record<string, any>) {
    const out: Record<string, unknown> = {}
    for (const file of Object.values(bundle)) if (file.type === 'chunk') out[file.fileName] = { name: file.name, isEntry: file.isEntry, imports: file.imports, dynamicImports: file.dynamicImports,
      modules: Object.fromEntries(Object.entries(file.modules as Record<string, { renderedLength: number }>).map(([id, m]) => [id, m.renderedLength])) }
    writeFileSync(`${process.env.ANALYSIS_OUT}.chunks.json`, JSON.stringify(out))
  } }]
  return cfg
}
