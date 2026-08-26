import { createHash } from "node:crypto";
import type { RainverPlugin } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import { getOfficialPlugin } from "./registry.js";
import { pluginRepository, type PluginInstallRow } from "./repository.js";

export interface InstallPluginOptions {
  actorUserId: string | null;
  source?: PluginInstallRow["source"];
}

export async function installOfficialPlugin(
  db: Queryable,
  pluginId: string,
  plugins: readonly RainverPlugin[],
  opts: InstallPluginOptions,
): Promise<PluginInstallRow> {
  const descriptor = getOfficialPlugin(pluginId);
  if (!descriptor) throw new HttpError(404, `Plugin not found: ${pluginId}`);

  const plugin = plugins.find((candidate) => candidate.id === pluginId);
  if (!plugin) throw new HttpError(404, `Plugin runtime not found: ${pluginId}`);

  for (const migration of plugin.migrations ?? []) {
    const checksum = sha256(migration.sql);
    const existing = await pluginRepository.findMigration(db, plugin.id, migration.id);
    if (existing?.status === "applied") {
      if (existing.checksum != null && existing.checksum !== checksum) {
        throw new HttpError(
          409,
          `Plugin migration checksum mismatch: ${plugin.id}/${migration.id}`,
        );
      }
      continue;
    }
    if (existing?.status === "failed") {
      throw new HttpError(
        409,
        `Plugin migration previously failed: ${plugin.id}/${migration.id}`,
      );
    }

    await db.query(migration.sql);
    await pluginRepository.insertAppliedMigration(db, {
      pluginId: plugin.id,
      pluginVersion: plugin.version,
      migrationId: migration.id,
      checksum,
    });
  }

  return pluginRepository.upsertInstall(db, {
    pluginId: plugin.id,
    installedVersion: plugin.version,
    source: opts.source ?? "official",
    actorUserId: opts.actorUserId,
    manifest: {
      id: descriptor.id,
      name: descriptor.name,
      version: descriptor.version,
      source: opts.source ?? "official",
      migrations: (plugin.migrations ?? []).map((migration) => migration.id),
    },
  });
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
