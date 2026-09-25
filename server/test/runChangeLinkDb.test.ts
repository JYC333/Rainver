import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { grantRunChangeReadTools, runChangeArtifactUri } from "../src/modules/agentGroups/runChangeBlock.js";
import {
  ConversationInputResourceService,
  ConversationInputResourceToolError,
} from "../src/modules/sessions/conversationInputResourceService.js";
import { conversationToolGrantInput } from "../src/modules/systemActions/scenarioToolAllowance.js";
import { buildRunToolGrants } from "../src/modules/systemActions/runToolGrants.js";
import { seedAgentWithVersion, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";

const db = useTestDatabase(import.meta.filename);

const SPACE = randomUUID();
const OWNER = randomUUID(); // project owner and Room member; the person the reading Run acts for
const CODER_OWNER = randomUUID(); // Room member whose host produced the diff
const OUTSIDER = randomUUID(); // Space member, not in the Room
const PROJECT = randomUUID();
const AGENT = randomUUID();
const VERSION = randomUUID();
const ROOM_SESSION = randomUUID();
const OTHER_SESSION = randomUUID();
const SOURCE_RUN = randomUUID();
const DIFF_ARTIFACT = randomUUID();
const OUTPUT_ARTIFACT = randomUUID();
const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";

async function insertRun(input: {
  id: string;
  session: string;
  status: string;
  instructedBy: string;
  capabilities?: unknown[];
  permissionSnapshot?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date().toISOString();
  const profile = await db.pool.query<{ id: string; runtime_key: string }>(
    `SELECT id, runtime_key FROM agent_runtime_profiles WHERE space_id = $1 AND agent_id = $2 AND is_default`,
    [SPACE, AGENT],
  );
  const { id: profileId, runtime_key: runtimeKey } = profile.rows[0]!;
  await db.pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json,
       owner_user_id, instructed_by_user_id, visibility, session_id, project_id,
       capabilities_json, permission_snapshot_json, created_at, updated_at, execution_kind
     ) VALUES ($1,$2,$3,$4,'agent','manual',$5,'live',$12,'default',$13,'{}'::jsonb,
       $6,$6,'space_shared',$7,$8,$9::jsonb,$10::jsonb,$11,$11,'agent')`,
    [
      input.id, SPACE, AGENT, VERSION, input.status, input.instructedBy, input.session, PROJECT,
      JSON.stringify(input.capabilities ?? []), JSON.stringify(input.permissionSnapshot ?? {}), now,
      profileId, runtimeKey,
    ],
  );
}

beforeAll(async () => {
  if (!db.available) return;
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT, spaceType: "team" });
  await seedSpaceMember(db.pool, { space: SPACE, user: CODER_OWNER });
  await seedSpaceMember(db.pool, { space: SPACE, user: OUTSIDER });
  const room = await db.pool.query<{ id: string }>(
    `SELECT id FROM rooms WHERE space_id = $1 AND is_mainline = true LIMIT 1`,
    [SPACE],
  );
  const roomId = room.rows[0]!.id;
  await db.pool.query(
    `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
    [randomUUID(), SPACE, roomId, CODER_OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, $5), ($6, $2, $3, $4, 'active', $5, $5)`,
    [ROOM_SESSION, SPACE, PROJECT, roomId, now, OTHER_SESSION],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  await insertRun({ id: SOURCE_RUN, session: ROOM_SESSION, status: "succeeded", instructedBy: OWNER });
  await db.pool.query(
    `INSERT INTO artifacts (
       id, space_id, run_id, artifact_type, title, content, mime_type, export_formats_json,
       metadata_json, visibility, owner_user_id, project_id, created_at, updated_at
     ) VALUES
       ($1,$2,$3,'remote_diff','Remote diff',$4,'text/x-diff','[]'::jsonb,'{"truncated":false}'::jsonb,'space_shared',$5,$6,$7,$7),
       ($8,$2,$3,'result','Output','not a change','text/plain','[]'::jsonb,'{}'::jsonb,'space_shared',$5,$6,$7,$7)`,
    [DIFF_ARTIFACT, SPACE, SOURCE_RUN, PATCH, CODER_OWNER, PROJECT, now, OUTPUT_ARTIFACT],
  );
});

function read(runId: string, resourceId: string) {
  return new ConversationInputResourceService(db.pool).read({
    spaceId: SPACE,
    runId,
    messageId: randomUUID(),
    request: { resource_id: resourceId, start_line: 1, line_count: 50 },
  });
}

describe("a Run's change link on real Postgres", () => {
  it("is readable through input_resource by a live Run of the same conversation, and audited", async (ctx) => {
    if (!db.available) return ctx.skip();
    const reader = randomUUID();
    await insertRun({ id: reader, session: ROOM_SESSION, status: "running", instructedBy: OWNER });

    const output = await read(reader, runChangeArtifactUri(DIFF_ARTIFACT));
    expect(output).toMatchObject({ resource_id: DIFF_ARTIFACT, content: PATCH, total_lines: 6, truncated: false });
    expect(output.sha256).toMatch(/^[a-f0-9]{64}$/u);
    // The bare id works too.
    await expect(read(reader, DIFF_ARTIFACT)).resolves.toMatchObject({ content: PATCH });
    const search = await new ConversationInputResourceService(db.pool).search({
      spaceId: SPACE, runId: reader, messageId: randomUUID(),
      request: { resource_id: DIFF_ARTIFACT, query: "+new", case_sensitive: true, max_results: 5 },
    });
    expect(search.matches).toEqual([{ line: 6, excerpt: "+new" }]);

    const audit = await db.pool.query<{ viewer_user_id: string; run_id: string; access_type: string }>(
      `SELECT viewer_user_id, run_id, access_type FROM content_access_logs
        WHERE space_id = $1 AND resource_type = 'artifact' AND resource_id = $2`,
      [SPACE, DIFF_ARTIFACT],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    expect(audit.rows[0]).toMatchObject({ viewer_user_id: OWNER, run_id: reader, access_type: "explicit_read" });
  });

  it("is refused to a Run in another conversation, a Run acting for a non-member, a finished Run, and for other Artifacts", async (ctx) => {
    if (!db.available) return ctx.skip();
    const otherConversation = randomUUID();
    const outsiderRun = randomUUID();
    const finishedRun = randomUUID();
    const reader = randomUUID();
    await insertRun({ id: otherConversation, session: OTHER_SESSION, status: "running", instructedBy: OWNER });
    await insertRun({ id: outsiderRun, session: ROOM_SESSION, status: "running", instructedBy: OUTSIDER });
    await insertRun({ id: finishedRun, session: ROOM_SESSION, status: "succeeded", instructedBy: OWNER });
    await insertRun({ id: reader, session: ROOM_SESSION, status: "running", instructedBy: OWNER });

    for (const runId of [otherConversation, outsiderRun, finishedRun]) {
      await expect(read(runId, runChangeArtifactUri(DIFF_ARTIFACT))).rejects.toMatchObject({ code: "resource_not_found" });
    }
    // Only a change Artifact is reachable this way, even in the same conversation.
    await expect(read(reader, OUTPUT_ARTIFACT)).rejects.toBeInstanceOf(ConversationInputResourceToolError);
    // And only one the person can read through the ordinary Artifact gate.
    const privateDiff = randomUUID();
    await db.pool.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, artifact_type, title, content, mime_type, export_formats_json,
         visibility, owner_user_id, project_id, created_at, updated_at
       ) VALUES ($1,$2,$3,'remote_diff','Private diff',$4,'text/x-diff','[]'::jsonb,'private',$5,$6,now(),now())`,
      [privateDiff, SPACE, SOURCE_RUN, PATCH, CODER_OWNER, PROJECT],
    );
    await expect(read(reader, runChangeArtifactUri(privateDiff))).rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("gives a resumed conversation Run the resource tools and nothing else", async (ctx) => {
    if (!db.available) return ctx.skip();
    const runId = randomUUID();
    const grant = conversationToolGrantInput({ room_id: "room", project_id: PROJECT });
    const toolGrants = await buildRunToolGrants(grant.capabilities_json, { allowed_tools: grant.scenario_tool_allowance });
    await insertRun({
      id: runId,
      session: ROOM_SESSION,
      status: "queued",
      instructedBy: OWNER,
      capabilities: grant.capabilities_json,
      permissionSnapshot: { tool_grants: toolGrants, scenario_tool_allowance: grant.scenario_tool_allowance },
    });

    await grantRunChangeReadTools(db.pool, { space_id: SPACE, id: runId });

    const withResources = conversationToolGrantInput({ room_id: "room", project_id: PROJECT, has_input_resources: true });
    const row = await db.pool.query<{ capabilities_json: string[]; permission_snapshot_json: { tool_grants: Array<{ action_id: string }>; scenario_tool_allowance: string[] } }>(
      `SELECT capabilities_json, permission_snapshot_json FROM runs WHERE id = $1`,
      [runId],
    );
    const updated = row.rows[0]!;
    expect([...updated.capabilities_json].sort()).toEqual([...withResources.capabilities_json].sort());
    expect([...updated.permission_snapshot_json.scenario_tool_allowance].sort()).toEqual([...withResources.scenario_tool_allowance].sort());
    const expectedGrants = await buildRunToolGrants(withResources.capabilities_json, { allowed_tools: withResources.scenario_tool_allowance });
    expect(updated.permission_snapshot_json.tool_grants.map((g) => g.action_id).sort())
      .toEqual(expectedGrants.map((g) => g.action_id).sort());
  });
});
