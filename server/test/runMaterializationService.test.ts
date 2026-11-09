import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedRun} from './support/domainSeeds.js';
import type {PoolClient} from '../src/db/pool.js';
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { RunMaterializationService } from "../src/modules/runs/materializationService.js";
import { RunFinalizationBusyError } from "../src/modules/runs/finalizationErrors.js";
import { requireFinalizedForPostRun } from "../src/modules/runs/finalizationOutcome.js";
import { JobDeferredError } from "../src/modules/jobs/handlerRegistry.js";
import type { AgentRunRecord, QueryResult, Queryable } from "../src/modules/runs/repository.js";
import type { RunFinalizationRecord } from "../src/modules/runs/repository.js";

let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    execution_kind: "agent",
    status: "running",
    mode: "live",
    prompt: "Say hello",
    instruction: null,
    project_folder_id: "workspace-1",
    session_id: null,
    project_id: "project-1",
    runtime_key: "opencode",
    model_provider_id: "provider-1",
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    started_at: null,
    ended_at: null,
    ...overrides,
  };
}

const shared=useTestDatabase(import.meta.filename);
beforeEach(async(ctx)=>{
 if(!shared.available)return ctx.skip();
 await resetTables(shared.pool,['spaces','users'],{cascade:true});
 await seedSpaceOwnerProject(shared.pool,{space:'space-1',owner:'user-1',project:'project-1'});
 await seedRun(shared.pool,{id:'run-1',space:'space-1',owner:'user-1',agent:'agent-1',version:'agent-version-1'});
 await seedRun(shared.pool,{id:'run-personal',space:'space-1',owner:'user-1',agent:'agent-1',version:'agent-version-1',existingAgent:true});
 await shared.pool.query("UPDATE runs SET status='running',started_at=now() WHERE space_id='space-1'");
 await shared.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES('workspace-1','space-1','project-1','workspace','code','active',false,false,now(),now())");
});
/** SQL observation only: all writes and transactions execute on shared real PG. */
class ObservedDb implements Queryable {
 calls:Array<{sql:string;params:readonly unknown[]}>=[];
 artifacts:unknown[][]=[];
 proposals:unknown[][]=[];
 private async execute<Row>(db:Queryable,sql:string,params:readonly unknown[]=[]):Promise<QueryResult<Row>>{
  this.calls.push({sql,params});
  const result=await db.query<Row>(sql,params);
  if(sql.includes('INSERT INTO artifacts'))this.artifacts.push([...params]);
  if(sql.includes('INSERT INTO proposals'))this.proposals.push([...params]);
  return result;
 }
 query<Row>(sql:string,params:readonly unknown[]=[]):Promise<QueryResult<Row>>{return this.execute<Row>(shared.pool,sql,params);}
 async connect():Promise<PoolClient>{
  const client=await shared.pool.connect();
  return {query:<Row>(sql:string,params:readonly unknown[]=[])=>this.execute<Row>(client,sql,params),release:()=>client.release()} as PoolClient;
 }
}

describe("RunMaterializationService (real PG)", () => {
  it("derives Agent learning placement from the Run creation context", async () => {
    const db = new ObservedDb();
    const service = new RunMaterializationService(
      loadConfig({ SERVER_DATABASE_URL: shared.connectionUri }),
      db,
      undefined,
      async () => ({ status: "allow" }),
    );
    const adapterResult = {
      runtime_key: "opencode",
      adapter_kind: "managed_api" as const,
      success: true,
      output_text: "",
      output_json: {
        proposed_changes: [{
          proposal_type: "memory_create",
          payload_json: { proposed_content: "learned", target_scope: "agent", agent_id: "agent-1" },
        }],
      },
      exit_code: 0,
    };

    await service.materializeAdapterResult({ run: run(), adapterResult });
    await service.materializeAdapterResult({
      run: run({ id: "run-personal", project_id: null, project_folder_id: null }),
      adapterResult,
    });

    expect(JSON.parse(String(db.proposals[0]?.[10]))).toMatchObject({
      target_scope: "project",
      target_visibility: "space_shared",
      owner_user_id: "user-1",
      project_id: "project-1",
    });
    expect(db.proposals[0]?.[16]).toBe("project-1");
    expect(JSON.parse(String(db.proposals[1]?.[10]))).toMatchObject({
      target_scope: "user",
      target_visibility: "private",
      owner_user_id: "user-1",
    });
    expect(JSON.parse(String(db.proposals[1]?.[10]))).not.toHaveProperty("agent_id");
    expect(db.proposals[1]?.[15]).toBe("private");
    expect(db.proposals[1]?.[16]).toBeNull();
  });

  it("fails closed when a Run claims taint but its summary is malformed", async () => {
    const db = new ObservedDb();
    const service = new RunMaterializationService(
      loadConfig({ SERVER_DATABASE_URL: shared.connectionUri }),
      db,
      undefined,
      async () => ({ status: "allow" }),
    );
    const result = await service.materializeAdapterResult({
      run: run({ has_context_taint: true, context_taint_json: { schema_version: 99 } }),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: { artifacts: [{ title: "Must not persist", content: "blocked" }] },
        exit_code: 0,
      },
    });
    expect(db.artifacts).toHaveLength(0);
    expect(result.items).toMatchObject([{ kind: "artifact", status: "failed", error_code: "output_artifact_materialization_error" }]);
    expect(result.errors[0]).toContain("has_context_taint without a valid context_taint_json summary");
  });

  it("stages proposals and reconciles delegation only from terminal output", async () => {
    const db = new ObservedDb();
    const delegationCalls: unknown[] = [];
    const service = new RunMaterializationService(
      loadConfig({
        SERVER_DATABASE_URL: shared.connectionUri,
      }),
      db,
      {
        async finalize() {
          return {
            id: "finalization-1",
            run_evaluation_id: null,
            task_evaluation_id: null,
            finalizer_version: "test.v1",
          };
        },
      } as never,
      async () => ({ status: "allow" }),
      {
        async materialize(input) {
          delegationCalls.push(input);
          return {
            items: [{ kind: "delegation", status: "succeeded" }],
            errors: [],
          };
        },
      },
    );
    const adapterResult = {
      runtime_key: "opencode",
      adapter_kind: "managed_api" as const,
      success: true,
      output_text: "done",
      output_json: {
        proposed_changes: [{
          proposal_type: "memory_create",
          payload_json: { content: "candidate" },
        }],
        delegations: [{ workspace_access: "write" as const, target_agent_id: "agent-2", instruction: "Review" }],
      },
      exit_code: 0,
      error_code: null,
      error_message: null,
      started_at: "2026-06-12T10:00:00.000Z",
      completed_at: "2026-06-12T10:00:01.000Z",
      usage: null,
    };

    await service.materializeAdapterResult({
      run: run(),
      adapterResult,
    }, {
      proposal_status: "staged",
    });

    expect(db.proposals[0]?.[4]).toBe("staged");
    expect(delegationCalls).toEqual([]);

    const finalized = await service.finalizeRun({
      ...run(),
      status: "succeeded",
      output_json: {
        schema_version: "run_output.v1",
        status: "succeeded",
        summary: "done",
        result: adapterResult.output_json,
        output_manifest: [],
      },
    });

    expect(delegationCalls).toHaveLength(1);
    expect(finalized).toMatchObject({ kind: "activity", status: "succeeded" });
  });

  it("serializes structured artifact content objects for the text-backed artifact store", async () => {
    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
    });
    const service = new RunMaterializationService(
      config,
      db,
      {
        async finalize() {
          return {
            id: "finalization-1",
            run_evaluation_id: null,
            task_evaluation_id: null,
            finalizer_version: "test.v1",
          };
        },
      } as never,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run(),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: {
          artifacts: [{
            title: "Brief",
            artifact_type: "research_report.archive.v1",
            mime_type: "application/json",
            content: {
              schema_version: "research_report.v1",
              research_question: "Does X improve Y?",
              summary: "A bounded summary.",
              findings: [],
              limitations: [],
            },
          }],
        },
        exit_code: 0,
      },
    });

    expect(result.errors).toEqual([]);
    expect(db.artifacts).toHaveLength(1);
    expect(JSON.parse(db.artifacts[0][5] as string)).toEqual({
      schema_version: "research_report.v1",
      research_question: "Does X improve Y?",
      summary: "A bounded summary.",
      findings: [],
      limitations: [],
    });
  });

  it("materializes structured runtime delegations through the agent group materializer", async () => {
    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
    });
    const seen: unknown[] = [];
    const service = new RunMaterializationService(
      config,
      db,
      undefined,
      async () => ({ status: "allow" }),
      {
        async materialize(input) {
          seen.push(input);
          return {
            items: [
              {
                kind: "delegation",
                status: "succeeded",
                metadata_json: {
                  operation: "run.spawn_child",
                  delegation_id: "delegation-1",
                  child_run_id: "run-child",
                },
              },
            ],
            errors: [],
          };
        },
      },
    );

    const adapterResult = {
      runtime_key: "opencode",
      adapter_kind: "managed_api" as const,
      success: true,
      output_text: "",
      output_json: {
        delegations: [
          { workspace_access: "write" as const,
            target_agent_id: "agent-reader",
            instruction: "Summarize the packet.",
          },
        ],
      },
      exit_code: 0,
    };
    const result = await service.materializeAdapterResult({
      run: run({ run_group_id: "group-1", root_run_id: "run-root" }),
      adapterResult,
    });

    expect(seen).toHaveLength(0);
    expect(result.errors).toEqual([]);
    expect(result.items).toEqual([]);
    await service.finalizeRun({
      ...run({ run_group_id: "group-1", root_run_id: "run-root" }),
      status: "succeeded",
      output_json: {
        schema_version: "run_output.v1",
        status: "succeeded",
        summary: "",
        result: adapterResult.output_json,
        output_manifest: [],
      },
    });
    expect(seen).toHaveLength(1);
  });

  it("materializes artifacts and supported proposals natively", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "rainver-artifacts-"));
    const sandboxRoot = await mkdtemp(join(tmpdir(), "rainver-sandbox-"));
    tempRoots.push(artifactRoot, sandboxRoot);
    await mkdir(join(sandboxRoot, "logs"), { recursive: true });
    await writeFile(join(sandboxRoot, "logs", "out.txt"), "file artifact", "utf8");

    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
      ARTIFACT_STORAGE_ROOT: artifactRoot,
    });
    const service = new RunMaterializationService(
      config,
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run(),
      sandbox_cwd: sandboxRoot,
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "hello token=secret",
        output_json: {
          artifacts: [
            {
              title: "Report",
              content: "ok",
              mime_type: "text/markdown",
              visibility: "private",
              metadata_json: { section: "summary" },
            },
          ],
          proposed_changes: [
            {
              proposal_type: "code_patch",
              project_folder_id: "workspace-1",
              patch: {
                operations: [
                  {
                    type: "replace_file",
                    path: "a.txt",
                    content: "x",
                    preimage_sha256: null,
                    preimage_exists: false,
                  },
                ],
              },
            },
            { proposal_type: "deployment_job", title: "unsupported" },
          ],
          activities: [{ title: "activity" }],
        },
        produced_artifact_paths: ["logs/out.txt"],
        exit_code: 0,
        error_code: null,
        error_message: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        usage: null,
      },
    });

    expect(result.items).toMatchObject([
      { kind: "artifact", status: "succeeded" },
      { kind: "artifact", status: "succeeded" },
      { kind: "proposal", status: "succeeded" },
      {
        kind: "proposal",
        status: "failed",
        error_code: "output_proposal_materialization_error",
      },
      {
        kind: "activity",
        status: "failed",
        error_code: "output_activity_materialization_error",
      },
    ]);
    expect(db.artifacts).toHaveLength(2);
    expect(db.proposals).toHaveLength(1);

    const copiedStoragePath = db.artifacts[0][6] as string;
    expect(await readFile(join(artifactRoot, copiedStoragePath), "utf8")).toBe(
      "file artifact",
    );

    expect(db.artifacts[1][5]).toBe("ok");
    expect(db.artifacts[1][7]).toBe("text/markdown");
    expect(db.artifacts[0][12]).toBe("space_shared");
    expect(db.artifacts[1][12]).toBe("private");
    expect(db.artifacts[1][13]).toBe("user-1");

    const proposalPayload = JSON.parse(db.proposals[0][10] as string) as Record<string, unknown>;
    expect(proposalPayload.project_id).toBe("project-1");
    expect(db.proposals[0][16]).toBe("project-1");
    expect(proposalPayload.patch).toEqual({
      operations: [
        {
          type: "replace_file",
          path: "a.txt",
          content: "x",
          preimage_sha256: null,
          preimage_exists: false,
        },
      ],
    });
    expect(result.errors).toEqual([
      'proposal:output_proposal_materialization_error:unsupported proposal_type "deployment_job"',
      "activity:output_activity_materialization_error:Activity materialization is intentionally deferred in the server backend.",
    ]);
  });

  it("materializes Room conversation capture packets as pending proposals", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "rainver-room-artifacts-"));
    const exchangeRoot = await mkdtemp(join(tmpdir(), "rainver-room-exchange-"));
    tempRoots.push(artifactRoot, exchangeRoot);
    await writeFile(
      join(exchangeRoot, "conversation_capture.json"),
      JSON.stringify({
        proposed_changes: [{
          proposal_type: "memory_create",
          title: "Remember the Room decision",
          content: "The Room selected the read-only delivery path.",
        }],
      }),
      "utf8",
    );
    const db = new ObservedDb();
    const service = new RunMaterializationService(
      loadConfig({
        SERVER_DATABASE_URL: shared.connectionUri,
        ARTIFACT_STORAGE_ROOT: artifactRoot,
      }),
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run({
        session_id: "room-session-1",
        visibility: "selected_users",
        contract_snapshot_json: {
          required_outputs_json: [{ name: "conversation_capture" }],
        },
      }),
      exchange_output_cwd: exchangeRoot,
      adapterResult: {
        runtime_key: "claude_code",
        adapter_kind: "local_cli",
        success: true,
        output_text: "Captured the decision for review.",
        output_json: {},
        exchange_artifact_paths: [{
          output_name: "conversation_capture",
          path: "conversation_capture.json",
          declared: true,
        }],
        exit_code: 0,
      },
    });

    expect(result.items).toMatchObject([
      { kind: "artifact", status: "succeeded" },
      { kind: "proposal", status: "succeeded" },
    ]);
    expect(db.proposals).toHaveLength(1);
    expect(db.proposals[0][3]).toBe("memory_create");
    expect(db.proposals[0][4]).toBe("pending");
    expect(db.proposals[0][14]).toBe("user-1");
    expect(db.artifacts[0][12]).toBe("selected_users");
    expect(db.proposals[0][15]).toBe("selected_users");
    expect(
      db.calls
        .filter(({ sql }) => sql.includes("INSERT INTO content_access_grants"))
        .map(({ params }) => params.slice(1, 5)),
    ).toEqual([
      ["run", "run-1", "artifact", expect.any(String)],
      ["run", "run-1", "proposal", expect.any(String)],
    ]);
  });

  it("clamps artifacts and proposals to a private Run", async () => {
    const db = new ObservedDb();
    const service = new RunMaterializationService(
      loadConfig({ SERVER_DATABASE_URL: shared.connectionUri }),
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run({ visibility: "private" }),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: {
          artifacts: [{ title: "Private result", content: "result", visibility: "space_shared" }],
          proposed_changes: [{
            proposal_type: "memory_create",
            title: "Private proposal",
            visibility: "private",
            payload_json: { proposed_content: "proposal" },
          }],
        },
        exit_code: 0,
      },
    });

    expect(result.errors).toEqual([]);
    expect(db.artifacts[0]?.[12]).toBe("private");
    expect(db.proposals[0]?.[15]).toBe("private");
  });

  it("preserves an explicitly private proposal from a shared Run", async () => {
    const db = new ObservedDb();
    const service = new RunMaterializationService(
      loadConfig({ SERVER_DATABASE_URL: shared.connectionUri }),
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run({ visibility: "space_shared" }),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: {
          proposed_changes: [{
            proposal_type: "memory_create",
            title: "Owner-private proposal",
            visibility: "private",
            payload_json: { proposed_content: "private" },
          }],
        },
        exit_code: 0,
      },
    });

    expect(result.errors).toEqual([]);
    expect(db.proposals[0]?.[15]).toBe("private");
  });

  it("does not interpret undeclared exchange files as conversation captures", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "rainver-room-artifacts-"));
    const exchangeRoot = await mkdtemp(join(tmpdir(), "rainver-room-exchange-"));
    tempRoots.push(artifactRoot, exchangeRoot);
    await writeFile(
      join(exchangeRoot, "conversation_capture.json"),
      JSON.stringify({ proposed_changes: [{ proposal_type: "memory_create", content: "No." }] }),
      "utf8",
    );
    const db = new ObservedDb();
    const service = new RunMaterializationService(
      loadConfig({
        SERVER_DATABASE_URL: shared.connectionUri,
        ARTIFACT_STORAGE_ROOT: artifactRoot,
      }),
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run({
        contract_snapshot_json: {
          required_outputs_json: [{ name: "conversation_capture" }],
        },
      }),
      exchange_output_cwd: exchangeRoot,
      adapterResult: {
        runtime_key: "claude_code",
        adapter_kind: "local_cli",
        success: true,
        output_text: "",
        output_json: {},
        exchange_artifact_paths: [{
          output_name: "conversation_capture",
          path: "conversation_capture.json",
          declared: false,
        }],
        exit_code: 0,
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "artifact", status: "succeeded" });
    expect(db.proposals).toHaveLength(0);
  });

  it("keeps plain output_text as run display output instead of creating an artifact", async () => {
    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
    });
    const service = new RunMaterializationService(
      config,
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run(),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "A normal chat reply.",
        output_json: {},
        exit_code: 0,
        error_code: null,
        error_message: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        usage: null,
      },
    });

    expect(result).toEqual({ items: [], errors: [] });
    expect(db.artifacts).toHaveLength(0);
  });

  it("rejects removed research proposal types instead of materializing them", async () => {
    const db = new ObservedDb();
    const config = loadConfig({ SERVER_DATABASE_URL: shared.connectionUri });
    const service = new RunMaterializationService(config, db, undefined, async () => ({ status: "allow" }));
    const result = await service.materializeAdapterResult({
      run: run(),
      adapterResult: {
        runtime_key: "opencode", adapter_kind: "local_cli", success: true, output_text: "", exit_code: 0,
        output_json: { proposed_changes: [{
          proposal_type: "research_notebook_update", title: "Update understanding", rationale: "New comparison",
          payload: { project_id: "project-1", section_key: "understanding", base_version: 3, new_content_md: "Revised understanding", refs: [] },
        }] },
      },
    });
    expect(result.errors).toHaveLength(1);
    expect(String(result.errors[0])).toContain("unsupported proposal_type");
    expect(db.proposals).toHaveLength(0);
  });

  it("ignores a model-supplied project for Agent learning", async () => {
    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
    });
    const service = new RunMaterializationService(
      config,
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run(),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: {
          proposed_changes: [
            {
              proposal_type: "memory_create",
              payload_json: {
                project_id: "project-other",
                proposed_content: "do not persist",
              },
            },
          ],
        },
        exit_code: 0,
        error_code: null,
        error_message: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        usage: null,
      },
    });

    expect(result.items).toMatchObject([{ kind: "proposal", status: "succeeded" }]);
    expect(result.errors).toEqual([]);
    expect(db.proposals[0]?.[16]).toBe("project-1");
    expect(JSON.parse(String(db.proposals[0]?.[10]))).toMatchObject({
      target_scope: "project",
      project_id: "project-1",
    });
  });

  it("keeps Memory and Knowledge run outputs as pending proposals, not active writes", async () => {
    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
    });
    const service = new RunMaterializationService(
      config,
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run(),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: {
          proposed_changes: [
            {
              proposal_type: "memory_create",
              title: "Remember preference",
              payload_json: {
                memory_type: "semantic",
                content: "User prefers concise summaries.",
                provenance_entries: [
                  {
                    source_type: "run",
                    source_id: "run-1",
                    memory_source_trust: "internal_system",
                  },
                ],
              },
            },
            {
              proposal_type: "knowledge_create",
              title: "Create knowledge item",
              payload_json: {
                operation: "knowledge_create",
                knowledge_kind: "concept",
                title: "Agent group review",
                content: "Agent group outputs require proposal review.",
              },
            },
          ],
        },
        exit_code: 0,
        error_code: null,
        error_message: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        usage: null,
      },
    });

    expect(result.items).toMatchObject([
      { kind: "proposal", status: "succeeded" },
      { kind: "proposal", status: "succeeded" },
    ]);
    expect(db.proposals.map((params) => [params[3], params[4]])).toEqual([
      ["memory_create", "pending"],
      ["knowledge_create", "pending"],
    ]);
    const sql = db.calls.map((call) => call.sql).join("\n");
    expect(sql).not.toContain("INSERT INTO memory_entries");
    expect(sql).not.toContain("INSERT INTO knowledge_items");
  });

  it("enforces artifact.persist before inserting artifacts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "rainver-artifacts-"));
    tempRoots.push(artifactRoot);
    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
      ARTIFACT_STORAGE_ROOT: artifactRoot,
    });
    const service = new RunMaterializationService(
      config,
      db,
      undefined,
      async (request) => request.action === "artifact.persist"
        ? { status: "blocked", error_code: "policy_denied", message: "Artifact denied" }
        : { status: "allow" },
    );

    const result = await service.materializeAdapterResult({
      run: run(),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "blocked artifact",
        output_json: {
          artifacts: [{ title: "Blocked", content: "blocked artifact" }],
        },
        exit_code: 0,
        error_code: null,
        error_message: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        usage: null,
      },
    });

    expect(result.items).toMatchObject([
      {
        kind: "artifact",
        status: "failed",
        error_code: "output_artifact_materialization_error",
        error_message: "Artifact denied",
      },
    ]);
    expect(db.artifacts).toHaveLength(0);
  });

  it("leaves no file in artifact storage when artifact.persist refuses a produced file", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "rainver-artifacts-"));
    const sandboxRoot = await mkdtemp(join(tmpdir(), "rainver-sandbox-"));
    tempRoots.push(artifactRoot, sandboxRoot);
    await mkdir(join(sandboxRoot, "logs"), { recursive: true });
    await writeFile(join(sandboxRoot, "logs", "out.txt"), "file artifact", "utf8");
    const db = new ObservedDb();
    const service = new RunMaterializationService(
      loadConfig({
        SERVER_DATABASE_URL: shared.connectionUri,
        ARTIFACT_STORAGE_ROOT: artifactRoot,
      }),
      db,
      undefined,
      async (request) => request.action === "artifact.persist"
        ? { status: "blocked", error_code: "policy_denied", message: "Artifact denied" }
        : { status: "allow" },
    );

    const result = await service.materializeAdapterResult({
      run: run(),
      sandbox_cwd: sandboxRoot,
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: {},
        produced_artifact_paths: ["logs/out.txt"],
        exit_code: 0,
        error_code: null,
        error_message: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        usage: null,
      },
    });

    expect(result.items.filter((item) => item.kind === "artifact")).toMatchObject([
      { status: "failed", error_code: "output_artifact_materialization_error", error_message: "Artifact denied" },
    ]);
    expect(db.artifacts).toHaveLength(0);
    // Content the policy refused to persist must not sit in artifact storage
    // under a name no row points at, where nothing can ever find or reclaim it.
    const stored = await readdir(artifactRoot, { recursive: true, withFileTypes: true });
    expect(stored.filter((entry) => entry.isFile())).toEqual([]);
  });

  it("materializes claim/object packets only from structured proposal payloads", async () => {
    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
    });
    const service = new RunMaterializationService(
      config,
      db,
      undefined,
      async () => ({ status: "allow" }),
    );

    const result = await service.materializeAdapterResult({
      run: run(),
      adapterResult: {
        runtime_key: "opencode",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: {
          proposed_changes: [
            {
              proposal_type: "claim_create",
              title: "Create claim",
              payload_json: {
                operation: "claim_create",
                claim_kind: "fact",
                subject_text: "Retrieval",
                claim_text: "The retrieval embedding dimension is 2560.",
                sources: [
                  {
                    source_ref_type: "external_pointer",
                    source_ref_id: "pointer-1",
                    source_connection_id: "connection-1",
                    evidence_role: "supports",
                  },
                ],
              },
            },
            {
              proposal_type: "claim_create",
              title: "Flat claim should fail",
              claim_kind: "fact",
              subject_text: "Retrieval",
              claim_text: "This must not be accepted from the envelope.",
            },
          ],
        },
        exit_code: 0,
        error_code: null,
        error_message: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        usage: null,
      },
    });

    expect(result.items).toMatchObject([
      { kind: "proposal", status: "succeeded" },
      {
        kind: "proposal",
        status: "failed",
        error_code: "output_proposal_materialization_error",
        error_message: "claim_create requires structured payload_json or payload",
      },
    ]);
    expect(db.proposals).toHaveLength(1);
    const payload = JSON.parse(db.proposals[0][10] as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      operation: "claim_create",
      proposal_type: "claim_create",
      source_run_id: "run-1",
      created_by_run_id: "run-1",
      project_id: "project-1",
      claim_text: "The retrieval embedding dimension is 2560.",
    });
  });

  it("defers completion on lock contention without treating it as a new model attempt", async () => {
    const service = new RunMaterializationService(loadConfig({ SERVER_DATABASE_URL: shared.connectionUri }), new ObservedDb(), {
      async finalize(): Promise<RunFinalizationRecord> { throw new RunFinalizationBusyError(); },
    });
    const result = await service.finalizeRun(run({ status: "cancelled" }));
    expect(result).toMatchObject({ error_code: "finalization_in_progress" });
    expect(() => requireFinalizedForPostRun(result)).toThrow(JobDeferredError);
    expect(() => requireFinalizedForPostRun({ status: "failed", error_code: "settlement_pending" })).not.toThrow();
  });

  it("returns a finalization materialization item for terminal runs", async () => {
    const db = new ObservedDb();
    const config = loadConfig({
      SERVER_DATABASE_URL: shared.connectionUri,
    });
    const finalizer = {
      async finalize(runId: string, spaceId: string): Promise<RunFinalizationRecord> {
        return {
          id: `${spaceId}:${runId}:finalization`,
          space_id: spaceId,
          run_id: runId,
          attempt_number: 1,
          finalizer_version: "post_run_finalization.v1",
          status: "completed",
          run_evaluation_id: "evaluation-1",
          task_evaluation_id: "task-evaluation-1",
          outcome_status: "passed",
          failure_layer: null,
          failure_reason_code: null,
          trajectory_status: "acceptable",
          skipped_reasons_json: [],
          error_json: null,
          metadata_json: {},
          finalized_at: "2026-06-12T10:00:00.000Z",
          created_at: "2026-06-12T10:00:00.000Z",
          settled_at: new Date().toISOString(),
          settlement_attempts: 1,
          settlement_json: { completed: [] },
        };
      },
    };
    const service = new RunMaterializationService(
      config,
      db,
      finalizer,
      async () => ({ status: "allow" }),
    );

    const result = await service.finalizeRun(run({ status: "succeeded" }));

    expect(result).toMatchObject({
      kind: "activity",
      status: "succeeded",
      activity_id: "space-1:run-1:finalization",
      metadata_json: {
        run_finalization_id: "space-1:run-1:finalization",
        run_evaluation_id: "evaluation-1",
        task_evaluation_id: "task-evaluation-1",
      },
    });
  });
});
