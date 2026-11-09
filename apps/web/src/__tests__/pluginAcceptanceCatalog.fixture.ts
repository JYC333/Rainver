import { probeManifest } from '../../../../server/test/fixtures/pluginOperation/manifest';
import type { BundledOperationPlugin } from '../modules/plugins/manifestCatalog';
export const acceptanceOperationPlugins: BundledOperationPlugin[] = [{
  manifest: probeManifest,
  load: () => import('./pluginOperationViews.fixture'),
}];
