import { lazy } from 'react';
import { acceptanceOperationPlugins } from './acceptanceCatalog';
import { PluginOperationManifestSchema, pluginFrontendEntries, type PluginOperationManifest } from '@rainver/protocol';
import type { Module } from '../registry';
import type { PluginSlotComponent } from './slotTypes';
// Build-time imports only. No manifest URL is evaluated or imported.
const declarations = import.meta.glob('../../../../../plugins/official/*/operationManifest.ts', {
  eager: true,
  import: 'default'
});
const localViews = import.meta.glob<{
  default: Record<string, PluginSlotComponent>;
}>('../../../../../plugins/official/*/web/src/operationViews.tsx');
export interface BundledOperationPlugin {
  manifest: PluginOperationManifest;
  load: () => Promise<{
    default: Record<string, PluginSlotComponent>;
  }>;
}
export const bundledOperationPlugins: BundledOperationPlugin[] = Object.entries(declarations).map(([path, value]) => {
  const manifest = PluginOperationManifestSchema.parse(value);
  if (!manifest.web) return null;
  if (!path.endsWith(`/${manifest.id}/operationManifest.ts`)) throw new Error('Plugin manifest directory mismatch');
  const load = localViews[path.replace('/operationManifest.ts', '/web/src/operationViews.tsx')];
  if (!load) throw new Error('Plugin web declaration has no bundled component module');
  return {
    manifest,
    load
  };
}).filter((p): p is BundledOperationPlugin => p !== null);
// Vite selects a separate fixture entry only in plugin-acceptance mode.
bundledOperationPlugins.push(...acceptanceOperationPlugins);
const packageIds = new Set<string>();
for (const bundle of bundledOperationPlugins) {
  if (packageIds.has(bundle.manifest.id)) throw new Error('Duplicate bundled operation plugin');
  packageIds.add(bundle.manifest.id);
}
export const manifestModules: Module[] = bundledOperationPlugins.flatMap(({
  manifest
}) => pluginFrontendEntries(manifest).filter(e => e.placements.includes('navigation')).map(e => ({
  id: e.module_id,
  label: e.label,
  path: e.path,
  icon: e.icon,
  description: manifest.description,
  group: 'work',
  section: 'knowledge',
  source: 'official_plugin',
  pluginId: manifest.id,
  enabled: false,
  visible: false,
  planned: false,
  perspectiveType: manifest.scope === 'space' ? 'space-scoped' : 'personal',
  component: lazy(async () => {
    const {
      PluginSlot
    } = await import('./PluginSlot');
    return {
      default: () => <PluginSlot pluginId={manifest.id} entryId={e.entry_id} />
    };
  })
})));
export function bundledPlugin(id: string) {
  return bundledOperationPlugins.find(p => p.manifest.id === id);
}
