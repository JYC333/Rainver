import type { RainverPlugin } from "@rainver/protocol";
import { defaultOfficialPluginArtifactRoot, loadOfficialPluginPackages } from "./packageLoader.js";
import { listOfficialPlugins } from "./registry.js";

/**
 * Runtime official plugins bundled with this server build.
 *
 * Source lives under `plugins/official/*`. The server loads the compiled
 * package artifacts from `dist/official-plugins/*` at startup.
 */
export const BUILT_IN_PLUGINS: readonly RainverPlugin[] = await loadOfficialPluginPackages(
  defaultOfficialPluginArtifactRoot(),
  { allowedPluginIds: listOfficialPlugins().map((descriptor) => descriptor.id) },
);
