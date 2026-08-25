import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ContentAccessAuditService } from "../src/modules/contentAccess/audit";
import { ContentDemotionService } from "../src/modules/contentAccess/demotion";
import { ContentAccessService } from "../src/modules/contentAccess/service";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DERIVED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VERSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RUN = "99999999-9999-4999-8999-999999999999";
const SNAPSHOT = "88888888-8888-4888-8888-888888888888";
const DELIVERY = "77777777-7777-4777-8777-777777777777";
const CONTROL = "66666666-6666-4666-8666-666666666666";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["content_demotion_disclosures", "content_access_logs", "invocation_snapshots", "invocation_deliveries", "execution_control_snapshots", "artifacts", "runs", "agent_versions", "agents", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  for (const [id, name] of [[OWNER, "Owner"], [VIEWER, "Viewer"]]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [id, name],
    );
  }
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Team', 'team', $2, now(), now())`,
    [SPACE, OWNER],
  );
  for (const userId of [OWNER, VIEWER]) {
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, userId],
    );
  }
  await db.pool.query(
    `INSERT INTO artifacts
       (id, space_id, artifact_type, title, export_formats_json, visibility,
        access_level, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'note', 'Source', '[]'::jsonb, 'space_shared', 'full', $3, now(), now())`,
    [SOURCE, SPACE, OWNER],
  );
});

describe("content after-the-fact defences (real PostgreSQL)", () => {
  it("writes no row for an owner read and exactly one row for a cross-person read", async () => {
    if (!db.available) return;
    const audit = new ContentAccessAuditService(db.pool);
    expect(await audit.recordReads({
      spaceId: SPACE,
      resourceType: "artifact",
      resourceIds: [SOURCE],
      viewerUserId: OWNER,
      accessType: "explicit_read",
    })).toBe(0);
    expect(await audit.recordReads({
      spaceId: SPACE,
      resourceType: "artifact",
      resourceIds: [SOURCE, SOURCE],
      viewerUserId: VIEWER,
      accessType: "explicit_read",
    })).toBe(1);

    const rows = await db.pool.query(
      `SELECT resource_type, resource_id, owner_user_id, viewer_user_id
         FROM content_access_logs`,
    );
    expect(rows.rows).toEqual([{
      resource_type: "artifact",
      resource_id: SOURCE,
      owner_user_id: OWNER,
      viewer_user_id: VIEWER,
    }]);
    await expect(audit.listForOwner({
      spaceId: SPACE,
      resourceType: "artifact",
      resourceId: SOURCE,
      ownerUserId: VIEWER,
      limit: 50,
      offset: 0,
    })).rejects.toMatchObject({ statusCode: 404 });
    const ownerView = await audit.listForOwner({
      spaceId: SPACE,
      resourceType: "artifact",
      resourceId: SOURCE,
      ownerUserId: OWNER,
      limit: 50,
      offset: 0,
    });
    expect(ownerView.items).toEqual([
      expect.objectContaining({ viewer_user_id: VIEWER, viewer_display_name: "Viewer" }),
    ]);
  });

  it("discloses consuming Runs and derived outputs that remain shared", async () => {
    if (!db.available) return;
    await db.pool.query(
      `INSERT INTO agents
         (id, space_id, owner_user_id, name, status, visibility, access_level, created_at, updated_at)
       VALUES ($1,$2,$3,'Agent','active','private','full',now(),now())`,
      [AGENT, SPACE, OWNER],
    );
    await db.pool.query(
      `INSERT INTO agent_versions
         (id, agent_id, space_id, version_label, model_config_json, runtime_config_json,
          context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json,
          runtime_policy_json, created_at)
       VALUES ($1,$2,$3,'v1','{}','{}','{}','{}','[]','[]','{}',now())`,
      [VERSION, AGENT, SPACE],
    );
    await db.pool.query(
      `INSERT INTO runs
         (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status,
          mode, created_at, updated_at, owner_user_id, visibility, access_level)
       VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',now(),now(),$5,'private','full')`,
      [RUN, SPACE, AGENT, VERSION, OWNER],
    );
    await db.pool.query(
      `INSERT INTO execution_control_snapshots (id,space_id,run_id,snapshot_json,created_at)
       VALUES ($1,$2,$3,'{}'::jsonb,now())`,
      [CONTROL, SPACE, RUN],
    );
    await db.pool.query(
      `INSERT INTO invocation_deliveries
         (id,space_id,invocation_id,attempt,execution_control_snapshot_id,adapter_type,renderer_version,delivery_metadata_json,created_at)
       VALUES ($1,$2,$3,1,$4,'model_api','test.v1','{}'::jsonb,now())`,
      [DELIVERY, SPACE, RUN, CONTROL],
    );
    await db.pool.query(
      `INSERT INTO invocation_snapshots
         (id,space_id,invocation_id,delivery_id,attempt,safe_snapshot_json,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,1,$5::jsonb,'accepted',now(),now())`,
      [SNAPSHOT, SPACE, RUN, DELIVERY, JSON.stringify({ source_refs: [{ type: "artifact", id: SOURCE }] })],
    );
    await db.pool.query(
      `INSERT INTO artifacts
         (id, space_id, run_id, artifact_type, title, export_formats_json,
          visibility, access_level, owner_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,'report','Derived report','[]'::jsonb,
               'space_shared','full',$4,now(),now())`,
      [DERIVED, SPACE, RUN, OWNER],
    );

    const identity = { spaceId: SPACE, userId: OWNER };
    const accessService = new ContentAccessService(db.pool);
    await expect(accessService.updatePolicy(identity, "artifact", SOURCE, {
      visibility: "private",
      access_level: "full",
      project_id: null,
      grants: [],
    })).rejects.toMatchObject({ statusCode: 409 });

    const disclosure = await new ContentDemotionService(db.pool).disclose(
      identity,
      "artifact",
      SOURCE,
      "private",
    );
    expect(disclosure.exposure.consuming_runs).toEqual([
      expect.objectContaining({ run_id: RUN, link: `/runs/${RUN}` }),
    ]);
    expect(disclosure.exposure.shared_derived_outputs).toEqual([
      expect.objectContaining({ resource_type: "artifact", id: DERIVED, link: `/artifacts/${DERIVED}` }),
    ]);
    await accessService.updatePolicy(identity, "artifact", SOURCE, {
      visibility: "private",
      access_level: "full",
      project_id: null,
      grants: [],
      demotion_confirmation_id: disclosure.confirmation_id,
    });
    const source = await db.pool.query("SELECT visibility FROM artifacts WHERE id = $1", [SOURCE]);
    expect(source.rows[0]?.visibility).toBe("private");
  });
});
