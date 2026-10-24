import { createHash } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import type { Queryable } from "../routeUtils/common.js";
import { prepareSkillPackageFiles } from "./skillImporter.js";
import { loadSkillPackageContent } from "./skillPackageContent.js";
import { insertSkillPackageSnapshot } from "./repository.js";

export interface BuiltinSkillPackage {
  key: string;
  version: string;
  files: ReadonlyArray<{ path: string; content_base64: string }>;
}

// D9: no product package ships yet. The sole sample lives in test/support.
export const BUILTIN_SKILL_PACKAGES: readonly BuiltinSkillPackage[] = [];

/** Startup sync; retain the existing per-Space package/binding FK boundary. */
export async function syncBuiltinSkillPackages(
  pool: Pool, packages: readonly BuiltinSkillPackage[] = BUILTIN_SKILL_PACKAGES,
  log: { error(error: unknown, message: string): void } = console,
): Promise<void> {
  if (!packages.length) return;
  const spaces = (await pool.query<{ id: string }>("SELECT id FROM spaces ORDER BY id")).rows;
  for (const space of spaces) {
    for (const pkg of packages) {
      try {
        await withTransaction(pool, db => seedBuiltinSkillPackages(db, space.id, [pkg]));
      } catch (error) {
        log.error(error, `[seeds] builtin Skill sync failed: space=${space.id} package=${pkg.key} version=${pkg.version}`);
      }
    }
  }
}

/** Caller owns the transaction, including when bootstrapping a new Space. Never binds. */
export async function seedBuiltinSkillPackages(
  db: Queryable, spaceId: string, packages: readonly BuiltinSkillPackage[] = BUILTIN_SKILL_PACKAGES,
): Promise<void> {
  for (const pkg of packages) {
    if (!pkg.key.trim() || !pkg.version.trim() || pkg.version.length > 64) {
      throw new Error("Builtin Skill requires a key and a release version (at most 64 characters)");
    }
    const preview = prepareSkillPackageFiles({ files: [...pkg.files], source_type: "builtin",
      source_metadata: { builtin_key: pkg.key, release_version: pkg.version } });
    if (preview.normalized_skill.version !== pkg.version) throw new Error("Builtin Skill release version must match SKILL.md");
    const packageId = builtinId("package", spaceId, pkg);
    const sourceId = builtinId("source", spaceId, pkg);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`builtin-skill:${packageId}`]);
    const existing = (await db.query<{ package_hash: string }>(
      "SELECT manifest_json->>'package_hash' AS package_hash FROM skill_packages WHERE id=$1 AND space_id=$2",
      [packageId, spaceId],
    )).rows[0];
    if (existing) {
      if (existing.package_hash !== preview.package_hash) throw new Error("Builtin Skill version is immutable; publish a new version for changed bytes");
      await loadSkillPackageContent(db, spaceId, packageId, false);
      continue;
    }
    await insertSkillPackageSnapshot({ db, spaceId, userId: null, sourceId, packageId,
      status: "reviewed", preview });
  }
}

function builtinId(kind: "source" | "package", spaceId: string, pkg: BuiltinSkillPackage): string {
  const hash = createHash("sha256").update(JSON.stringify(["builtin-skill", kind, spaceId, pkg.key, pkg.version])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
