import { randomUUID } from "node:crypto";
import { PromptAssetContentSchema } from "@agent-space/protocol";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { PromptAssetContent } from "@agent-space/protocol";
import { HttpError, optionalString, type Queryable } from "../routeUtils/common.js";
import { sha256Json, stableJsonStringify } from "./hash.js";

const PROMPT_ASSET_TYPE = "prompt_template";

export interface PromptManifest {
  assetKey: string;
  displayName: string;
  description: string | null;
  content: PromptAssetContent;
  contentHash: string;
  sourcePath: string;
}

/**
 * Loads and validates every catalog/prompts/*.yaml manifest. Throws on the
 * first invalid file (duplicate asset_key, missing required field, or
 * content that does not match prompt_asset.v1) — sync must fail closed
 * rather than register a partial or malformed baseline.
 */
export async function loadPromptManifests(catalogRoot: string): Promise<PromptManifest[]> {
  const dir = join(catalogRoot, "prompts");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const manifests: PromptManifest[] = [];
  const seenKeys = new Set<string>();
  for (const file of files.sort()) {
    const sourcePath = join(dir, file);
    const raw = parse(await readFile(sourcePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(500, `Invalid prompt manifest ${sourcePath}: expected a YAML mapping`);
    }
    const doc = raw as Record<string, unknown>;

    const assetKey = optionalString(doc.asset_key);
    if (!assetKey) throw new HttpError(500, `Invalid prompt manifest ${sourcePath}: asset_key is required`);
    if (seenKeys.has(assetKey)) {
      throw new HttpError(500, `Duplicate prompt asset_key '${assetKey}' (${sourcePath})`);
    }
    seenKeys.add(assetKey);

    const displayName = optionalString(doc.display_name);
    if (!displayName) throw new HttpError(500, `Invalid prompt manifest ${sourcePath}: display_name is required`);

    const parsedContent = PromptAssetContentSchema.safeParse(doc.content);
    if (!parsedContent.success) {
      throw new HttpError(
        500,
        `Invalid prompt manifest ${sourcePath}: content does not match prompt_asset.v1 (${parsedContent.error.message})`,
      );
    }

    manifests.push({
      assetKey,
      displayName,
      description: optionalString(doc.description),
      content: parsedContent.data,
      contentHash: sha256Json(parsedContent.data),
      sourcePath,
    });
  }
  return manifests;
}

export interface PromptSyncResult {
  assetKeys: string[];
  versionsCreated: string[];
}

/**
 * Idempotent built-in prompt sync: ensures every manifest has a matching
 * system-scope (space_id NULL) evolvable asset, and adds a new immutable
 * 'approved' 'built_in' version whenever the manifest content_hash changes.
 * Existing versions are never overwritten. Callable from a bootstrap script
 * or tests — not wired into automatic server startup, so it never changes
 * runtime behavior on its own (no prompt consumer resolves through this
 * registry yet; that migration starts at M3).
 *
 * Built-in versions are written with status='approved' directly, bypassing
 * EvolvableAssetRepository's proposal-gated promotion path: that gate exists
 * for user-facing edits, whereas built-in prompt review already happened as
 * a normal source-control change to the manifest file (see the plan's
 * Permission Boundaries: "System baseline prompt changes should be treated
 * as code/catalog changes"). This mirrors server/src/db/seeds.ts, which
 * seeds other built-in tables the same way.
 */
export async function syncBuiltinPrompts(db: Queryable, catalogRoot: string): Promise<PromptSyncResult> {
  const manifests = await loadPromptManifests(catalogRoot);
  const result: PromptSyncResult = { assetKeys: [], versionsCreated: [] };
  for (const manifest of manifests) {
    await upsertBuiltinAsset(db, manifest);
    result.assetKeys.push(manifest.assetKey);
    if (await ensureBuiltinVersion(db, manifest)) {
      result.versionsCreated.push(manifest.assetKey);
    }
  }
  return result;
}

async function upsertBuiltinAsset(db: Queryable, manifest: PromptManifest): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO evolvable_assets (
       id, space_id, asset_type, asset_key, display_name, description, owner_scope_type, owner_scope_id,
       status, metadata_json, created_at, updated_at
     ) VALUES ($1, NULL, $2, $3, $4, $5, 'system', NULL, 'active', $6::jsonb, $7, $7)
     ON CONFLICT (asset_key) WHERE space_id IS NULL DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       -- Merge, don't overwrite: a future write path (M4+) may add metadata
       -- keys sync doesn't manage (e.g. allow_user_override); re-syncing must
       -- not silently discard them. Sync's own key (prompt_type) still wins.
       metadata_json = COALESCE(evolvable_assets.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
       updated_at = EXCLUDED.updated_at
     WHERE evolvable_assets.asset_type = EXCLUDED.asset_type`,
    [
      randomUUID(),
      PROMPT_ASSET_TYPE,
      manifest.assetKey,
      manifest.displayName,
      manifest.description,
      JSON.stringify({ prompt_type: manifest.content.prompt_type }),
      now,
    ],
  );
}

async function ensureBuiltinVersion(db: Queryable, manifest: PromptManifest): Promise<boolean> {
  const asset = await assetForKey(db, manifest.assetKey);
  if (!asset) throw new HttpError(500, `Prompt asset '${manifest.assetKey}' was not created before version sync`);

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM evolvable_asset_versions WHERE asset_id = $1 AND content_hash = $2 LIMIT 1`,
    [asset.id, manifest.contentHash],
  );
  const existingVersionId = existing.rows[0]?.id ?? null;
  if (existingVersionId) {
    // A version with this exact content already exists (e.g. the manifest
    // was reverted to a prior state, or a previous sync run was interrupted
    // between creating the version and repointing the asset below). Never
    // create a duplicate version for content that already has one — just
    // make sure the asset's baseline pointer isn't left stale.
    if (existingVersionId !== asset.currentSystemVersionId) {
      await db.query(`UPDATE evolvable_assets SET current_system_version_id = $2, updated_at = $3 WHERE id = $1`, [
        asset.id,
        existingVersionId,
        new Date().toISOString(),
      ]);
    }
    await ensureSystemProductionDeploymentRef(db, asset.id, existingVersionId);
    return false;
  }

  const nextVersionResult = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM evolvable_asset_versions WHERE asset_id = $1`,
    [asset.id],
  );
  const nextVersion = nextVersionResult.rows[0]?.next ?? 1;
  const versionId = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO evolvable_asset_versions (
       id, asset_id, space_id, scope_type, scope_id, version, status, source,
       content_hash, content_json, created_at, updated_at
     ) VALUES ($1, $2, NULL, 'system', NULL, $3, 'approved', 'built_in', $4, $5::jsonb, $6, $6)`,
    [versionId, asset.id, nextVersion, manifest.contentHash, stableJsonStringify(manifest.content), now],
  );
  await db.query(`UPDATE evolvable_assets SET current_system_version_id = $2, updated_at = $3 WHERE id = $1`, [
    asset.id,
    versionId,
    now,
  ]);
  await ensureSystemProductionDeploymentRef(db, asset.id, versionId);
  return true;
}

async function ensureSystemProductionDeploymentRef(db: Queryable, assetId: string, versionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `UPDATE prompt_deployment_refs
        SET status = 'archived', updated_at = $3
      WHERE asset_id = $1
        AND scope_type = 'system'
        AND scope_id IS NULL
        AND label = 'production'
        AND status = 'active'
        AND version_id <> $2`,
    [assetId, versionId, now],
  );
  await db.query(
    `INSERT INTO prompt_deployment_refs (
       id, space_id, asset_id, scope_type, scope_id, label, version_id, status,
       promoted_by_user_id, promoted_from_proposal_id, created_at, updated_at
     )
     SELECT $1::varchar, NULL::varchar, $2::varchar, 'system', NULL::varchar, 'production', $3::varchar, 'active', NULL::varchar, NULL::varchar, $4::timestamptz, $4::timestamptz
      WHERE NOT EXISTS (
        SELECT 1
          FROM prompt_deployment_refs
         WHERE asset_id = $2::varchar
           AND scope_type = 'system'
           AND scope_id IS NULL
           AND label = 'production'
           AND status = 'active'
           AND version_id = $3::varchar
      )`,
    [randomUUID(), assetId, versionId, now],
  );
}

async function assetForKey(
  db: Queryable,
  assetKey: string,
): Promise<{ id: string; currentSystemVersionId: string | null } | null> {
  const result = await db.query<{ id: string; current_system_version_id: string | null }>(
    `SELECT id, current_system_version_id FROM evolvable_assets WHERE asset_key = $1 AND asset_type = $2 AND space_id IS NULL LIMIT 1`,
    [assetKey, PROMPT_ASSET_TYPE],
  );
  const row = result.rows[0];
  return row ? { id: row.id, currentSystemVersionId: row.current_system_version_id } : null;
}
