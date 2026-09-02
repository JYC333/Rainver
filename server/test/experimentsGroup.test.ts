import { randomUUID } from "node:crypto";
import { seedServerHost, seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeExecutorConfig } from "../src/modules/experiments/common.js";
import { ExperimentDefinitionService } from "../src/modules/experiments/definitionService.js";
import { ExperimentInterpretationService } from "../src/modules/experiments/interpretationService.js";
import { ExperimentRunService } from "../src/modules/experiments/runService.js";
import { InquirySignalService } from "../src/modules/inquiry/signalService.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("experimentsCommon", () => {
  describe("Experiment executor configuration", () => {
    const base = {
      project_folder_id: "workspace-1",
      editable_scope: ["src/variants"],
      protected_scope: ["src/core"],
    };

    it.each([
      ["zero time budget", { ...base, time_budget_seconds: 0 }],
      ["negative timeout", { ...base, timeout_seconds: -1 }],
      ["fractional timeout", { ...base, timeout_seconds: 1.5 }],
      ["infinite budget", { ...base, time_budget_seconds: Number.POSITIVE_INFINITY }],
    ])("rejects %s", (_label, config) => {
      expect(() => normalizeExecutorConfig("managed_code_comparison", config))
        .toThrow(/positive integer/);
    });

    it("keeps positive integer budgets in the immutable normalized config", () => {
      expect(normalizeExecutorConfig("managed_code_comparison", {
        ...base,
        time_budget_seconds: 600,
        timeout_seconds: 120,
      })).toMatchObject({
        time_budget_seconds: 600,
        timeout_seconds: 120,
      });
    });
  });
});

describe("experimentsDb", () => {
  // Real-Postgres coverage for the Experiment Domain: Definition
  // -> Version (manual or managed_code_comparison) -> Run -> Observation ->
  // Interpretation -> convert to Inquiry Evidence Signal. Replaces the earlier
  // project_experiment_campaigns/runs/provenance model — managed_code_comparison
  // is one executor_type here, not a second Experiment concept (see
  // projectResearchIntegrityDb.test.ts for the retargeted integrity check).

  const SPACE = "11111111-1111-4111-8111-111111111111";
  const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT = "55555555-5555-4555-8555-555555555555";
  const WORKSPACE = "88888888-8888-4888-8888-888888888888";
  const AGENT = "99999999-9999-4999-8999-999999999999";
  const AGENT_VERSION = "99999999-9999-4999-8999-999999999998";
  const HOST = "77777777-7777-4777-8777-777777777777";

  const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

  const db = useTestDatabase(`${import.meta.filename}#experimentsDb`);

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["experiment_interpretations", "experiment_observations", "experiment_runs", "experiment_versions", "experiment_definitions", "inquiry_evidence_signals", "inquiry_signal_candidates", "inquiry_threads", "workspace_locations", "project_folders", "projects", "space_memberships", "users", "spaces", "hosts", "machines"],
      { cascade: true },
    );
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
    await seedServerHost(db.pool, { id: HOST, now });
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Research','active',$4,$4)`,
      [PROJECT, SPACE, OWNER, now],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status, kind, is_primary, protected, system_managed, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Experiment Folder','active','code',true,false,false,$5,$5)`,
      [WORKSPACE, SPACE, PROJECT, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'server','/tmp/experiment-folder',true,'active',$5,$5)`,
      [randomUUID(), SPACE, WORKSPACE, HOST, now],
    );
    await db.pool.query(
      `INSERT INTO agents (id,space_id,owner_user_id,name,status,current_version_id,visibility,created_at,updated_at)
       VALUES ($1,$2,$3,'Experiment Agent','active',NULL,'private',$4,$4)`,
      [AGENT, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (
         id,agent_id,space_id,version_label,system_prompt,model_config_json,runtime_config_json,
         context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,runtime_policy_json,created_at
       ) VALUES ($1,$2,$3,'v1','Execute governed experiments.','{}','{}','{}','{}','[]','{}','{}',$4)`,
      [AGENT_VERSION, AGENT, SPACE, now],
    );
    await db.pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, AGENT_VERSION]);
  });

  async function createCorpusItem(): Promise<string> {
    const objectId = randomUUID();
    const corpusItemId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, 'source', 'A source', 'private', $3, $4, $4)`,
      [objectId, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_items (id, space_id, project_id, object_id, role, status, triage_status, read_status, metadata_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'candidate', 'active', 'new', 'unread', '{}'::jsonb, $5, $5)`,
      [corpusItemId, SPACE, PROJECT, objectId, now],
    );
    return corpusItemId;
  }

  describe("Experiment Domain (real Postgres)", () => {
    it("runs a manual Experiment end to end and converts a reviewed Interpretation into a material Evidence Signal that accepts into an Iteration", async () => {
      if (!db.available) return;
      const threadSvc = new InquiryThreadService(db.pool);
      const hypothesis = await threadSvc.createThread(identity, PROJECT, {
        kind: "hypothesis", statement: "Caching reduces tail latency by 40%",
      });

      const definitions = new ExperimentDefinitionService(db.pool);
      const definition = await definitions.createDefinition(identity, PROJECT, {
        name: "Cache warm-up experiment", objective: "Measure p95 latency with cache warm-up enabled",
        primary_hypothesis_thread_id: hypothesis.id,
      });
      expect(definition).toMatchObject({ status: "draft", primary_hypothesis_thread_id: hypothesis.id });

      const version = await definitions.createVersion(identity, PROJECT, definition.id as string, {
        executor_type: "manual", planned_summary: "Manually run the warm cache path and record p95 latency.",
      });
      expect(version).toMatchObject({ version: 1, executor_type: "manual", status: "draft" });
      await expect(definitions.createVersion(identity, PROJECT, definition.id as string, {
        executor_type: "manual", status: "approved",
      })).rejects.toMatchObject({ statusCode: 422 });
      const runs = new ExperimentRunService(db.pool);
      await expect(runs.createRun(identity, PROJECT, definition.id as string, version.id as string, {}))
        .rejects.toMatchObject({ statusCode: 409 });
      const approvedVersion = await definitions.approveVersion(identity, PROJECT, definition.id as string, version.id as string);
      expect(approvedVersion).toMatchObject({ status: "approved" });

      const baseline = await runs.createRun(identity, PROJECT, definition.id as string, version.id as string, {
        is_baseline: true, hypothesis: "Cold cache p95",
      });
      const unrelatedHypothesis = await threadSvc.createThread(identity, PROJECT, {
        kind: "hypothesis", statement: "A different post-hoc target",
      });
      await expect(definitions.updateDefinition(identity, PROJECT, definition.id as string, {
        primary_hypothesis_thread_id: unrelatedHypothesis.id,
      })).rejects.toMatchObject({ statusCode: 409 });
      await expect(runs.createRun(identity, PROJECT, definition.id as string, version.id as string, {
        is_baseline: true, hypothesis: "Conflicting baseline",
      })).rejects.toMatchObject({ statusCode: 409 });
      const jsonObservation = await runs.recordObservation(
        identity,
        PROJECT,
        definition.id as string,
        baseline.id as string,
        { metric_name: "feature_enabled", value_json: false },
      );
      expect(jsonObservation.value_json).toBe(false);
      const completedBaseline = await runs.completeRun(identity, PROJECT, definition.id as string, baseline.id as string, {
        status: "completed",
        observations: [{ metric_name: "p95_latency_ms", value_number: 220, is_primary: true }],
      });
      expect(completedBaseline).toMatchObject({ status: "completed" });
      expect((completedBaseline.observations as unknown[])).toHaveLength(2);

      const candidateRun = await runs.createRun(identity, PROJECT, definition.id as string, version.id as string, {
        is_baseline: false, hypothesis: "Warm cache p95",
      });
      await runs.completeRun(identity, PROJECT, definition.id as string, candidateRun.id as string, {
        status: "completed", mark_as_best: true,
        observations: [{ metric_name: "p95_latency_ms", value_number: 128, is_primary: true }],
      });

      const afterRuns = await definitions.getDefinition(identity, PROJECT, definition.id as string);
      expect(afterRuns).toMatchObject({ baseline_run_id: baseline.id, best_run_id: candidateRun.id });

      const interpretations = new ExperimentInterpretationService(db.pool);
      const interpretation = await interpretations.createInterpretation(identity, PROJECT, definition.id as string, {
        run_ids: [baseline.id, candidateRun.id], verdict: "supports",
        conclusion: "Cache warm-up reduced p95 latency by 42%, supporting the Hypothesis.",
      });
      expect(interpretation).toMatchObject({ status: "draft", resulting_signal_id: null });
      const signalSvc = new InquirySignalService(db.pool);
      await expect(signalSvc.createSignal(identity, PROJECT, hypothesis.id as string, {
        classification: "supports",
        experiment_interpretation_id: interpretation.id,
        is_material: true,
      })).rejects.toMatchObject({ statusCode: 422 });

      await expect(interpretations.convertToSignal(identity, PROJECT, interpretation.id as string, {}))
        .rejects.toMatchObject({ statusCode: 409 });

      const reviewed = await interpretations.markReviewed(identity, PROJECT, interpretation.id as string);
      expect(reviewed.status).toBe("reviewed");

      const converted = await interpretations.convertToSignal(identity, PROJECT, interpretation.id as string, {});
      expect(converted.status).toBe("converted");
      expect(converted.resulting_signal_id).toBeTruthy();
      const signal = converted.signal as Record<string, unknown>;
      expect(signal).toMatchObject({
        classification: "supports", is_material: true, status: "consolidated",
        corpus_item_id: null, experiment_interpretation_id: interpretation.id,
      });

      // The Signal enters the same material-consolidation path as a
      // literature-sourced Signal — one open Candidate, reviewable and
      // acceptable through the existing Candidate review flow unchanged.
      const candidates = await signalSvc.listCandidates(identity, PROJECT, "pending");
      expect(candidates).toHaveLength(1);
      const accepted = await signalSvc.decideCandidate(identity, PROJECT, (candidates[0] as Record<string, unknown>).id as string, {
        decision: "accept", change_summary: "Confirmed by cache warm-up experiment",
      });
      expect(accepted.status).toBe("accepted");
      expect(accepted.resulting_iteration_id).toBeTruthy();

      // A converted Interpretation is immutable; converting twice is refused.
      await expect(interpretations.convertToSignal(identity, PROJECT, interpretation.id as string, {}))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it("enforces managed_code_comparison config validation and baseline-first Run ordering", async () => {
      if (!db.available) return;
      const hypothesis = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
        kind: "hypothesis",
        statement: "The managed comparison improves the target metric",
      });
      const definitions = new ExperimentDefinitionService(db.pool);
      const definition = await definitions.createDefinition(identity, PROJECT, {
        name: "Prompt A/B",
        primary_hypothesis_thread_id: hypothesis.id,
      });

      await expect(definitions.createVersion(identity, PROJECT, definition.id as string, {
        executor_type: "managed_code_comparison", config: { editable_scope: ["src/prompts"], protected_scope: ["src/prompts/core"] },
      })).rejects.toMatchObject({ statusCode: 422 });

      await expect(definitions.createVersion(identity, PROJECT, definition.id as string, {
        executor_type: "managed_code_comparison",
        config: { project_folder_id: WORKSPACE, editable_scope: ["src/prompts"], protected_scope: ["src/prompts"] },
      })).rejects.toMatchObject({ statusCode: 422 });

      const version = await definitions.createVersion(identity, PROJECT, definition.id as string, {
        executor_type: "managed_code_comparison",
        config: {
          project_folder_id: WORKSPACE, editable_scope: ["src/prompts/variants"], protected_scope: ["src/prompts/core"],
          run_command: "npm test", setup_commands: ["npm install"], metric_parser: { format: "json" },
          time_budget_seconds: 600, timeout_seconds: 120, resource_budget: { cpu: 2 },
        },
      });
      expect(version.config).toMatchObject({
        project_folder_id: WORKSPACE, editable_scope: ["src/prompts/variants"], protected_scope: ["src/prompts/core"], run_command: "npm test",
      });
      await definitions.approveVersion(identity, PROJECT, definition.id as string, version.id as string);

      const runs = new ExperimentRunService(db.pool);
      await expect(runs.createRun(identity, PROJECT, definition.id as string, version.id as string, { is_baseline: false }))
        .rejects.toMatchObject({ statusCode: 422 });

      const baseline = await runs.createRun(identity, PROJECT, definition.id as string, version.id as string, { is_baseline: true });
      expect(baseline.config_snapshot).toMatchObject({ project_folder_id: WORKSPACE });
      await runs.completeRun(identity, PROJECT, definition.id as string, baseline.id as string, { status: "completed" });

      // Now that a baseline exists (and is completed), a non-baseline Run is allowed.
      const candidateRun = await runs.createRun(identity, PROJECT, definition.id as string, version.id as string, { is_baseline: false });
      expect(candidateRun.is_baseline).toBe(false);

      const launched = await runs.launchManagedRun(
        identity,
        PROJECT,
        definition.id as string,
        version.id as string,
        { agent_id: AGENT, is_baseline: false, hypothesis: "Managed candidate" },
      );
      expect(launched).toMatchObject({ status: "queued", is_baseline: false });
      expect(launched.run_id).toBeTruthy();
      const managedRunId = launched.run_id as string;
      expect((await db.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=$1`,
        [managedRunId],
      )).rows[0]?.count).toBe(1);
      await db.pool.query(
        `UPDATE runs SET status='succeeded',output_json=$3::jsonb,ended_at=$4,updated_at=$4 WHERE id=$1 AND space_id=$2`,
        [managedRunId, SPACE, JSON.stringify({ experiment_metrics: { accuracy: 0.91, notes: "stable" } }), new Date().toISOString()],
      );
      await expect(runs.reconcileManagedRun(SPACE, managedRunId)).resolves.toBe(true);
      await expect(runs.reconcileManagedRun(SPACE, managedRunId)).resolves.toBe(false);
      expect((await runs.listRuns(identity, PROJECT, definition.id as string))
        .find(row => row.id === launched.id)).toMatchObject({ status: "completed" });
      const observations = await runs.listObservations(identity, PROJECT, definition.id as string, launched.id as string);
      expect(observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ metric_name: "accuracy", value_number: 0.91, source: "parsed" }),
      ]));
    });

    it("requires a primary Hypothesis Thread before the first Run, and the DB rejects a Signal with both or neither source", async () => {
      if (!db.available) return;
      const definitions = new ExperimentDefinitionService(db.pool);
      const definition = await definitions.createDefinition(identity, PROJECT, { name: "No hypothesis yet" });
      const version = await definitions.createVersion(identity, PROJECT, definition.id as string, { executor_type: "manual" });
      const runs = new ExperimentRunService(db.pool);
      await expect(runs.createRun(identity, PROJECT, definition.id as string, version.id as string, { is_baseline: true }))
        .rejects.toMatchObject({ statusCode: 409 });

      const threadSvc = new InquiryThreadService(db.pool);
      const primary = await threadSvc.createThread(identity, PROJECT, {
        kind: "hypothesis", statement: "The primary target must be fixed before evidence collection",
      });
      await definitions.updateDefinition(identity, PROJECT, definition.id as string, {
        primary_hypothesis_thread_id: primary.id,
      });
      await definitions.approveVersion(identity, PROJECT, definition.id as string, version.id as string);
      const run = await runs.createRun(identity, PROJECT, definition.id as string, version.id as string, { is_baseline: true });
      await runs.completeRun(identity, PROJECT, definition.id as string, run.id as string, { status: "completed" });

      const interpretations = new ExperimentInterpretationService(db.pool);
      const interpretation = await interpretations.createInterpretation(identity, PROJECT, definition.id as string, {
        run_ids: [run.id], verdict: "inconclusive",
      });
      await interpretations.markReviewed(identity, PROJECT, interpretation.id as string);
      await expect(interpretations.convertToSignal(identity, PROJECT, interpretation.id as string, {}))
        .resolves.toMatchObject({ status: "converted" });

      const thread = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Constraint probe Thread" });
      const now = new Date().toISOString();
      await expect(db.pool.query(
        `INSERT INTO inquiry_evidence_signals (id, space_id, project_id, thread_id, corpus_item_id, experiment_interpretation_id, classification, is_material, dedupe_key, status, created_at)
         VALUES ($1,$2,$3,$4,NULL,NULL,'supports',false,'dk-neither','pending',$5)`,
        [randomUUID(), SPACE, PROJECT, thread.id, now],
      )).rejects.toThrow(/ck_inquiry_evidence_signals_one_source/);
      const corpusItemId = await createCorpusItem();
      await expect(db.pool.query(
        `INSERT INTO inquiry_evidence_signals (id, space_id, project_id, thread_id, corpus_item_id, experiment_interpretation_id, classification, is_material, dedupe_key, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'supports',false,'dk-both','pending',$7)`,
        [randomUUID(), SPACE, PROJECT, thread.id, corpusItemId, interpretation.id, now],
      )).rejects.toThrow(/ck_inquiry_evidence_signals_one_source/);
    });

    it("rejects cross-domain provenance links and non-Hypothesis primary Threads", async () => {
      if (!db.available) return;
      const threads = new InquiryThreadService(db.pool);
      const question = await threads.createThread(identity, PROJECT, {
        kind: "question",
        statement: "This is not a hypothesis",
      });
      const definitions = new ExperimentDefinitionService(db.pool);
      await expect(definitions.createDefinition(identity, PROJECT, {
        name: "Invalid primary Thread",
        primary_hypothesis_thread_id: question.id,
      })).rejects.toMatchObject({ statusCode: 422 });

      const hypothesis = await threads.createThread(identity, PROJECT, {
        kind: "hypothesis",
        statement: "The linked managed Run preserves provenance",
      });
      const definition = await definitions.createDefinition(identity, PROJECT, {
        name: "Provenance guards",
        primary_hypothesis_thread_id: hypothesis.id,
      });
      await expect(definitions.createVersion(identity, PROJECT, definition.id as string, {
        executor_type: "managed_code_comparison",
        config: {
          project_folder_id: randomUUID(),
          editable_scope: ["src/variants"],
          protected_scope: ["src/core"],
        },
      })).rejects.toMatchObject({ statusCode: 404 });

      const manualVersion = await definitions.createVersion(identity, PROJECT, definition.id as string, {
        executor_type: "manual",
      });
      await definitions.approveVersion(identity, PROJECT, definition.id as string, manualVersion.id as string);
      const runs = new ExperimentRunService(db.pool);
      await expect(runs.createRun(identity, PROJECT, definition.id as string, manualVersion.id as string, {
        run_id: randomUUID(),
      })).rejects.toMatchObject({ statusCode: 422 });

      const experimentRun = await runs.createRun(
        identity,
        PROJECT,
        definition.id as string,
        manualVersion.id as string,
        {},
      );
      await runs.completeRun(identity, PROJECT, definition.id as string, experimentRun.id as string, {
        status: "completed",
      });
      await expect(runs.completeRun(identity, PROJECT, definition.id as string, experimentRun.id as string, {
        status: "failed",
      })).rejects.toMatchObject({ statusCode: 409 });
      await expect(runs.recordObservation(identity, PROJECT, definition.id as string, experimentRun.id as string, {
        metric_name: "late_result",
        value_number: 1,
      })).rejects.toMatchObject({ statusCode: 409 });

      const interpretations = new ExperimentInterpretationService(db.pool);
      await expect(interpretations.createInterpretation(identity, PROJECT, definition.id as string, {
        run_ids: [randomUUID()],
        verdict: "supports",
      })).rejects.toMatchObject({ statusCode: 422 });

      const queuedRun = await runs.createRun(
        identity,
        PROJECT,
        definition.id as string,
        manualVersion.id as string,
        {},
      );
      await expect(interpretations.createInterpretation(identity, PROJECT, definition.id as string, {
        run_ids: [queuedRun.id],
        verdict: "supports",
      })).rejects.toMatchObject({ statusCode: 422 });
    });
  });
});
