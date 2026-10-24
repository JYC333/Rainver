import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { loadMigrations, migrate } from "../src/db/migrator.js";
import { useTestDatabase } from "./support/testDatabase.js";

const db = useTestDatabase(import.meta.filename, { empty: true });

it("upgrades converted Skill content to reviewed and drops only the retired capability tables", async () => {
  if (!db.available) return;
  const directory = join(process.cwd(), "migrations");
  const prefix = mkdtempSync(join(tmpdir(), "rainver-pre-capability-removal-"));
  try {
    for (const migration of loadMigrations(directory).filter(migration => migration.version < "0004")) {
      cpSync(migration.path, join(prefix, `${migration.version}_${migration.name}.sql`));
    }
    await migrate(db.pool, prefix);
    const source = randomUUID(), pkg = randomUUID(), file = randomUUID(), space = randomUUID();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at)
      VALUES ($1,'Legacy proposals','personal',now(),now())`, [space]);
    const retiredTypes = ["capability_install", "capability_update", "capability_enable", "capability_disable"];
    const pendingIds = retiredTypes.map(() => randomUUID());
    const acceptedId = randomUUID(), rejectedId = randomUUID(), reviewId = randomUUID();
    for (const [id, type, status] of [
      ...retiredTypes.map((type, index) => [pendingIds[index], type, "pending"]),
      [acceptedId, "capability_install", "accepted"],
      [rejectedId, "capability_update", "rejected"],
      [reviewId, "skill_import_approve", "pending"],
    ]) {
      await db.pool.query(`INSERT INTO proposals
        (id,space_id,proposal_type,status,risk_level,urgency,title,payload_json,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'medium','normal','Legacy proposal','{"original":true}',now(),now())`, [id, space, type, status]);
    }
    const resultProposal = randomUUID();
    await db.pool.query(`INSERT INTO proposals
      (id,space_id,proposal_type,status,risk_level,urgency,title,payload_json,created_at,updated_at)
      VALUES ($1,$2,'runtime_skill_binding_update','accepted','medium','normal','Legacy result',
        '{"result_type":"capability_overlay","original":true}',now(),now())`, [resultProposal, space]);
    const targetTypes = ["capability", "runtime_skill_binding", "agent_version", "memory", "knowledge", "workflow", "project_folder", "system"];
    for (const type of targetTypes) {
      await db.pool.query(`INSERT INTO evolution_targets
        (id,space_id,target_type,risk_level,status,enabled,engine_policy_json,metadata_json,created_at,updated_at)
        VALUES ($1,$2,$3,'low','active',true,'{}','{"original":true}',now(),now())`, [randomUUID(), space, type]);
      await db.pool.query(`INSERT INTO evolution_strategy_assets
        (id,space_id,strategy_key,name,category,target_type,status,risk_level,provenance_type,source_ref_json,created_at,updated_at)
        VALUES ($1,$2,$3,$3,'repair',$3,'active','low','user_authored','{"original":true}',now(),now())`, [randomUUID(), space, type]);
    }
    // The old targets API accepted arbitrary strings; strategy assets already
    // had a type constraint, so only targets can contain this legacy kind.
    const customTarget = randomUUID();
    await db.pool.query(`INSERT INTO evolution_targets
      (id,space_id,target_type,risk_level,status,enabled,engine_policy_json,metadata_json,created_at,updated_at)
      VALUES ($1,$2,'custom_legacy_type','low','active',true,'{}','{"original":true}',now(),now())`, [customTarget, space]);
    const legacyAsset = randomUUID(), workflowAsset = randomUUID();
    for (const [id, type] of [[legacyAsset, "runtime_skill_binding"], [workflowAsset, "workflow_template"]]) {
      await db.pool.query(`INSERT INTO evolvable_assets
        (id,space_id,asset_type,asset_key,display_name,owner_scope_type,owner_scope_id,status,metadata_json,created_at,updated_at)
        VALUES ($1,$2,$3,$3,$3,'space',$2,'active','{"original":true}',now(),now())`, [id, space, type]);
      const version = randomUUID();
      await db.pool.query(`INSERT INTO evolvable_asset_versions
        (id,asset_id,space_id,scope_type,scope_id,version,status,source,content_json,created_at,updated_at)
        VALUES ($1,$2,$3,'space',$3,1,'approved','user_authored','{"original":true}',now(),now())`, [version, id, space]);
      await db.pool.query(`INSERT INTO evolvable_asset_pins
        (id,space_id,asset_id,scope_type,scope_id,version_id,status,created_at,updated_at)
        VALUES ($1,$2,$3,'space',$2,$4,'active',now(),now())`, [randomUUID(), space, id, version]);
    }
    await db.pool.query(`INSERT INTO skill_sources (id,source_type,content_hash,fetched_at,created_at)
      VALUES ($1,'upload','original',now(),now())`, [source]);
    await db.pool.query(`INSERT INTO skill_packages (id,source_id,package_name,risk_level,status,created_at,updated_at)
      VALUES ($1,$2,'original','low','converted',now(),now())`, [pkg, source]);
    await db.pool.query(`INSERT INTO skill_package_files (id,skill_package_id,path,kind,content_base64,created_at)
      VALUES ($1,$2,'SKILL.md','skill_markdown','b3JpZ2luYWw=',now())`, [file, pkg]);
    expect((await migrate(db.pool, directory)).applied).toEqual(["0004"]);
    for (const table of ["evolution_targets", "evolution_strategy_assets"]) {
      const rows = (await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`, [space])).rows;
      expect(rows).toHaveLength(targetTypes.length + (table === "evolution_targets" ? 1 : 0));
      for (const row of rows) {
        if (targetTypes.slice(0, 2).includes(row.target_type) || row.id === customTarget) {
          expect(row.status).toBe("archived");
          expect(row.metadata_json ?? row.source_ref_json).toMatchObject({ original: true, archive_reason: expect.any(String) });
          if (table === "evolution_targets") expect(row.enabled).toBe(false);
          await expect(db.pool.query(`UPDATE ${table} SET status='active' WHERE id=$1`, [row.id]))
            .rejects.toMatchObject({ code: "23514" });
        } else {
          expect(row.status).toBe("active");
          expect(row.metadata_json ?? row.source_ref_json).toEqual({ original: true });
        }
      }
    }
    expect((await db.pool.query(`SELECT target_type,status,enabled,metadata_json
      FROM evolution_targets WHERE id=$1`, [customTarget])).rows[0]).toMatchObject({
      target_type: "custom_legacy_type", status: "archived", enabled: false,
      metadata_json: { original: true, archive_reason: expect.stringContaining("Unsupported Evolution target type"),
        archived_by_migration: "0005_retire_evolution_targets_and_rename_skills" },
    });
    for (const [id, status, versionStatus] of [[legacyAsset, "archived", "archived"], [workflowAsset, "active", "approved"]]) {
      expect((await db.pool.query(`SELECT status FROM evolvable_assets WHERE id=$1`, [id])).rows[0]?.status).toBe(status);
      expect((await db.pool.query(`SELECT status FROM evolvable_asset_pins WHERE asset_id=$1`, [id])).rows[0]?.status).toBe(status);
      expect((await db.pool.query(`SELECT status,content_json FROM evolvable_asset_versions WHERE asset_id=$1`, [id])).rows[0])
        .toEqual({ status: versionStatus, content_json: { original: true } });
    }
    expect((await db.pool.query(`SELECT status,payload_json FROM proposals WHERE id=$1`, [resultProposal])).rows[0])
      .toEqual({ status: "accepted", payload_json: { original: true, result_type: "skill_overlay" } });
    expect((await db.pool.query("SELECT status FROM skill_packages WHERE id=$1", [pkg])).rows[0]?.status).toBe("reviewed");
    expect((await db.pool.query("SELECT content_base64 FROM skill_package_files WHERE id=$1", [file])).rows[0]?.content_base64).toBe("b3JpZ2luYWw=");
    const tables = await db.pool.query(`SELECT to_regclass('capability_versions') AS versions,
      to_regclass('capability_enablements') AS enablements, to_regclass('capability_runtime_bindings') AS bindings`);
    expect(tables.rows[0]).toEqual({ versions: null, enablements: null, bindings: null });
    const retired = (await db.pool.query(`SELECT status,payload_json,reviewed_by FROM proposals WHERE id=ANY($1::text[])`, [pendingIds])).rows;
    expect(retired).toHaveLength(4);
    for (const proposal of retired) {
      expect(proposal).toMatchObject({ status: "superseded", reviewed_by: null,
        payload_json: { original: true, superseded_by_migration: "0004_remove_capability_layer" } });
      expect(proposal.payload_json.superseded_reason).toContain("Capability layer removed");
    }
    for (const [id, status] of [[acceptedId, "accepted"], [rejectedId, "rejected"], [reviewId, "pending"]]) {
      expect((await db.pool.query(`SELECT status,payload_json FROM proposals WHERE id=$1`, [id])).rows[0])
        .toEqual({ status, payload_json: { original: true } });
    }
    await expect(db.pool.query("UPDATE skill_packages SET status='converted' WHERE id=$1", [pkg])).rejects.toMatchObject({ code: "23514" });
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
