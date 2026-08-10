import { randomUUID } from "node:crypto";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import { objectValue, optionalString, withQueryableTransaction } from "../routeUtils/common";
import { PgRunRepository } from "../runs/repository";
import { PgJobQueueRepository } from "../jobs/repository";
import { createManagedExecutionPolicy } from "../policy/managedExecutionPolicy";
import { resolveNotebookNote } from "./notebookNotes";
import type { NoteProjectRole } from "../knowledge/noteProjectRoles";
import type { ResearchOperationState } from "./operationProjection";
import { InquirySignalService } from "../inquiry/signalService";
import {
  PROJECT_RESEARCH_MONITOR_COMPARE_PROMPT_KEY,
  resolveProjectResearchMonitorComparePrompt,
} from "./promptRegistry";

export const MONITOR_COMPARISON_OUTPUT_CONTRACT = {
  type: "json_schema",
  schema_id: "project_research.monitor_compare.v1",
  strict: true,
  stage: "monitor_compare",
  schema: {
    type: "object",
    properties: {
      comparisons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_item_id: { type: "string" },
            stance: { enum: ["supports", "contradicts", "new_direction"] },
            detail: { type: "string", minLength: 1, maxLength: 4000 },
            affected_sections: {
              type: "array",
              items: { enum: ["understanding", "questions", "ideas", "experiments"] },
              uniqueItems: true,
            },
          },
          required: ["source_item_id", "stance", "detail", "affected_sections"],
          additionalProperties: false,
        },
      },
    },
    required: ["comparisons"],
    additionalProperties: false,
  },
} as const;

export type MonitorComparison = {
  source_item_id: string;
  stance: "supports" | "contradicts" | "new_direction";
  detail: string;
  affected_sections: Array<"understanding" | "questions" | "ideas" | "experiments">;
};

// Asking a model to classify every material item in one structured-output call
// gets less reliable as the item count grows (dropped or invented
// source_item_ids); comparing in small batches keeps each call's output
// small enough to validate exactly.
export const COMPARISON_BATCH_SIZE = 6;

/**
 * Why `queue` reports three outcomes rather than returning `null` twice: "no
 * eligible material in this batch" is routine and the coordinator moves on, while
 * "this project has no note in the `understanding` role" means the comparison
 * has no baseline to compare against. Collapsing them is what let the old
 * title-string binding fail in silence — the comparison ran with an empty
 * current understanding and every item looked like a new direction.
 */
export type MonitorComparisonQueueResult =
  | { readonly outcome: "queued"; readonly runId: string; readonly jobId: string; readonly sourceItemIds: string[] }
  | { readonly outcome: "no_eligible_material" }
  | { readonly outcome: "no_baseline"; readonly role: NoteProjectRole };

export class ProjectResearchMonitorComparisonService {
  constructor(private readonly db: Queryable) {}

  async queue(input: {
    spaceId: string;
    userId: string;
    projectId: string;
    agentId: string;
    runtimeProfileId: string | null;
    researchQuestion: string;
    sourceItemIds: string[];
  } & (
    | { workflowId: string; operationId: string; standingBatchId?: never }
    | { standingBatchId: string; workflowId?: never; operationId?: never }
  )): Promise<MonitorComparisonQueueResult> {
    const material = await this.eligibleMaterial(input.spaceId, input.projectId, input.sourceItemIds);
    if (material.length === 0) return { outcome: "no_eligible_material" };
    const understanding = await resolveNotebookNote(this.db, input.spaceId, input.projectId, "understanding");
    // A comparison against an absent baseline is not a cheaper comparison, it
    // is a different question. Report it and let the caller surface it.
    if (!understanding.present) return { outcome: "no_baseline", role: understanding.role };
    const resolved = await resolveProjectResearchMonitorComparePrompt(this.db, {
      spaceId: input.spaceId,
      userId: input.userId,
      projectId: input.projectId,
      agentId: input.agentId,
      researchQuestion: input.researchQuestion,
      currentUnderstanding: understanding.note.plain_text ?? "",
      newMaterial: material,
    });
    const run = await new PgRunRepository(this.db).createQueuedRunWithBudgetAdmission({
      agent_id: input.agentId,
      space_id: input.spaceId,
      user_id: input.userId,
      project_id: input.projectId,
      mode: "live",
      run_type: "agent",
      trigger_origin: "system",
      runtime_profile_id: input.runtimeProfileId,
      prompt: `Compare ${material.length} newly screened material item${material.length === 1 ? "" : "s"} with the current project understanding`,
      instruction: resolved.instruction,
      capability_id: "research.monitor_compare",
      capabilities_json: ["research.monitor_compare"],
      contract_snapshot: {
        source: "standingBatchId" in input
          ? { kind: "direct", id: input.projectId }
          : { kind: "workflow", id: input.workflowId },
        project_id: input.projectId,
        required_outputs_json: { materializations: ["research_scan_summary", "research_evidence_card"] },
        structured_output_json: MONITOR_COMPARISON_OUTPUT_CONTRACT,
        workflow_input_json: "standingBatchId" in input
          ? {
              project_research_standing: {
                batch_id: input.standingBatchId,
                source_item_ids: material.map((item) => item.source_item_id),
                prompt_asset_key: PROJECT_RESEARCH_MONITOR_COMPARE_PROMPT_KEY,
                prompt_version_id: resolved.resolveResult.version_id,
                prompt_content_hash: resolved.resolveResult.content_hash,
              },
            }
          : {
              project_research: {
                workflow_id: input.workflowId,
                operation_id: input.operationId,
                stage_key: "monitor_compare",
                source_item_ids: material.map((item) => item.source_item_id),
                prompt_asset_key: PROJECT_RESEARCH_MONITOR_COMPARE_PROMPT_KEY,
                prompt_version_id: resolved.resolveResult.version_id,
                prompt_content_hash: resolved.resolveResult.content_hash,
              },
            },
        policy_context_json: createManagedExecutionPolicy("project_research", true),
        risk_level: "low",
      },
    });
    const job = await new PgJobQueueRepository(this.db).enqueue({
      job_type: "agent_run",
      space_id: input.spaceId,
      user_id: input.userId,
      agent_id: input.agentId,
      payload: { run_id: run.id },
    });
    return { outcome: "queued", runId: run.id, jobId: job.id, sourceItemIds: material.map((item) => item.source_item_id) };
  }

  /**
   * Writes the full set of comparisons accumulated across every batch of a
   * comparison stage. Called exactly once, when the last batch's run
   * completes — the operation projection (comparison_pending_source_item_ids
   * reaching empty) is what guarantees "exactly once", not this method.
   *
   * Every comparison becomes an Evidence Signal on the workflow's pinned
   * Inquiry Thread scope. Supports is routine and auto-attaches; contradiction
   * and new direction are material and enter Candidate consolidation.
   */
  async persistComparisons(input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    operationId: string;
    runId: string;
    researchQuestion: string;
    threadScope: ResearchOperationState["thread_scope"];
    instructedByUserId: string | null;
    comparisons: MonitorComparison[];
  }): Promise<{ comparisons: MonitorComparison[]; signalIds: string[] }> {
    const comparisons = input.comparisons;
    return withQueryableTransaction(this.db, async (db) => {
      const now = new Date().toISOString();
      const scan = await db.query<{ id: string }>(
        `SELECT id FROM research_scan_summaries
          WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3 AND operation_id=$4
          FOR UPDATE`,
        [input.spaceId, input.projectId, input.workflowId, input.operationId],
      );
      if (!scan.rows[0]) throw new Error("Monitoring comparison has no scan summary to update");
      for (const comparison of comparisons) {
        await db.query(
          `INSERT INTO research_evidence_cards (
             id,space_id,project_id,source_item_id,object_id,why_md,how_md,what_md,
             provenance_json,edited_by_user,stance,comparison_detail,created_at,updated_at
           ) SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,pci.object_id,'','','',$5::jsonb,false,$6::varchar,$7::text,$8::timestamptz,$8::timestamptz
               FROM project_corpus_items pci
               JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
               JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
              WHERE pci.space_id=$2::varchar AND pci.project_id=$3::varchar AND pcis.source_item_id=$4::varchar AND pci.status='active'
              LIMIT 1
           ON CONFLICT (space_id,project_id,source_item_id) DO UPDATE SET
             stance=EXCLUDED.stance,comparison_detail=EXCLUDED.comparison_detail,
             provenance_json=research_evidence_cards.provenance_json || EXCLUDED.provenance_json,
             updated_at=EXCLUDED.updated_at`,
          [randomUUID(), input.spaceId, input.projectId, comparison.source_item_id,
            JSON.stringify({ comparison_run_id: input.runId }), comparison.stance, comparison.detail, now],
        );
      }
      const counts = stanceCounts(comparisons);
      await db.query(
        `UPDATE research_scan_summaries SET supports_count=$5,contradicts_count=$6,
           new_direction_count=$7,comparisons_json=$8::jsonb
         WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3 AND operation_id=$4`,
        [input.spaceId, input.projectId, input.workflowId, input.operationId,
          counts.supports, counts.contradicts, counts.new_direction, JSON.stringify(comparisons)],
      );
      const userId = input.instructedByUserId ?? (await startedByUserId(db, input.spaceId, input.workflowId));
      if (!userId) throw new Error("Monitoring comparison has no attributable user for Evidence Signal creation");
      const identity: SpaceUserIdentity = { spaceId: input.spaceId, userId };
      if (input.threadScope.length === 0) {
        throw new Error("Monitoring comparison has no pinned Inquiry Thread scope");
      }
      const corpusItemIds = await corpusItemIdsBySourceItemId(db, input.spaceId, input.projectId, comparisons.map((item) => item.source_item_id));
      const signalService = new InquirySignalService(db);
      const signalIds: string[] = [];
      for (const comparison of comparisons) {
        const corpusItemId = corpusItemIds.get(comparison.source_item_id);
        if (!corpusItemId) continue;
        for (const thread of input.threadScope) {
          const signal = await signalService.createSignal(identity, input.projectId, thread.thread_id, {
            corpus_item_id: corpusItemId,
            classification: comparison.stance === "supports"
              ? "supports"
              : comparison.stance === "contradicts" ? "contradicts" : "raises_gap",
            source_provenance: {
              comparison_run_id: input.runId,
              source: "ai_monitoring",
              thread_version: thread.version,
              research_question: input.researchQuestion,
              stance: comparison.stance,
              detail: comparison.detail,
              affected_sections: comparison.affected_sections,
            },
          });
          signalIds.push(signal.id as string);
        }
      }
      return { comparisons, signalIds };
    });
  }

  private async eligibleMaterial(spaceId: string, projectId: string, sourceItemIds: string[]) {
    if (sourceItemIds.length === 0) return [];
    const rows = await this.db.query<{
      source_item_id: string; title: string | null; excerpt: string | null;
      why_md: string | null; how_md: string | null; what_md: string | null;
    }>(
      `SELECT DISTINCT ON (pcis.source_item_id) pcis.source_item_id,left(si.title,1000) AS title,left(si.excerpt,4000) AS excerpt,
              left(pc.why_md,2000) AS why_md,left(pc.how_md,2000) AS how_md,left(pc.what_md,2000) AS what_md
         FROM project_corpus_items pci
         JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
         JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
         LEFT JOIN research_evidence_cards pc ON pc.space_id=pci.space_id AND pc.project_id=pci.project_id AND pc.source_item_id=pcis.source_item_id
        WHERE pci.space_id=$1 AND pci.project_id=$2 AND pcis.source_item_id=ANY($3::text[])
          AND pci.status='active' AND (pci.triage_status IN ('relevant','included','maybe') OR pci.relevance IN ('relevant','maybe'))
        ORDER BY pcis.source_item_id,pci.updated_at DESC`,
      [spaceId, projectId, sourceItemIds],
    );
    return rows.rows;
  }
}

/**
 * Extracts whatever valid, matching comparisons the model actually produced
 * — it never throws for content problems. A model occasionally drops,
 * duplicates, or invents a source_item_id (observed: a run fabricating 8
 * comparisons for material that was never sent and does not exist); discarding
 * an entire batch's worth of otherwise-good analysis over one bad entry, or
 * failing the whole monitoring operation over it, is worse than the
 * problem. The caller (see ProjectResearchMonitoringCoordinator) is
 * responsible for noticing which of `expectedSourceItemIds` didn't get a
 * match and routing those to a one-at-a-time retry.
 */
function parseComparisonFields(raw: unknown): Omit<MonitorComparison, "source_item_id"> | null {
  const value = objectValue(raw);
  const stance = optionalString(value.stance);
  const detail = optionalString(value.detail);
  const rawAffected = value.affected_sections;
  const affected = Array.isArray(rawAffected)
    ? [...new Set(rawAffected.filter((item: unknown): item is MonitorComparison["affected_sections"][number] =>
      typeof item === "string" && ["understanding", "questions", "ideas", "experiments"].includes(item)))]
    : [];
  if (!detail || detail.length > 4000 || !["supports", "contradicts", "new_direction"].includes(stance ?? "")
    || !Array.isArray(rawAffected) || affected.length !== rawAffected.length) return null;
  return { stance: stance as MonitorComparison["stance"], detail, affected_sections: affected };
}

export function parseMonitorComparisons(output: unknown, expectedSourceItemIds: string[]): MonitorComparison[] {
  const values = objectValue(output).comparisons;
  if (!Array.isArray(values)) return [];

  // With exactly one candidate there's nothing to disambiguate — matching
  // source_item_id only ever cost a solo retry over the model relabeling or
  // omitting an id it didn't need to get right in the first place. Accept
  // the first structurally valid entry and attach it to the one item
  // actually asked about, regardless of what id (if any) it echoed back.
  if (expectedSourceItemIds.length === 1) {
    for (const raw of values) {
      const fields = parseComparisonFields(raw);
      if (fields) return [{ source_item_id: expectedSourceItemIds[0], ...fields }];
    }
    return [];
  }

  const expected = new Set(expectedSourceItemIds);
  const result: MonitorComparison[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const sourceItemId = optionalString(objectValue(raw).source_item_id);
    if (!sourceItemId || !expected.has(sourceItemId) || seen.has(sourceItemId)) continue;
    const fields = parseComparisonFields(raw);
    if (!fields) continue;
    seen.add(sourceItemId);
    result.push({ source_item_id: sourceItemId, ...fields });
  }
  return result;
}

function stanceCounts(values: MonitorComparison[]) {
  return {
    supports: values.filter((item) => item.stance === "supports").length,
    contradicts: values.filter((item) => item.stance === "contradicts").length,
    new_direction: values.filter((item) => item.stance === "new_direction").length,
  };
}

async function startedByUserId(db: Queryable, spaceId: string, workflowId: string): Promise<string | null> {
  const row = await db.query<{ started_by_user_id: string | null }>(
    `SELECT started_by_user_id FROM project_research_workflows WHERE object_id=$1 AND space_id=$2`,
    [workflowId, spaceId],
  );
  return row.rows[0]?.started_by_user_id ?? null;
}

async function corpusItemIdsBySourceItemId(
  db: Queryable,
  spaceId: string,
  projectId: string,
  sourceItemIds: string[],
): Promise<Map<string, string>> {
  if (sourceItemIds.length === 0) return new Map();
  const rows = await db.query<{ source_item_id: string; corpus_item_id: string }>(
    `SELECT DISTINCT ON (pcis.source_item_id) pcis.source_item_id, pci.id AS corpus_item_id
       FROM project_corpus_items pci
       JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
      WHERE pci.space_id=$1 AND pci.project_id=$2 AND pcis.source_item_id=ANY($3::text[]) AND pci.status='active'
      ORDER BY pcis.source_item_id, pci.updated_at DESC`,
    [spaceId, projectId, sourceItemIds],
  );
  return new Map(rows.rows.map((row) => [row.source_item_id, row.corpus_item_id]));
}
