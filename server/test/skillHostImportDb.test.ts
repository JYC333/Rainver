import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedServerHost, seedSpaceMember } from "./support/domainSeeds.js";
import { scanHostSkillSource, previewHostSkillSource } from "../src/modules/skills/skillHostImport.js";
import { sharedHostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { MIN_HOST_DAEMON_VERSION } from "../src/modules/hosts/daemonCompatibility.js";
import { loadConfig } from "../src/config.js";
import { SkillsService } from "../src/modules/skills/service.js";
import { PgSkillsRepository } from "../src/modules/skills/repository.js";

const db = useTestDatabase(import.meta.filename);
const identity = { spaceId: "skill-space", userId: "skill-owner" };
const candidate = { id: "a".repeat(64), name: "global", runtime_key: "claude_code" as const, installation: "own", display_path: "~/.claude/skills/global" };
const files = [{ path: "SKILL.md", content_base64: Buffer.from("---\nname: global\ndescription: An original local Skill.\n---\nRead me.").toString("base64") }];
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users", "hosts", "machines"], { cascade: true });
  await db.pool.query("INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Skills','personal',now(),now())", [identity.spaceId]);
  await seedSpaceMember(db.pool, { space: identity.spaceId, user: identity.userId, role: "owner" });
  await seedServerHost(db.pool, { id: "skill-host" });
  await db.pool.query("UPDATE hosts SET kind='remote',owner_user_id=$1,daemon_version=$2 WHERE id='skill-host'", [identity.userId, MIN_HOST_DAEMON_VERSION]);
});
afterEach(() => { vi.restoreAllMocks() });
describe("global Skill acquisition authorization (PostgreSQL)", () => {
  it("refuses other owners, offline and outdated Hosts before sending any read", async () => {
    if (!db.available) return;
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const scan = vi.spyOn(sharedHostConnectionRegistry, "scanHostSkills");
    await expect(scanHostSkillSource(config, { ...identity, userId: randomUUID() }, "skill-host")).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query("UPDATE hosts SET status='offline' WHERE id='skill-host'");
    await expect(scanHostSkillSource(config, identity, "skill-host")).rejects.toMatchObject({ statusCode: 409 });
    await db.pool.query("UPDATE hosts SET status='online',daemon_version='0.4.2' WHERE id='skill-host'");
    await expect(scanHostSkillSource(config, identity, "skill-host")).rejects.toMatchObject({ statusCode: 409 });
    expect(scan).not.toHaveBeenCalled();
  });
  it("previews and imports exact owner-selected bytes, rechecking the hash on acquisition", async () => {
    if (!db.available) return;
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    vi.spyOn(sharedHostConnectionRegistry, "scanHostSkills").mockResolvedValue({ ok: true, result: { items: [candidate], truncated: false, warnings: [] }, error: null });
    const read = vi.spyOn(sharedHostConnectionRegistry, "readHostSkill").mockResolvedValue({ ok: true, candidate, files, error: null });
    expect((await scanHostSkillSource(config, identity, "skill-host")).items).toEqual([candidate]);
    const source = { source_type: "local_workspace" as const, host_id: "skill-host", skill_id: candidate.id };
    const preview = await previewHostSkillSource(config, identity, source);
    expect(preview.package_contents?.["SKILL.md"]).toBe(files[0]!.content_base64);
    const service = new SkillsService(new PgSkillsRepository(db.pool), undefined, config);
    const imported = await service.importSkill(identity, { ...source, package_hash: preview.package_hash });
    expect(imported.status).toBe("imported");
    expect((await db.pool.query("SELECT content_base64 FROM skill_package_files WHERE skill_package_id=$1", [imported.id])).rows[0]?.content_base64).toBe(files[0]!.content_base64);
    read.mockResolvedValueOnce({ ok: true, candidate, files: [{ path: "SKILL.md", content_base64: Buffer.from("---\nname: changed\ndescription: changed\n---\nNew bytes").toString("base64") }], error: null });
    await expect(service.importSkill(identity, { ...source, package_hash: preview.package_hash })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("requires instance admin before reading the shared built-in Host's CLI state", async () => {
    if (!db.available) return;
    await db.pool.query("UPDATE hosts SET kind='server',owner_user_id=NULL WHERE id='skill-host'");
    await expect(scanHostSkillSource(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), identity, "skill-host")).rejects.toMatchObject({ statusCode: 403 });
  });
});
