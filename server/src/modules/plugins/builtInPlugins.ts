import type { RainverPlugin } from "@rainver/protocol";
import { defaultOfficialPluginArtifactRoot, loadOfficialPluginPackages } from "./packageLoader.js";
import { listOfficialPlugins } from "./registry.js";

/**
 * Runtime official plugins bundled with this server build.
 *
 * Source lives under `plugins/official/*`, but the server loads the compiled
 * package artifacts from `dist/official-plugins/*` at startup. This keeps the
 * Level 1 monorepo development flow while matching the Level 2 startup-scan
 * shape for downloaded official plugins.
 */
export const BUILT_IN_PLUGINS: readonly RainverPlugin[] = await loadOfficialPluginPackages(
  defaultOfficialPluginArtifactRoot(),
  { allowedPluginIds: listOfficialPlugins().map((descriptor) => descriptor.id) },
);
