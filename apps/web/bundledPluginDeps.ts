import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Bundled plugin packages (`plugins/official/<id>/`) have no node_modules of
 * their own; their browser-safe manifests import `zod`. Resolve it to the copy
 * `@rainver/protocol` already uses, so the app and every manifest share one
 * zod instance (its ESM entry).
 */
export function bundledPluginAliases(webRoot: string) {
  const protocol = createRequire(join(webRoot, 'package.json')).resolve('@rainver/protocol')
  // `require` resolves zod's CommonJS entry; its ESM entry sits beside it.
  const zod = createRequire(protocol).resolve('zod')
  return [{ find: /^zod$/, replacement: join(dirname(zod), 'index.js') }]
}
