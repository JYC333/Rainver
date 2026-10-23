import { HostSkillScanSchema, type SkillImportPreviewRequest } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { sharedHostConnectionRegistry } from "../hosts/connectionRegistry.js";
import { hostDaemonMeetsMinimumVersion } from "../hosts/daemonCompatibility.js";
import { HttpError, type SpaceUserIdentity } from "../routeUtils/common.js";
import { previewSkillFiles } from "./skillImporter.js";

/** Personal CLI state is owner-only; shared server CLI state is instance-admin-only. */
export async function assertSkillHostAccess(config: ServerConfig, identity: SpaceUserIdentity, hostId: string) {
  if (!config.databaseUrl) throw new HttpError(503, "Host access is unavailable");
  const db = getDbPool(config.databaseUrl);
  const host = (await db.query<{ kind: string; status: string; daemon_version: string | null }>(
    `SELECT kind,status,daemon_version FROM hosts WHERE id=$1 AND status<>'revoked'
      AND (kind='server' OR owner_user_id=$2)`, [hostId, identity.userId])).rows[0];
  if (!host) throw new HttpError(404, "Host not found");
  if (host.kind === "server") {
    const user = (await db.query<{ email: string | null }>("SELECT email FROM users WHERE id=$1 AND status='active'", [identity.userId])).rows[0];
    if (!config.instanceAdminEmail || user?.email?.trim().toLowerCase() !== config.instanceAdminEmail.trim().toLowerCase()) {
      throw new HttpError(403, "Scanning the built-in Host's global Skills requires instance admin");
    }
  }
  if (host.status !== "online") throw new HttpError(409, "The Host is offline; connect it before scanning Skills");
  if (!hostDaemonMeetsMinimumVersion(host.daemon_version)) throw new HttpError(409, "Update the Host daemon before scanning global Skills");
}

export async function scanHostSkillSource(config: ServerConfig, identity: SpaceUserIdentity, hostId: string) {
  await assertSkillHostAccess(config, identity, hostId);
  const result = await sharedHostConnectionRegistry.scanHostSkills(hostId);
  if (!result.ok || !result.result) throw new HttpError(409, result.error ?? "Global Skill scan failed");
  return HostSkillScanSchema.parse(result.result);
}

export async function previewHostSkillSource(config: ServerConfig, identity: SpaceUserIdentity,
  source: Extract<SkillImportPreviewRequest, { host_id: string }>) {
  await assertSkillHostAccess(config, identity, source.host_id);
  const result = await sharedHostConnectionRegistry.readHostSkill(source.host_id, source.skill_id);
  if (!result.ok || !result.files || !result.candidate || result.candidate.id !== source.skill_id) {
    throw new HttpError(409, "The local Skill is unavailable or changed; scan again");
  }
  return previewSkillFiles({ files: result.files, source_type: "local_workspace", source_metadata: {
    origin: "cli_global", host_id: source.host_id, skill_id: source.skill_id,
    runtime_key: result.candidate.runtime_key, installation: result.candidate.installation,
    display_path: result.candidate.display_path,
  } });
}
