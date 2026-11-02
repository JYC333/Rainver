import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { AGENT, CONNECTION, OWNER, PROFILE, SPACE, briefingWorld, manual } from "./support/briefingFixture.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { RuntimeContextPolicyRepository } from "../src/modules/policy/runtimeContextPolicyRepository.js";
import { buildRunOrchestration } from "../src/modules/runs/orchestrationFactory.js";
import { assertBriefingDispatch } from "../src/modules/informationDigest/briefing/settlement.js";
import { createProductionRuntimeContextInvocationGateway } from "../src/modules/runtimeContext/gateway.js";

// A briefing Run's material may reach only the model its Run is bound to.
// The production orchestrator's dispatch guard and the Invocation Delivery of
// the Run's request both judge the Source's consent on that fixed binding,
// never on the runtime Profile the Run was routed from, which a canonical
// edit may change afterwards. Synthetic data, no model: Deliveries are
// prepared, never dispatched.
const db = useTestDatabase(import.meta.filename, { max: 10 });
const w = briefingWorld(db);
const owner = { spaceId: SPACE, userId: OWNER };
const SECRET = "BRIEFING_SOURCE_PRIVATE_TEXT";
const LOCAL_ONLY = `'{"allow_external_model_egress":false,"allow_local_provider_egress":true}'::jsonb`;
const ALLOW_ALL = `'{"allow_external_model_egress":true,"allow_local_provider_egress":true}'::jsonb`;

beforeEach(async () => {
  if (!db.available) return;
  await w.seed();
  await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`, [SPACE, OWNER]);
  await new RuntimeContextPolicyRepository(db.pool).write(owner, "space", SPACE, { base_version_id: null, policy: { constraints: {}, preferences: {} }, reason: "Isolated synthetic default policy" });
});

/** A trusted local model server granted to the Space, and the fixture Host able to run opencode too. */
async function localProvider() {
  const provider = randomUUID();
  await db.pool.query(
    `INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Local','openai','http://127.0.0.1:11434/v1','llama3',true,'{}'::jsonb,$4::jsonb,now(),now())`,
    [provider, SPACE, OWNER, JSON.stringify({ deployment: "trusted_local", openai_compatible_base_url: "http://127.0.0.1:11434/v1" })],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4,true,false,now(),now())`,
    [randomUUID(), provider, SPACE, OWNER],
  );
  const host = (await db.pool.query(`SELECT id, capabilities_json FROM hosts WHERE owner_user_id=$1`, [OWNER])).rows[0];
  const capabilities = host.capabilities_json;
  capabilities.runtimes.push("opencode");
  capabilities.versions.opencode = "fixture";
  capabilities.installations.opencode = [{ id: "own", version: "fixture", logged_in: true, options: { session_available: true, config_options: [] }, health_check_protocol: "acp" }];
  await db.pool.query(`UPDATE hosts SET capabilities_json=$2 WHERE id=$1`, [host.id, capabilities]);
  return provider;
}

/** The canonical Profile edit: the same id now describes opencode on the local provider. */
const profileToLocal = (provider: string) =>
  new PgAgentRepository(db.pool).updateRuntimeProfile(SPACE, AGENT, PROFILE, { runtimeKey: "opencode", backendMode: "model_provider", modelProviderId: provider, modelName: "llama3", actorUserId: OWNER });

/**
 * Requests a Project briefing over the secret material and binds its Run as
 * orchestration does — onto the native external CLI on the Host, or onto the
 * local provider the Delivery calls itself — then writes the production
 * execution control. `deliver()` prepares the Run's request Delivery.
 */
async function boundBriefingRun(binding: { local: string } | "native") {
  await w.material(SECRET);
  const requested = await w.service().request(w.adapter(), OWNER, manual);
  const run = await w.runOf(requested.briefing.id);
  const local = binding === "native" ? null : binding.local;
  await db.pool.query(
    `UPDATE runs SET runtime_profile_id=$2, runtime_profile_selection_source='explicit', runtime_key=$3, model_provider_id=$4, runtime_profile_snapshot_json=$5::jsonb WHERE id=$1`,
    [run.id, PROFILE, local ? "opencode" : "claude_code", local, JSON.stringify(local ? { backend_mode: "model_provider", model_provider_id: local, model_name: "llama3" } : { backend_mode: "runtime_native" })],
  );
  const routed = (await w.runs().getRun(SPACE, run.id))!;
  const orchestration = buildRunOrchestration(w.config()).orchestration as unknown as { executionControlSnapshotWriter: (run: unknown, inputs: unknown) => Promise<{ id: string; work_context_setup_ref: { id: string } }> };
  const control = await orchestration.executionControlSnapshotWriter(routed, { dispatchesToHostDaemon: !local });
  const setup = (await db.pool.query(`SELECT * FROM work_context_setups WHERE id=$1`, [control.work_context_setup_ref.id])).rows[0];
  return {
    routed,
    deliver: () => createProductionRuntimeContextInvocationGateway(db.pool).prepareInvocation({
      identity: owner, invocationId: routed.id, executionControlSnapshotId: control.id,
      runtimeKey: local ? "opencode" : "claude_code", providerId: local, usageSourceId: `run:${routed.id}:briefing`,
      turn: { work_context_scope_id: setup.work_context_scope_id, expected_setup_version: Number(setup.version), current_message_ref: { type: "run_request", id: routed.id }, one_off_refs: [], invocation_purpose: "agent_task" },
    }).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })),
    accepted: async () => (await db.pool.query(`SELECT count(*)::int n FROM invocation_deliveries WHERE invocation_id=$1`, [routed.id])).rows[0].n as number,
  };
}

const refused = { ok: false, error: { statusCode: 403, code: "briefing_access_changed" } };

describe("A briefing Run's Source egress is judged on the destination its Run is bound to", () => {
  it("generates on a Run legitimately bound to a trusted local provider the Source admits", async (ctx) => {
    if (!db.available) return ctx.skip();
    const provider = await localProvider();
    await profileToLocal(provider);
    const run = await boundBriefingRun({ local: provider });
    await db.pool.query(`UPDATE source_connections SET consent_json=${LOCAL_ONLY} WHERE id=$1`, [CONNECTION]);
    await expect(assertBriefingDispatch(w.config(), run.routed, db.pool)).resolves.toBeUndefined();
    const delivery = await run.deliver();
    expect(delivery.ok).toBe(true);
    if (delivery.ok) {
      expect(delivery.value.runtime_key).toBe("opencode");
      expect(JSON.stringify(delivery.value.message_blocks)).toContain(SECRET);
    }
    expect(await run.accepted()).toBe(1);
  });

  it("refuses a Run bound to the external native CLI after its Profile was canonically edited to the local provider, with nothing accepted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = await boundBriefingRun("native");
    const provider = await localProvider();
    await profileToLocal(provider);
    await db.pool.query(`UPDATE source_connections SET consent_json=${LOCAL_ONLY} WHERE id=$1`, [CONNECTION]);
    await expect(assertBriefingDispatch(w.config(), run.routed, db.pool)).rejects.toMatchObject({ statusCode: 403, code: "briefing_access_changed" });
    expect(await run.deliver()).toMatchObject(refused);
    expect(await run.accepted()).toBe(0);
  });

  it("delivers the same external Run once its Source consents to external models: the refusal was the Source's, on the fixed destination", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = await boundBriefingRun("native");
    const provider = await localProvider();
    await profileToLocal(provider);
    await db.pool.query(`UPDATE source_connections SET consent_json=${ALLOW_ALL} WHERE id=$1`, [CONNECTION]);
    await expect(assertBriefingDispatch(w.config(), run.routed, db.pool)).resolves.toBeUndefined();
    const delivery = await run.deliver();
    expect(delivery.ok).toBe(true);
    if (delivery.ok) {
      expect(delivery.value.runtime_key).toBe("claude_code");
      expect(JSON.stringify(delivery.value.message_blocks)).toContain(SECRET);
    }
    expect(await run.accepted()).toBe(1);
  });
});
