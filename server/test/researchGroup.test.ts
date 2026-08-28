import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as protocol from "@rainver/protocol";
import type { ResearchContext, ResearchProviderKey, ResearchSemanticQuery } from "@rainver/protocol";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { ProjectResearchDiscoveryBridge } from "../src/modules/projectResearch/pipeline/researchDiscoveryBridge.js";
import { ResearchContextRepository } from "../src/modules/projectResearch/question/researchContextRepository.js";
import { BLOCKING_CHECKPOINT_TYPES, checkpointBlocks, SCREENING_AUTO_CONTINUE_CORPUS_LIMIT, screeningExceedsAutoBudget, waiveCheckpointAutomatically } from "../src/modules/projectResearch/researchCheckpointPolicy.js";
import { ResearchMonitorMaterializer } from "../src/modules/research/discovery/monitorMaterializer.js";
import { ResearchStrategyActivationService } from "../src/modules/research/discovery/strategyActivationService.js";
import { heuristicResearchIntent, RESEARCH_INTENT_OUTPUT_CONTRACT } from "../src/modules/research/queryPlanning/intentPlanner.js";
import { ResearchProviderCompiler } from "../src/modules/research/queryPlanning/providerCompiler.js";
import { MAX_RESEARCH_QUERY_ATTEMPTS } from "../src/modules/research/queryPlanning/queryPolicy.js";
import { ResearchQueryRepository } from "../src/modules/research/queryPlanning/repository.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { SourceChannelService } from "../src/modules/sources/channels/sourceChannelService.js";
import { SearchExecutionAdapter } from "../src/modules/sources/search/searchExecutionAdapter.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("researchCheckpointPolicy", () => {
  // The checkpoint reform's decision table. These assertions are
  // the product decision written down: changing one means the reform changed,
  // not that a test needs updating.

  describe("research checkpoint policy", () => {
    it("keeps a blocking gate only for the external-facing manuscript step", () => {
      expect(checkpointBlocks("manuscript_gate")).toBe(true);
      for (const type of ["idea_review", "integrity_gate", "review_gate", "other"]) {
        expect(checkpointBlocks(type)).toBe(false);
      }
      expect([...BLOCKING_CHECKPOINT_TYPES]).toEqual(["manuscript_gate"]);
    });

    it("the screening budget blocks only when the corpus exceeds the auto-continue limit", () => {
      const under = { relevant: 10, maybe: 5 };
      const at = { relevant: SCREENING_AUTO_CONTINUE_CORPUS_LIMIT, maybe: 0 };
      const over = { relevant: SCREENING_AUTO_CONTINUE_CORPUS_LIMIT, maybe: 1 };

      expect(screeningExceedsAutoBudget(under)).toBe(false);
      expect(screeningExceedsAutoBudget(at)).toBe(false);
      expect(screeningExceedsAutoBudget(over)).toBe(true);
      // `checkpointBlocks` deliberately answers only the unconditional half:
      // an earlier signature that took the counts as an optional context bag
      // failed open when a caller forgot them. The screening site must combine
      // both predicates explicitly.
      expect(checkpointBlocks("screening_gate")).toBe(false);
    });

    it("counts maybe items against the budget, since they reach synthesis too", () => {
      const counts = { relevant: SCREENING_AUTO_CONTINUE_CORPUS_LIMIT - 1, maybe: 5 };
      expect(screeningExceedsAutoBudget(counts)).toBe(true);
    });

    it("records an automatic waiver without attributing it to a person", async () => {
      const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      await waiveCheckpointAutomatically({ query } as unknown as Queryable, "space", "checkpoint", "why");

      const [sql, params] = query.mock.calls[0]!;
      expect(sql).toContain("status='waived'");
      // decided_by_user_id and user_decision are deliberately untouched: an
      // audit must be able to tell that nobody looked at this checkpoint.
      expect(sql).not.toContain("decided_by_user_id");
      expect(sql).not.toContain("user_decision");
      expect(sql).toContain("status='pending'");
      expect(params).toEqual(["checkpoint", "space", "why", expect.any(String)]);
    });
  });
});

describe("researchGeneralizationGuard", () => {
  const repoRoot = join(process.cwd(), "..");

  function source(path: string): string {
    return readFileSync(join(repoRoot, path), "utf8");
  }

  function treeSources(path: string): string {
    const absolute = join(repoRoot, path);
    return readdirSync(absolute, { withFileTypes: true })
      .flatMap(entry => {
        const child = join(path, entry.name);
        if (entry.isDirectory()) return treeSources(child);
        return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [source(child)] : [];
      })
      .join("\n");
  }

  describe("Project Research generalization boundaries", () => {
    it("does not restore label-only research workflow presets or academic execution ids", () => {
      const pack = source("server/src/modules/capabilities/researchPack.ts");
      const execution = [
        source("server/src/modules/projectResearch/researchPassExecution.ts"),
        source("server/src/modules/projectResearch/synthesisOnlyExecution.ts"),
      ].join("\n");

      // The pack used to carry an empty `workflow_template_ids: []` to prove no
      // label-only preset had crept back. The workflow template layer is gone
      // entirely, so the absence of the field is the stronger form of the same
      // guard: there is nothing left for a preset to be declared in.
      expect(pack).not.toContain("workflow_template_ids");
      for (const retired of [
        "research.academic_literature_review",
        "research.news_scan",
        "research.market_research",
        "research.technical_survey",
        "academic_literature_review",
        "academic_research_workflow_execution",
      ]) {
        expect(`${pack}\n${execution}`).not.toContain(retired);
      }
      expect(execution).toContain('"project_research.reconcile_pass"');
      expect(execution).toContain('"project_research.synthesis_only"');
    });

    it("keeps generic Research surfaces free of paper/literature-only wording", () => {
      const genericSurfaces = [
        "apps/web/src/modules/projects/FocusResearchWorkbench.tsx",
        "apps/web/src/modules/projects/ResearchCheckpointReview.tsx",
        "apps/web/src/modules/projects/ResearchScanTimeline.tsx",
        "apps/web/src/modules/projects/ResearchSetupSummary.tsx",
        "apps/web/src/modules/projects/researchArea/ResearchRunsTab.tsx",
        "apps/web/src/modules/projects/researchArea/ReadingListView.tsx",
        // The Research Area page replaced the ProjectResearchWorkbench wrapper
        // as the surface that composes standing and focus; useProjectResearch
        // holds the copy that used to sit in the Project Overview.
        "apps/web/src/modules/projects/ResearchAreaPage.tsx",
        "apps/web/src/modules/projects/ResearchSettingsCard.tsx",
        "apps/web/src/modules/projects/useProjectResearch.ts",
        "apps/web/src/modules/projects/ProjectResearchStandingPanel.tsx",
        "apps/web/src/modules/projects/ProjectDetailPage.tsx",
        "apps/web/src/modules/projects/ProjectSourcesPage.tsx",
      ].map(source).join("\n");

      expect(genericSurfaces).not.toMatch(/\b(?:paper|papers|literature)\b/i);
      expect(genericSurfaces).not.toContain("Academic research");
    });

    it("keeps Template provenance out of Project runtime capability decisions", () => {
      const projectBackend = treeSources("server/src/modules/projects");
      const genericFrontend = [
        "apps/web/src/modules/projects/ProjectDetailPage.tsx",
        "apps/web/src/modules/projects/ProjectSourcesPage.tsx",
        "apps/web/src/modules/projects/ResearchAreaPage.tsx",
        "apps/web/src/modules/projects/useProjectResearch.ts",
      ].map(source).join("\n");
      const genericExecution = [
        "server/src/modules/projectResearch/researchPassExecution.ts",
        "server/src/modules/projectResearch/synthesisOnlyExecution.ts",
        "server/src/modules/projectResearch/standingComparisonService.ts",
      ].map(source).join("\n");

      expect(projectBackend).not.toMatch(/from\s+["'][^"']*\/academic\//);
      expect(projectBackend).not.toContain("academic_paper_v1");
      expect(source("server/src/modules/projects/projectSourceProposalApplier.ts"))
        .not.toContain("ProjectSourceBindingRepository");
      expect(genericExecution).not.toContain("academic_paper_v1");
      expect(genericFrontend).not.toContain("ACADEMIC_TEMPLATE_KEY");
      expect(genericFrontend).not.toContain("templateKeyFromProject");
      expect(genericFrontend).not.toContain("academic_research");
    });

    it("keeps generic backend Research ownership and setup wording domain-neutral", () => {
      const backend = [
        "server/src/db/schema/projectResearch.ts",
        "server/src/modules/projectResearch/areaService.ts",
        "server/src/modules/projectResearch/standingComparisonService.ts",
        "server/src/modules/projectResearch/researchPassExecution.ts",
        "server/src/modules/projectResearch/synthesisOnlyExecution.ts",
      ].map(source).join("\n");
      expect(backend).not.toMatch(/Project-owned Academic Research|focus paper triage|academic sources only/i);
      expect(backend).not.toMatch(/\b(?:paper|papers|literature)\b/i);
      expect(source("apps/web/src/modules/projects/ResearchSetupDialog.tsx"))
        .not.toContain("Academic sources only");
    });

    it("keeps standing advice on the shared object-action inventory", async () => {
      const { systemActionsForObjectType } = await import("@rainver/protocol");
      expect(systemActionsForObjectType("source").map((definition) => definition.id))
        .toEqual(["source.raise_as_question"]);
    });
  });
});

describe("researchIntentPlanner", () => {
  describe("ResearchIntentPlanner", () => {
    it("extracts bounded concepts instead of copying the research question", () => {
      const context: ResearchContext = {
        schema_version: "research_context.v1",
        objective: "How can retrieval augmented memory help an LLM agent preserve useful context across many separate user sessions without accumulating stale information?",
        sub_questions: ["Which evaluation benchmarks measure cross-session recall?"],
        in_scope: ["long-lived LLM agent memory systems"],
        out_of_scope: ["human autobiographical memory research"],
        must_have: ["must report an empirical evaluation method"],
        nice_to_have: ["public benchmark dataset"],
        time_window: null,
        source_scope: { providers: ["arxiv"], include_web: false },
      };

      const intent = heuristicResearchIntent(context);
      expect(intent.core[0]?.value).toBe("long lived LLM agent");
      expect(intent.core.map((concept) => concept.value)).not.toContain(context.objective);
      expect([...intent.core, ...intent.qualifiers, ...intent.exclusions].every((concept) => concept.value.split(" ").length <= 4)).toBe(true);
      expect(intent.qualifiers.map((concept) => concept.value)).toContain("evaluation");
      expect(intent.exclusions[0]?.value).toBe("human autobiographical memory research");
    });

    it("keeps provider-native fields out of the structured intent contract", () => {
      const properties = RESEARCH_INTENT_OUTPUT_CONTRACT.schema.properties;
      expect(Object.keys(properties)).toEqual(["core", "expansions", "qualifiers", "exclusions"]);
      expect(JSON.stringify(properties)).not.toContain("search_query");
      expect(JSON.stringify(properties)).not.toContain("provider_key");
    });

    it("segments an unspaced Chinese question instead of storing it as one long concept", () => {
      const context: ResearchContext = {
        schema_version: "research_context.v1",
        objective: "如何评估大型语言模型智能体在跨会话场景中的长期记忆检索能力和信息过期问题",
        sub_questions: [], in_scope: [], out_of_scope: [], must_have: [], nice_to_have: [],
        time_window: null,
        source_scope: { providers: ["openalex"], include_web: false },
      };
      const intent = heuristicResearchIntent(context);
      expect(intent.core).toHaveLength(3);
      expect(intent.core.every((concept) => concept.value.length < context.objective.length)).toBe(true);
    });
  });
});

describe("researchMonitorMaterializerDb", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT = "55555555-5555-4555-8555-555555555555";
  const CONNECTOR = "66666666-6666-4666-8666-666666666666";


  const db = useTestDatabase(`${import.meta.filename}#researchMonitorMaterializerDb`);

  beforeAll(async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Research','personal',$2,$2)`, [SPACE, now]);
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), SPACE, USER, now],
    );
    await db.pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
       VALUES ($1,$2,$3,'Project','active',$4,$4)`,
      [PROJECT, SPACE, USER, now],
    );
    await db.pool.query(
      `INSERT INTO source_connectors (
         id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at
       ) VALUES ($1,'openalex_api','OpenAlex','external_feed','pull','active','{}'::jsonb,$2,$2)`,
      [CONNECTOR, now],
    );
    const providerId = randomUUID();
    await db.pool.query(
      `INSERT INTO source_providers (
         id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at
       ) VALUES ($1,'openalex','OpenAlex','generic','academic','active','{}'::jsonb,$2,$2)`,
      [providerId, now],
    );
    await db.pool.query(
      `INSERT INTO source_provider_connectors (
         id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
      [randomUUID(), providerId, CONNECTOR, now],
    );
  });

  describe("research monitor materialization (real Postgres)", () => {
    it("atomically materializes the selected compiled query and is idempotent", async () => {
      if (!db.available) return;
      const identity = { spaceId: SPACE, userId: USER };
      const context = await new ResearchContextRepository(db.pool).create(identity, PROJECT, validContext());
      const queries = new ResearchQueryRepository(db.pool);
      const strategy = await queries.createStrategy(identity, {
        projectId: PROJECT,
        researchContextVersionId: context.id,
        providers: ["openalex"],
        policyVersion: "adaptive-recall.v1",
        policy: {},
        executionBudget: { candidate_budget: 100 },
      });
      await queries.markStrategyEvaluating(SPACE, strategy.id);
      const plan = strategy.provider_plans[0]!;
      const compiled = {
        schema_version: "research_compiled_query.v1" as const,
        provider_key: "openalex" as const,
        query: { search: "agent memory", per_page: 15 },
        fingerprint: "1234567890abcdef1234567890abcdef",
      };
      const attempt = await queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: 0,
        sequence: 1,
        direction: "initial",
        semanticQuery: semanticQuery(),
        compiledQuery: compiled,
      });
      await queries.completeAttempt(SPACE, attempt.id, {
        observation: {
          schema_version: "research_preview_observation.v1",
          provider_hit_count: 20,
          accessible_hit_count: 20,
          samples: [],
          relevance_rate: 0.8,
          relevance_lower_bound: 0.6,
          diversity_score: 0.7,
          duplicate_rate: 0,
        },
        score: 0.8,
        decision: "accept",
      });
      await queries.selectAttempt(SPACE, plan.id, attempt.id, { terminalDecision: "accept" });
      await queries.finalizeStrategy(SPACE, strategy.id);

      const materializer = new ResearchMonitorMaterializer(db.pool, {} as ServerConfig);
      const first = await materializer.materialize(identity, strategy.id, { providerKeys: ["openalex"] });
      const second = await materializer.materialize(identity, strategy.id, { providerKeys: ["openalex"] });
      expect(second).toEqual(first);
      expect(first.sources).toHaveLength(1);
      await expect(new SourceChannelService(db.pool, {} as ServerConfig).update(
        identity,
        first.sources[0]!.source_channel_id,
        { status: "paused" },
      )).resolves.toMatchObject({ status: "paused", provider_query: compiled.query });

      const stored = await db.pool.query(
        `SELECT ch.query_json,ch.provider_query_json,ch.query_fingerprint AS legacy_query_fingerprint,
                ss.compiled_provider_query_json,ss.query_fingerprint AS spec_query_fingerprint,ss.research_query_attempt_id
           FROM source_channels ch
           JOIN source_search_specs ss ON ss.source_channel_id=ch.id
          WHERE ch.id=$1`,
        [first.sources[0]!.source_channel_id],
      );
      expect(stored.rows[0]).toMatchObject({
        query_json: null,
        provider_query_json: null,
        legacy_query_fingerprint: null,
        compiled_provider_query_json: compiled.query,
        spec_query_fingerprint: compiled.fingerprint,
        research_query_attempt_id: attempt.id,
      });
      const bridge = await new ProjectResearchDiscoveryBridge(db.pool).resolve(identity, PROJECT, strategy.id);
      expect(bridge).toEqual({
        question: validContext().objective,
        sourceChannelIds: [first.sources[0]!.source_channel_id],
        scope: {
          sub_questions: validContext().sub_questions,
          in: validContext().in_scope,
          out: validContext().out_of_scope,
          must_have: validContext().must_have,
          nice_to_have: validContext().nice_to_have,
        },
      });

      const replacement = await queries.createStrategy(identity, {
        projectId: PROJECT,
        researchContextVersionId: context.id,
        providers: ["openalex"],
        policyVersion: "adaptive-recall.v1",
        policy: {},
        executionBudget: { candidate_budget: 100 },
        parentStrategyId: strategy.id,
        adaptationDirection: "broaden",
      });
      await queries.markStrategyEvaluating(SPACE, replacement.id);
      const replacementPlan = replacement.provider_plans[0]!;
      const replacementAttempt = await queries.createAttempt(SPACE, {
        providerPlanId: replacementPlan.id,
        round: 0,
        sequence: 1,
        direction: "broaden",
        semanticQuery: semanticQuery(),
        compiledQuery: { ...compiled, query: { search: "agent memory evaluation", per_page: 15 }, fingerprint: "abcdef1234567890abcdef1234567890" },
      });
      await queries.completeAttempt(SPACE, replacementAttempt.id, { observation: {
        schema_version: "research_preview_observation.v1", provider_hit_count: 30, accessible_hit_count: 30,
        samples: [], relevance_rate: 0.7, relevance_lower_bound: 0.5, diversity_score: 0.7, duplicate_rate: 0,
      }, score: 0.75, decision: "accept" });
      await queries.selectAttempt(SPACE, replacementPlan.id, replacementAttempt.id, { terminalDecision: "accept" });
      await queries.finalizeStrategy(SPACE, replacement.id);
      const liveOperationId = randomUUID();
      await db.pool.query(
        `INSERT INTO project_operations (
           id,space_id,project_id,kind,title,status,created_by_user_id,progress_json,created_at,updated_at
         ) VALUES ($1,$2,$3,'research','Active intake','active',$4,$5::jsonb,$6,$6)`,
        [liveOperationId, SPACE, PROJECT, USER, JSON.stringify({
          workflow_id: randomUUID(),
          channel_ids: [first.sources[0]!.source_channel_id],
          query: { source_channel_ids: [first.sources[0]!.source_channel_id] },
        }), new Date().toISOString()],
      );
      await expect(materializer.materialize(identity, replacement.id, {
        providerKeys: ["openalex"], activationReason: "monitoring_feedback",
      })).rejects.toMatchObject({
        statusCode: 409,
        message: "Wait for the active research operation to finish before activating a replacement query strategy",
      });

      await db.pool.query(`UPDATE project_operations SET status='completed',updated_at=$2 WHERE id=$1`, [liveOperationId, new Date().toISOString()]);
      const replacementMaterialized = await materializer.materialize(identity, replacement.id, {
        providerKeys: ["openalex"], activationReason: "monitoring_feedback",
      });
      const switched = await db.pool.query<{ id: string; status: string; scheduler_status: string }>(
        `SELECT ch.id,ch.status,st.status AS scheduler_status
           FROM source_channels ch
           JOIN scheduler_tasks st ON st.space_id=ch.space_id AND st.task_type='source_channel_scan' AND st.task_key=ch.id
          WHERE ch.id=ANY($1::text[]) ORDER BY ch.id`,
        [[first.sources[0]!.source_channel_id, replacementMaterialized.sources[0]!.source_channel_id]],
      );
      expect(switched.rows.find((row) => row.id === first.sources[0]!.source_channel_id)?.status).toBe("archived");
      expect(switched.rows.find((row) => row.id === first.sources[0]!.source_channel_id)?.scheduler_status).toBe("archived");
      expect(switched.rows.find((row) => row.id === replacementMaterialized.sources[0]!.source_channel_id)?.status).toBe("active");

      await new ResearchStrategyActivationService(db.pool).activate({ identity, strategyId: strategy.id, reason: "rollback" });
      const history = await db.pool.query<{ strategy_id: string; reason: string; deactivated_at: string | null }>(
        `SELECT strategy_id,reason,deactivated_at FROM research_query_strategy_activations
          WHERE space_id=$1 AND project_id=$2 ORDER BY sequence`,
        [SPACE, PROJECT],
      );
      expect(history.rows).toHaveLength(3);
      expect(history.rows.at(-1)).toMatchObject({ strategy_id: strategy.id, reason: "rollback", deactivated_at: null });
      const rolledBack = await db.pool.query<{ channel_status: string; scheduler_status: string }>(
        `SELECT ch.status AS channel_status,st.status AS scheduler_status
           FROM source_channels ch
           JOIN scheduler_tasks st ON st.space_id=ch.space_id AND st.task_type='source_channel_scan' AND st.task_key=ch.id
          WHERE ch.id=$1`,
        [first.sources[0]!.source_channel_id],
      );
      expect(rolledBack.rows[0]).toEqual({ channel_status: "active", scheduler_status: "active" });
    });
  });

  function validContext(): ResearchContext {
    return {
      schema_version: "research_context.v1",
      objective: "How should durable agent memory be evaluated?",
      sub_questions: ["Which benchmarks measure recall?"],
      in_scope: ["LLM agent memory"],
      out_of_scope: ["Human memory"],
      must_have: [],
      nice_to_have: [],
      time_window: null,
      source_scope: { providers: ["openalex"], include_web: false },
    };
  }

  function semanticQuery(): ResearchSemanticQuery {
    return {
      schema_version: "research_semantic_query.v1",
      core: [{ value: "agent memory", synonyms: [], weight: 1 }],
      expansions: [],
      qualifiers: [],
      exclusions: [],
      time_window: null,
    };
  }
});

describe("researchProviderCompiler", () => {
  const LONG_QUESTION = "How can retrieval augmented memory help an LLM agent preserve useful context across many separate user sessions without accumulating stale information?";

  describe("ResearchProviderCompiler", () => {
    it.each([
      ["arxiv", "search_query", "(all:agent AND all:memory)"],
      ["openalex", "search", "agent memory retrieval evaluation long-term context"],
      ["semantic_scholar", "query", "agent memory retrieval evaluation long term context"],
      ["web_search", "q", "(\"agent memory\" OR \"memory-augmented agents\")"],
    ] as const)("compiles %s from semantic roles", (provider, field, expected) => {
      const result = new ResearchProviderCompiler().compile(provider, semanticQuery(), { pageSize: 15 });
      expect(String(result.query[field])).toContain(expected);
      expect(JSON.stringify(result.query)).not.toContain(LONG_QUESTION);
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it("uses stable fingerprints and changes them when the executable query changes", () => {
      const compiler = new ResearchProviderCompiler();
      const first = compiler.compile("openalex", semanticQuery(), { pageSize: 15 });
      const same = compiler.compile("openalex", semanticQuery(), { pageSize: 15 });
      const changed = compiler.compile("openalex", semanticQuery(), { pageSize: 20 });
      expect(first.fingerprint).toBe(same.fingerprint);
      expect(first.fingerprint).not.toBe(changed.fingerprint);
    });

    it.each(["arxiv", "openalex", "semantic_scholar", "web_search"] as ResearchProviderKey[])(
      "builds an executable %s request without invoking semantic compilation",
      (provider) => {
        const compiled = new ResearchProviderCompiler().compile(provider, semanticQuery(), { pageSize: 10 });
        const request = new SearchExecutionAdapter().buildScanRequest({ compiledQuery: compiled });
        const url = new URL(request.url);
        expect(url.protocol).toBe("https:");
        expect([...url.searchParams.values()].join(" ")).toContain(provider === "arxiv" ? "all:agent AND all:memory" : "agent");
      },
    );

    it("rejects a malformed compiled query at the execution boundary", () => {
      const compiled = new ResearchProviderCompiler().compile("openalex", semanticQuery());
      expect(() => new SearchExecutionAdapter().buildScanRequest({
        compiledQuery: { ...compiled, query: {} },
      })).toThrow("requires query.search");
    });
  });

  function semanticQuery(): ResearchSemanticQuery {
    return {
      schema_version: "research_semantic_query.v1",
      core: [
        { value: "agent memory", synonyms: ["memory-augmented agents"], weight: 1 },
        { value: "retrieval", synonyms: ["memory retrieval"], weight: 0.9 },
      ],
      expansions: [{ value: "long-term context", synonyms: [], weight: 0.8 }],
      qualifiers: [{ value: "evaluation", synonyms: ["benchmark"], weight: 0.85 }],
      exclusions: [{ value: "human memory", synonyms: [], weight: 0.7 }],
      time_window: { from: "2020-01-01", to: null },
    };
  }
});

describe("researchQueryRepositoryDb", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT = "55555555-5555-4555-8555-555555555555";
  const OTHER_PROJECT = "66666666-6666-4666-8666-666666666666";


  const db = useTestDatabase(`${import.meta.filename}#researchQueryRepositoryDb`);

  beforeAll(async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Research','personal',$2,$2)`, [SPACE, now]);
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), SPACE, USER, now],
    );
    for (const [id, name] of [[PROJECT, "Project"], [OTHER_PROJECT, "Other"]]) {
      await db.pool.query(
        `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'active',$5,$5)`,
        [id, SPACE, USER, name, now],
      );
    }
  });

  describe("research query persistence (real Postgres)", () => {
    it("persists immutable context versions and an independently selected provider attempt", async () => {
      if (!db.available) return;
      const contexts = new ResearchContextRepository(db.pool);
      const context = await contexts.create({ spaceId: SPACE, userId: USER }, PROJECT, validContext(), {
        assessment: { answerable: true },
        provenance: { source: "question_assessment" },
      });
      const next = await contexts.create({ spaceId: SPACE, userId: USER }, PROJECT, {
        ...validContext(),
        objective: "How should durable agent memory be evaluated across sessions?",
      });
      expect([context.version, next.version]).toEqual([1, 2]);

      const queries = new ResearchQueryRepository(db.pool);
      const strategy = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
        projectId: PROJECT,
        researchContextVersionId: context.id,
        providers: ["arxiv", "openalex", "arxiv"],
        policyVersion: "adaptive-recall.v1",
        policy: { max_attempts: 3 },
        executionBudget: { candidate_budget: 100 },
      });
      expect(strategy.provider_plans.map((plan) => plan.provider_key).sort()).toEqual(["arxiv", "openalex"]);
      await queries.markStrategyEvaluating(SPACE, strategy.id);

      const plan = strategy.provider_plans.find((item) => item.provider_key === "arxiv")!;
      const attempt = await queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: 0,
        sequence: 1,
        direction: "initial",
        semanticQuery: semanticQuery(),
        compiledQuery: compiledQuery("arxiv"),
      });
      await queries.completeAttempt(SPACE, attempt.id, {
        observation: previewObservation(),
        score: 0.82,
        decision: "accept",
        decisionReason: "Relevant yield meets the target.",
      });
      await queries.selectAttempt(SPACE, plan.id, attempt.id, { terminalDecision: "accept" });
      const otherPlan = strategy.provider_plans.find((item) => item.provider_key === "openalex")!;
      await queries.markProviderUnavailable(SPACE, otherPlan.id, { failed: false, reason: "Provider was unavailable." });
      await expect(queries.finalizeStrategy(SPACE, strategy.id)).resolves.toBe("selected");

      const stored = await queries.getStrategy(SPACE, PROJECT, strategy.id);
      // The route response is validated against this same schema; a raw pg
      // Date (instead of an ISO string) or a dropped field fails it, which a
      // toMatchObject check alone would miss.
      expect(() => protocol.ResearchQueryStrategySchema.parse(stored)).not.toThrow();
      const storedPlan = stored?.provider_plans.find((item) => item.id === plan.id);
      expect(storedPlan).toMatchObject({ status: "selected", selected_attempt_id: attempt.id });
      expect(storedPlan?.attempts[0]).toMatchObject({
        sequence: 1,
        decision: "accept",
        score: 0.82,
        observation: { provider_hit_count: 42, accessible_hit_count: 42 },
      });
      expect(stored?.status).toBe("selected");
      expect(stored).toMatchObject({ version: 1, parent_strategy_id: null, adaptation_direction: null });

      const replacement = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
        projectId: PROJECT,
        researchContextVersionId: context.id,
        providers: ["arxiv"],
        policyVersion: "adaptive-recall.v1",
        policy: {},
        executionBudget: { candidate_budget: 100 },
        parentStrategyId: strategy.id,
        adaptationDirection: "broaden",
      });
      expect(replacement).toMatchObject({ version: 2, parent_strategy_id: strategy.id, adaptation_direction: "broaden" });
      const versions = await queries.listStrategies(SPACE, PROJECT);
      expect(versions.strategies.map((item) => item.version)).toEqual([2, 1]);
    });

    it("enforces sequential attempts, the attempt ceiling, and immutable selection", async () => {
      if (!db.available) return;
      const context = await new ResearchContextRepository(db.pool).create({ spaceId: SPACE, userId: USER }, PROJECT, validContext());
      const queries = new ResearchQueryRepository(db.pool);
      const strategy = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
        projectId: PROJECT,
        researchContextVersionId: context.id,
        providers: ["openalex"],
        policyVersion: "adaptive-recall.v1",
        policy: {},
        executionBudget: { candidate_budget: 50 },
      });
      const plan = strategy.provider_plans[0]!;

      await expect(queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: 0,
        sequence: 2,
        direction: "broaden",
        semanticQuery: semanticQuery(),
        compiledQuery: compiledQuery("openalex"),
      })).rejects.toMatchObject({ statusCode: 409 });

      let selectedAttemptId = "";
      for (let sequence = 1; sequence <= MAX_RESEARCH_QUERY_ATTEMPTS; sequence += 1) {
        const attempt = await queries.createAttempt(SPACE, {
          providerPlanId: plan.id,
          round: 0,
          sequence,
          direction: sequence === 1 ? "initial" : "broaden",
          semanticQuery: semanticQuery(),
          compiledQuery: compiledQuery("openalex", sequence),
        });
        await queries.completeAttempt(SPACE, attempt.id, {
          observation: previewObservation(),
          score: sequence / 10,
          decision: sequence === MAX_RESEARCH_QUERY_ATTEMPTS ? "stop" : "broaden",
        });
        if (sequence === MAX_RESEARCH_QUERY_ATTEMPTS) selectedAttemptId = attempt.id;
      }
      await expect(queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: 0,
        sequence: MAX_RESEARCH_QUERY_ATTEMPTS + 1,
        direction: "broaden",
        semanticQuery: semanticQuery(),
        compiledQuery: compiledQuery("openalex", MAX_RESEARCH_QUERY_ATTEMPTS + 1),
      })).rejects.toMatchObject({ statusCode: 422 });

      await queries.selectAttempt(SPACE, plan.id, selectedAttemptId, { terminalDecision: "stop", coverageWarning: "Below target." });
      await expect(queries.selectAttempt(SPACE, plan.id, selectedAttemptId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it("resets an unavailable provider plan for retry, scoping new attempts into a fresh round", async () => {
      if (!db.available) return;
      const context = await new ResearchContextRepository(db.pool).create({ spaceId: SPACE, userId: USER }, PROJECT, validContext());
      const queries = new ResearchQueryRepository(db.pool);
      const strategy = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
        projectId: PROJECT,
        researchContextVersionId: context.id,
        providers: ["openalex"],
        policyVersion: "adaptive-recall.v1",
        policy: {},
        executionBudget: { candidate_budget: 50 },
      });
      const plan = strategy.provider_plans[0]!;

      // Only an `unavailable` plan is retry-eligible — a plan still `pending`
      // (never evaluated) must be rejected the same way `selected`/`evaluating`
      // would be.
      await expect(queries.resetProviderPlan(SPACE, plan.id)).rejects.toMatchObject({ statusCode: 409 });

      const round0Attempt = await queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: 0,
        sequence: 1,
        direction: "initial",
        semanticQuery: semanticQuery(),
        compiledQuery: compiledQuery("openalex", 1),
      });
      await queries.completeAttempt(SPACE, round0Attempt.id, { errorClass: "http_503" });
      await queries.markProviderUnavailable(SPACE, plan.id, { failed: false, reason: "Provider was unavailable." });
      // With the only provider unavailable, the strategy itself settles as failed.
      await expect(queries.finalizeStrategy(SPACE, strategy.id)).resolves.toBe("failed");

      const reset = await queries.resetProviderPlan(SPACE, plan.id);
      expect(reset).toEqual({ nextRound: 1 });

      // The reset round's ladder starts back at sequence 1 — round-scoping means
      // this does not collide with round 0's own sequence-1 attempt.
      const round1Attempt = await queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: reset.nextRound,
        sequence: 1,
        direction: "initial",
        semanticQuery: semanticQuery(),
        compiledQuery: compiledQuery("openalex", 2),
      });
      await queries.completeAttempt(SPACE, round1Attempt.id, {
        observation: previewObservation(),
        score: 0.9,
        decision: "accept",
        decisionReason: "Retry recovered acceptable coverage.",
      });
      await queries.selectAttempt(SPACE, plan.id, round1Attempt.id, { terminalDecision: "accept" });

      // finalizeStrategy's normal early-return would leave a `failed` strategy
      // stuck forever — the retry needs `force` to recompute status now that
      // the retried plan succeeded.
      await expect(queries.finalizeStrategy(SPACE, strategy.id)).resolves.toBe("failed");
      await expect(queries.finalizeStrategy(SPACE, strategy.id, { force: true })).resolves.toBe("selected");

      const stored = await queries.getStrategy(SPACE, PROJECT, strategy.id);
      const storedPlan = stored?.provider_plans.find((item) => item.id === plan.id);
      expect(storedPlan?.attempts.map((attempt) => ({ round: attempt.round, sequence: attempt.sequence }))).toEqual([
        { round: 0, sequence: 1 },
        { round: 1, sequence: 1 },
      ]);
      expect(storedPlan).toMatchObject({ status: "selected", selected_attempt_id: round1Attempt.id });
    });

    it("resets an already-selected provider plan too, clearing its old selection so a retry can record its own — but refuses once the strategy is materialized", async () => {
      if (!db.available) return;
      const context = await new ResearchContextRepository(db.pool).create({ spaceId: SPACE, userId: USER }, PROJECT, validContext());
      const queries = new ResearchQueryRepository(db.pool);
      const strategy = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
        projectId: PROJECT,
        researchContextVersionId: context.id,
        providers: ["arxiv"],
        policyVersion: "adaptive-recall.v1",
        policy: {},
        executionBudget: { candidate_budget: 50 },
      });
      const plan = strategy.provider_plans[0]!;
      const firstAttempt = await queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: 0,
        sequence: 1,
        direction: "initial",
        semanticQuery: semanticQuery(),
        compiledQuery: compiledQuery("arxiv", 1),
      });
      await queries.completeAttempt(SPACE, firstAttempt.id, {
        observation: previewObservation(),
        score: 0.6,
        decision: "stop",
        decisionReason: "Below target yield but within the attempt budget.",
      });
      await queries.selectAttempt(SPACE, plan.id, firstAttempt.id, { terminalDecision: "stop", coverageWarning: "Yield is below target." });

      // Retrying a `selected` (not just `unavailable`) plan is allowed — the
      // user wants to keep iterating on a result they are not fully satisfied
      // with, not just recover from an outage.
      const reset = await queries.resetProviderPlan(SPACE, plan.id);
      expect(reset).toEqual({ nextRound: 1 });

      // The old provider_query_provider_selections row must be gone — otherwise
      // the retry's own selectAttempt would collide on the provider_plan_id
      // primary key.
      const secondAttempt = await queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: reset.nextRound,
        sequence: 1,
        direction: "initial",
        semanticQuery: semanticQuery(),
        compiledQuery: compiledQuery("arxiv", 2),
      });
      await queries.completeAttempt(SPACE, secondAttempt.id, {
        observation: previewObservation(),
        score: 0.85,
        decision: "accept",
        decisionReason: "Retry found better coverage.",
      });
      await expect(queries.selectAttempt(SPACE, plan.id, secondAttempt.id, { terminalDecision: "accept" })).resolves.toBeUndefined();

      const stored = await queries.getStrategy(SPACE, PROJECT, strategy.id);
      const storedPlan = stored?.provider_plans.find((item) => item.id === plan.id);
      expect(storedPlan).toMatchObject({ status: "selected", selected_attempt_id: secondAttempt.id, coverage_warning: null });

      // Once the strategy is materialized, no further retry is allowed on this
      // plan — a source channel/binding already references the selection.
      await db.pool.query(`UPDATE research_query_strategies SET status='materialized', materialized_at=$2 WHERE id=$1`, [strategy.id, new Date().toISOString()]);
      await expect(queries.resetProviderPlan(SPACE, plan.id)).rejects.toMatchObject({ statusCode: 409 });
    });

    it("does not allow a strategy to adopt a context from another project", async () => {
      if (!db.available) return;
      const context = await new ResearchContextRepository(db.pool).create({ spaceId: SPACE, userId: USER }, OTHER_PROJECT, validContext());
      const queries = new ResearchQueryRepository(db.pool);
      await expect(queries.createStrategy({ spaceId: SPACE, userId: USER }, {
        projectId: PROJECT,
        researchContextVersionId: context.id,
        providers: ["arxiv"],
        policyVersion: "adaptive-recall.v1",
        policy: {},
        executionBudget: {},
      })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  function validContext(): ResearchContext {
    return {
      schema_version: "research_context.v1" as const,
      objective: "How should long-lived agent memory be evaluated?",
      sub_questions: ["Which benchmarks measure cross-session recall?"],
      in_scope: ["LLM agent memory"],
      out_of_scope: ["Human autobiographical memory"],
      must_have: ["Reports an evaluation method"],
      nice_to_have: ["Includes a public benchmark"],
      time_window: { from: "2020-01-01", to: null },
      source_scope: { providers: ["arxiv", "openalex"], include_web: false },
    };
  }

  function semanticQuery() {
    return {
      schema_version: "research_semantic_query.v1" as const,
      core: [{ value: "agent memory", synonyms: ["memory-augmented agent"], weight: 1 }],
      expansions: [{ value: "long-term memory", synonyms: [], weight: 0.8 }],
      qualifiers: [{ value: "evaluation", synonyms: ["benchmark"], weight: 0.9 }],
      exclusions: [],
      time_window: { from: "2020-01-01", to: null },
    };
  }

  function compiledQuery(provider: "arxiv" | "openalex", sequence = 1) {
    return {
      schema_version: "research_compiled_query.v1" as const,
      provider_key: provider,
      query: provider === "arxiv" ? { search_query: "all:agent AND all:memory" } : { search: "agent memory" },
      fingerprint: `0123456789abcde${sequence}`,
    };
  }

  function previewObservation() {
    return {
      schema_version: "research_preview_observation.v1" as const,
      provider_hit_count: 42,
      accessible_hit_count: 42,
      samples: [{
        sample_id: "paper-1",
        title: "Evaluating Memory-Augmented Agents",
        source_uri: "https://example.test/paper-1",
        occurred_at: "2025-01-01T00:00:00.000Z",
        excerpt: "A benchmark for long-lived agent memory.",
        relevance: "relevant" as const,
        matched_core_concepts: ["agent memory"],
      }],
      relevance_rate: 0.8,
      relevance_lower_bound: 0.55,
      diversity_score: 0.7,
      duplicate_rate: 0,
    };
  }
});
