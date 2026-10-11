/**
 * Catalog module service — reads built-in definitions from the top-level
 * `catalog/` directory (capability manifests and agent template specs).
 *
 * This is the raw catalog read surface: which definition files exist on disk
 * and their declared summary fields. The parser applies no business policy
 * beyond skipping missing directories. Product capability pages do not read
 * this catalog. `/api/v1/agent-templates` reads `catalog/agent_templates`
 * on its own.
 *
 * Read-only. A missing catalog directory is reported as
 * `catalog_available: false` with empty items, never an error — the control
 * plane must not fail because a deployment chose not to ship the catalog.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface CatalogCapabilitySummary {
  id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  enabled: boolean | null;
  parse_error?: true;
}

export interface CatalogAgentTemplateSummary {
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
  agent_templates_count: number;
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

/**
 * Directories under `root` that contain `manifestName`. Plain files and noise
 * directories without a manifest (e.g. `__pycache__`) are skipped. A missing
 * `root` yields `available: false`.
 */
async function listManifestDirs(
  root: string,
  manifestName: string,
): Promise<{ available: boolean; dirs: ManifestDir[] }> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { available: false, dirs: [] };
  }
  const dirs: ManifestDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, manifestName);
    try {
      const info = await stat(manifestPath);
      if (info.isFile()) dirs.push({ dirName: entry.name, manifestPath });
    } catch {
      // No manifest in this directory — not a catalog entry.
    }
  }
  dirs.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return { available: true, dirs };
}

async function parseManifest(manifestPath: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(manifestPath, "utf8");
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

export async function listAgentTemplates(
  catalogRoot: string,
): Promise<CatalogListBody<CatalogAgentTemplateSummary>> {
  const { available, dirs } = await listManifestDirs(
    join(catalogRoot, "agent_templates"),
    "template.yaml",
  );
  const items: CatalogAgentTemplateSummary[] = [];
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

export async function catalogSummary(catalogRoot: string): Promise<CatalogSummaryBody> {
  const [capabilities, templates] = await Promise.all([
    listCapabilities(catalogRoot),
    listAgentTemplates(catalogRoot),
  ]);
  return {
    catalog_available: capabilities.catalog_available || templates.catalog_available,
    capabilities_count: capabilities.items.length,
    agent_templates_count: templates.items.length,
  };
}
