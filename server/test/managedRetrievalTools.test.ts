import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resolveRetrievalToolBinding } from "../src/modules/runs/managedRetrievalTools.js";
import { SystemActionDispatcher } from "../src/modules/systemActions/systemActionDispatcher.js";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";

/**
 * Which retrieval domains a Run may reach, and what happens to a call for one
 * it may not.
 *
 * Knowledge is the base surface; Memory, Project public summaries and Source
 * are exposed only when the Runtime Profile named them, because each is a
 * separate egress of the instructing user's private material into a model
 * context. The gating lives in `managedRetrievalTools`, and the ACP path
 * reads it twice: once to decide which tools the runtime is shown, and once
 * (`systemActionDispatcher`) to decide whether a call it was never shown is
 * allowed anyway.
 */

const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const db = useTestDatabase(import.meta.filename);

const RETRIEVAL_GRANTS = [
  "retrieval.search", "retrieval.brief",
  "memory.retrieval.search", "memory.retrieval.brief",
  "project.summary.search", "project.summary.brief",
  "source.retrieval.search", "source.retrieval.brief",
].map((action_id) => ({ action_id }));

function run(retrievalTools: Record<string, unknown>): AgentRunRecord {
  return {
    id: "run-retrieval-1",
    space_id: SPACE,
    agent_id: AGENT,
    agent_version_id: "version-1",
    execution_kind: "agent",
    runtime_profile_id: "profile-1",
    run_type: "agent",
    status: "running",
    mode: "live",
    prompt: "Look it up.",
    instruction: "Answer from what this Space knows.",
    project_folder_id: null,
    session_id: null,
    parent_run_id: null,
    root_run_id: null,
    run_group_id: null,
    delegation_id: null,
    project_id: null,
    scheduled_at: null,
    runtime_key: "claude_code",
    capability_id: null,
    capabilities_json: [],
    model_provider_id: null,
    model_override_json: null,
    runtime_profile_snapshot_json: {},
    runtime_config_json: { retrieval_tool_mode: "manual_tool_only", retrieval_tools: retrievalTools },
    permission_snapshot_json: { tool_grants: RETRIEVAL_GRANTS },
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: USER,
    instructed_by_agent_id: null,
    error_message: null,
    error_json: null,
    output_json: null,
    started_at: "2026-09-21T00:00:00.000Z",
    ended_at: null,
    created_at: "2026-09-21T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
    visibility: "space_shared",
  } as unknown as AgentRunRecord;
}

function policyRecords() {
  return db.pool.query<{ action: string; decision: string; audit_code: string | null }>(
    `SELECT action, decision, audit_code FROM policy_decision_records ORDER BY created_at, id`,
  ).then((result) => result.rows);
}

/** The dispatcher a Host daemon's tool transport drives, on the real registry. */
function dispatcher(retrievalTools: Record<string, unknown>) {
  return SystemActionDispatcher.create(
    loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
    run(retrievalTools),
    // The activity sink writes Run records this Run has none of; the gating
    // under test is not what it reports.
    { actionEventSink: async () => {} },
  );
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["policy_decision_records"]);
});

describe("retrieval tool exposure by domain", () => {
  it("exposes Knowledge alone until the Runtime Profile names another domain", async (ctx) => {
    if (!db.available) return ctx.skip();
    const binding = await resolveRetrievalToolBinding(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      run({}),
      {},
    );
    expect(binding?.toolDefinitions.map((tool) => tool.name)).toEqual([
      "retrieval.search", "retrieval.brief",
    ]);
    // No service for a domain that was never opted in: the dispatcher reads
    // exactly this to decide `domainEnabled`.
    expect(Object.keys(binding?.services ?? {})).toEqual(["knowledge"]);
  });

  it("exposes exactly the opted-in domains, and each one's own object types", async (ctx) => {
    if (!db.available) return ctx.skip();
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });

    const memoryOnly = await resolveRetrievalToolBinding(config, run({ domains: ["memory"] }), {});
    expect(memoryOnly?.toolDefinitions.map((tool) => tool.name)).toEqual([
      "retrieval.search", "retrieval.brief",
      "memory.retrieval.search", "memory.retrieval.brief",
    ]);
    // A Memory tool offers Memory's object types and nothing else; the
    // schema the runtime is shown is the same list its arguments are
    // validated against.
    const memorySearch = memoryOnly?.toolDefinitions.find((tool) => tool.name === "memory.retrieval.search");
    expect((memorySearch?.input_schema as { properties: { object_types: { items: { enum: string[] } } } })
      .properties.object_types.items.enum).toEqual(["memory_entry"]);

    const everything = await resolveRetrievalToolBinding(
      config,
      run({ domains: ["memory", "project", "source"] }),
      {},
    );
    expect(everything?.toolDefinitions.map((tool) => tool.name)).toEqual([
      "retrieval.search", "retrieval.brief",
      "memory.retrieval.search", "memory.retrieval.brief",
      "project.summary.search", "project.summary.brief",
      "source.retrieval.search", "source.retrieval.brief",
    ]);
    expect(Object.keys(everything?.services ?? {}).sort()).toEqual([
      "knowledge", "memory", "project_public_summary", "source",
    ]);
  });

  it("denies a call to a domain the Run never opted into, and records that decision", async (ctx) => {
    if (!db.available) return ctx.skip();
    const dispatch = await dispatcher({ domains: ["source"] });

    const result = await dispatch.dispatch({
      id: "call-memory-1",
      name: "memory.retrieval.search",
      arguments_json: JSON.stringify({ query: "Coffee preferences" }),
    });

    expect(result.modelResult).toMatchObject({
      ok: false,
      error: "Retrieval tool 'memory.retrieval.search' is not enabled for domain 'memory' in this run.",
    });
    // The denial is an ordinary policy decision, and it is auditable: a
    // model reaching for a domain the operator did not enable is exactly
    // what a reviewer wants to find later.
    expect(await policyRecords()).toEqual([
      { action: "memory.retrieval.search", decision: "deny", audit_code: "retrieval_tool_domain_not_enabled" },
    ]);
  });

  it("rejects wrong-domain object_types before any policy decision is recorded", async (ctx) => {
    if (!db.available) return ctx.skip();
    const dispatch = await dispatcher({ domains: ["memory"] });

    const result = await dispatch.dispatch({
      id: "call-memory-wrong-domain",
      name: "memory.retrieval.search",
      arguments_json: JSON.stringify({ query: "Widget plan", object_types: ["knowledge_item"] }),
    });

    expect(result.modelResult).toMatchObject({
      ok: false,
      error_code: "system_action_invalid_input",
      error: "object_types may only include memory_entry.",
    });
    // Input validation precedes enforcement, so a malformed call leaves no
    // decision record: an audit trail full of rows for calls that were never
    // decided is an audit trail nobody reads.
    expect(await policyRecords()).toEqual([]);
  });
});
