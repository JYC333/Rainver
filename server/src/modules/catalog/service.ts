/**
 * Catalog module service — reads built-in definitions from the top-level
 * `catalog/` directory (capability manifests and agent role specs).
 *
 * This is the raw catalog read surface: which definition files exist on disk
 * and their declared summary fields. The parser applies no business policy
 * beyond skipping missing directories. The Skill library does not read
 * this catalog. `/api/v1/agent-roles` reads `catalog/agent_roles`
 * on its own.
 *
 * Read-only. A missing catalog directory is reported as
 * `catalog_available: false` with empty items, never an error — the control
 * plane must not fail because a deployment chose not to ship the catalog. An
 * unreadable directory is an error; an oversized or non-regular manifest is
 * listed with `parse_error`.
 */

import { lstat, readdir } from "node:fs/promises";
import { openFileBeneathRoot, readHandleBounded } from "@rainver/folder-read";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";

export interface CatalogCapabilitySummary {
  id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  enabled: boolean | null;
  parse_error?: true;
}

export interface CatalogAgentRoleSummary {
  key: string;
  name: string | null;
  category: string | null;
  visibility: string | null;
  description: string | null;
  parse_error?: true;
}

export interface CatalogListBody<TItem> {
  catalog_available: boolean;
  items: TItem[];
}

export interface CatalogSummaryBody {
  catalog_available: boolean;
  capabilities_count: number;
  agent_roles_count: number;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function asOptionalBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

interface ManifestDir {
  dirName: string;
  manifestPath: string;
}

/** Real manifests are a few KiB; anything far larger is not read or parsed. */
export const CATALOG_MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * Directories under `root` that contain `manifestName` as a regular file (a
 * symlinked directory or manifest is not followed out of the catalog). Plain
 * files and noise directories without a manifest (e.g. `__pycache__`) are
 * skipped. A missing `root` yields `available: false`; any other read error
 * is an error, not an absent catalog.
 */
async function listManifestDirs(
  root: string,
  manifestName: string,
): Promise<{ available: boolean; dirs: ManifestDir[] }> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { available: false, dirs: [] };
    throw error;
  }
  const dirs: ManifestDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, manifestName);
    try {
      const info = await lstat(manifestPath);
      if (info.isFile()) dirs.push({ dirName: entry.name, manifestPath });
    } catch {
      // No manifest in this directory — not a catalog entry.
    }
  }
  dirs.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return { available: true, dirs };
}

async function parseManifest(manifestPath: string): Promise<Record<string, unknown> | null> {
  // The one read is bounded on the handle it opened, which follows no link
  // below the catalog entry's directory; type and size are checked there too.
  const file = await openFileBeneathRoot(dirname(manifestPath), [basename(manifestPath)]);
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > CATALOG_MANIFEST_MAX_BYTES) throw new Error("manifest is not a bounded regular file");
    const bytes = await readHandleBounded(file, CATALOG_MANIFEST_MAX_BYTES);
    if (!bytes) throw new Error("manifest grew past its bound");
    text = bytes.toString("utf8");
  } finally {
    await file.close();
  }
  const doc: unknown = parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  return doc as Record<string, unknown>;
}

export async function listCapabilities(
  catalogRoot: string,
): Promise<CatalogListBody<CatalogCapabilitySummary>> {
  const { available, dirs } = await listManifestDirs(
    join(catalogRoot, "capabilities"),
    "capability.yaml",
  );
  const items: CatalogCapabilitySummary[] = [];
  for (const { dirName, manifestPath } of dirs) {
    try {
      const doc = await parseManifest(manifestPath);
      if (doc === null) throw new Error("manifest is not a mapping");
      items.push({
        id: asOptionalString(doc.id) ?? dirName,
        name: asOptionalString(doc.name),
        version: asOptionalString(doc.version),
        description: asOptionalString(doc.description),
        enabled: asOptionalBool(doc.enabled),
      });
    } catch {
      items.push({
        id: dirName,
        name: null,
        version: null,
        description: null,
        enabled: null,
        parse_error: true,
      });
    }
  }
  return { catalog_available: available, items };
}

export async function listAgentRoles(
  catalogRoot: string,
): Promise<CatalogListBody<CatalogAgentRoleSummary>> {
  const { available, dirs } = await listManifestDirs(
    join(catalogRoot, "agent_roles"),
    "role.yaml",
  );
  const items: CatalogAgentRoleSummary[] = [];
  for (const { dirName, manifestPath } of dirs) {
    try {
      const doc = await parseManifest(manifestPath);
      if (doc === null) throw new Error("manifest is not a mapping");
      items.push({
        key: asOptionalString(doc.key) ?? dirName,
        name: asOptionalString(doc.name),
        category: asOptionalString(doc.category),
        visibility: asOptionalString(doc.visibility),
        description: asOptionalString(doc.description),
      });
    } catch {
      items.push({
        key: dirName,
        name: null,
        category: null,
        visibility: null,
        description: null,
        parse_error: true,
      });
    }
  }
  return { catalog_available: available, items };
}

/** Counts entries exactly as the lists do (a parse error still lists), without parsing them. */
export async function catalogSummary(catalogRoot: string): Promise<CatalogSummaryBody> {
  const [capabilities, roles] = await Promise.all([
    listManifestDirs(join(catalogRoot, "capabilities"), "capability.yaml"),
    listManifestDirs(join(catalogRoot, "agent_roles"), "role.yaml"),
  ]);
  return {
    catalog_available: capabilities.available || roles.available,
    capabilities_count: capabilities.dirs.length,
    agent_roles_count: roles.dirs.length,
  };
}
