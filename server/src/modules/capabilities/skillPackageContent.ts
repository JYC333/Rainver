import { createHash } from "node:crypto";
import type { SkillPackageContent } from "@rainver/protocol";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { assertSkillPackagePaths } from "./skillPackagePaths.js";

/** Original bytes are the only authority for delivery; legacy normalized data is never a fallback. */
export async function loadSkillPackageContent(
  db: Queryable, spaceId: string, packageId: string, reviewedOnly = true,
): Promise<SkillPackageContent> {
  const row = (await db.query<{
    id: string; package_name: string; status: string; package_hash: string; package_root: string;
  }>(`SELECT id, package_name, status, manifest_json->>'package_hash' AS package_hash,
              manifest_json->>'package_root' AS package_root
         FROM skill_packages WHERE id=$1 AND space_id=$2 FOR SHARE`, [packageId, spaceId])).rows[0];
  if (!row) throw new HttpError(404, "Skill package not found");
  if (reviewedOnly && row.status !== "reviewed" && row.status !== "converted") {
    throw new HttpError(409, "Skill package must be reviewed before use");
  }
  const files = (await db.query<{
    path: string; kind: string; content_base64: string | null; content_hash: string | null;
    byte_length: number | null; included: boolean; executable: boolean;
  }>(`SELECT path,kind,content_base64,content_hash,byte_length,included,executable
        FROM skill_package_files WHERE skill_package_id=$1 ORDER BY path`, [packageId])).rows;
  if (files.length === 0 || files.length > 200 || files.some(file => file.content_base64 === null || !file.included)) {
    throw new HttpError(409, "Skill package has no complete original files; import it again");
  }
  let total = 0;
  assertSkillPackagePaths(files.map(file => file.path));
  for (const file of files) {
    const bytes = Buffer.from(file.content_base64!, "base64");
    total += bytes.length;
    if (bytes.length > 256 * 1024 || total > 2 * 1024 * 1024
      || bytes.toString("base64") !== file.content_base64 || bytes.length !== file.byte_length
      || createHash("sha256").update(bytes).digest("hex") !== file.content_hash) {
      throw new HttpError(409, "Skill package content integrity check failed");
    }
  }
  const inventoryHash = createHash("sha256").update(JSON.stringify(files.map(file => ({
    path: file.path, kind: file.kind, content_hash: file.content_hash,
    byte_length: file.byte_length, included: file.included,
  })).sort((a, b) => a.path.localeCompare(b.path)))).digest("hex");
  if (inventoryHash !== row.package_hash) throw new HttpError(409, "Skill package manifest integrity check failed");
  const prefix = row.package_root && row.package_root !== "." ? `${row.package_root}/` : "";
  const content = files.map(file => {
    if (!file.path.startsWith(prefix)) throw new HttpError(409, "Skill package root mismatch");
    const path = file.path.slice(prefix.length);
    if (!path || /[\\\0:]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new HttpError(409, "Skill package path is invalid");
    }
    return { path, content_base64: file.content_base64!, content_hash: file.content_hash!, executable: file.executable };
  });
  if (!content.some(file => file.path === "SKILL.md")) throw new HttpError(409, "Skill package entrypoint is missing");
  return { skill_package_id: row.id, package_name: row.package_name, package_hash: row.package_hash, files: content };
}
