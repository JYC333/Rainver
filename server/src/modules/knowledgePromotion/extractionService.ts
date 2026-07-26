import { randomUUID } from "node:crypto";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import {
  HttpError,
  objectValue,
  optionalString,
  requiredString,
  withQueryableTransaction,
} from "../routeUtils/common";
import { assertProjectWriter, lockActiveProjectForMutation } from "../projects/access";
import { contentReadSql } from "../access/contentAccessSql";
import { PgRunRepository } from "../runs/repository";
import { runOutputResult } from "../runs/orchestrationResults";
import { PgJobQueueRepository } from "../jobs/repository";

const CANDIDATE_KINDS = new Set(["concept", "lesson", "procedure", "decision", "summary"]);

export class KnowledgeExtractionService {
  constructor(private readonly db: Queryable) {}

  async queue(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const sourceKind = requiredString(body.source_kind, "source_kind");
    const sourceId = requiredString(body.source_id, "source_id");
    const agentId = requiredString(body.agent_id, "agent_id");
    const runtimeProfileId = optionalString(body.runtime_profile_id);
    const source = await this.resolveSource(identity, projectId, sourceKind, sourceId);
    const prompt = [
      "Extract durable learning candidates from the immutable source below.",
      "Return JSON with key knowledge_candidates, an array of at most 10 objects.",
      "Each object must contain candidate_kind (concept|lesson|procedure|decision|summary), proposed_title, and proposed_content.",
      "Do not claim these are canonical Knowledge; they will enter human review.",
      "",
      source.text,
    ].join("\n");
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const run = await new PgRunRepository(db).createQueuedRun({
        agent_id: agentId,
        space_id: identity.spaceId,
        user_id: identity.userId,
        mode: "live",
        run_type: "agent",
        trigger_origin: "manual",
        project_id: projectId,
        runtime_profile_id: runtimeProfileId,
        runtime_profile_selection_source: runtimeProfileId ? "explicit" : "default",
        prompt,
        instruction: "Propose Knowledge Candidates from one pinned source revision.",
        contract_snapshot: {
          source: { kind: "direct", id: sourceId },
          project_id: projectId,
          max_attempts: 3,
          required_outputs_json: ["knowledge_candidates"],
          structured_output_json: {
            type: "object",
            required: ["knowledge_candidates"],
          },
          workflow_input_json: {
            kind: "knowledge_candidate_extraction",
            source_kind: sourceKind,
            source_id: sourceId,
            source_ref: source.ref,
            source_visibility: source.visibility,
            source_owner_user_id: source.ownerUserId,
          },
        },
      });
      await new PgJobQueueRepository(db).enqueue({
        job_type: "agent_run",
        space_id: identity.spaceId,
        user_id: identity.userId,
        agent_id: agentId,
        payload: { run_id: run.id },
      });
      return { run_id: run.id, status: run.status, source_ref: source.ref };
    });
  }

  async reconcile(spaceId: string, runId: string): Promise<number> {
    return withQueryableTransaction(this.db, async (db) => {
      const result = await db.query<{
        id: string; project_id: string | null; instructed_by_user_id: string | null;
        owner_user_id: string | null; status: string; output_json: unknown; contract_snapshot_json: unknown;
      }>(
        `SELECT id,project_id,instructed_by_user_id,owner_user_id,status,output_json,contract_snapshot_json
           FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE`,
        [runId, spaceId],
      );
      const run = result.rows[0];
      if (!run || run.status !== "succeeded" || !run.project_id) return 0;
      const workflowInput = objectValue(objectValue(run.contract_snapshot_json).workflow_input_json);
      if (workflowInput.kind !== "knowledge_candidate_extraction") return 0;
      const existing = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM knowledge_promotion_candidates
          WHERE space_id=$1 AND source_ref_json->>'extraction_run_id'=$2`,
        [spaceId, runId],
      );
      if ((existing.rows[0]?.count ?? 0) > 0) return existing.rows[0]!.count;
      const candidates = Array.isArray(runOutputResult(run.output_json).knowledge_candidates)
        ? runOutputResult(run.output_json).knowledge_candidates as unknown[]
        : [];
      const sourceKind = requiredString(workflowInput.source_kind, "source_kind");
      const sourceId = requiredString(workflowInput.source_id, "source_id");
      const sourceRef = objectValue(workflowInput.source_ref);
      const visibility = workflowInput.source_visibility === "private" ? "private" : "space_shared";
      const ownerUserId = optionalString(workflowInput.source_owner_user_id)
        ?? run.instructed_by_user_id
        ?? run.owner_user_id;
      const now = new Date().toISOString();
      let created = 0;
      for (const value of candidates.slice(0, 10)) {
        const row = objectValue(value);
        const kind = optionalString(row.candidate_kind);
        const title = optionalString(row.proposed_title);
        const content = optionalString(row.proposed_content);
        if (!kind || !CANDIDATE_KINDS.has(kind) || !title || !content) continue;
        await db.query(
          `INSERT INTO knowledge_promotion_candidates (
             id,space_id,project_id,trigger,source_kind,source_id,source_ref_json,
             candidate_kind,proposed_title,proposed_content,visibility,owner_user_id,
             status,created_by_user_id,created_at,updated_at
           ) VALUES ($1,$2,$3,'promotion',$4,$5,$6::jsonb,$7,$8,$9,$10,$11,'pending',$12,$13,$13)`,
          [
            randomUUID(), spaceId, run.project_id, sourceKind, sourceId,
            JSON.stringify({ ...sourceRef, extraction_run_id: runId }),
            kind, title, content, visibility, visibility === "private" ? ownerUserId : null,
            run.instructed_by_user_id, now,
          ],
        );
        created += 1;
      }
      return created;
    });
  }

  private async resolveSource(
    identity: SpaceUserIdentity,
    projectId: string,
    sourceKind: string,
    sourceId: string,
  ): Promise<{ ref: Record<string, unknown>; text: string; visibility: string; ownerUserId: string | null }> {
    if (sourceKind === "note") {
      const row = await this.db.query<{
        revision_id: string; version: number; content_hash: string; normalized_text: string;
        visibility: string; owner_user_id: string | null;
      }>(
        `SELECT nr.id AS revision_id,nr.version,nr.content_hash,nr.normalized_text,so.visibility,so.owner_user_id
           FROM note_revisions nr JOIN space_objects so ON so.id=nr.note_id AND so.space_id=nr.space_id
          WHERE nr.note_id=$1 AND nr.space_id=$2 AND ${contentReadSql("space_object", "so", "$3")}
          ORDER BY nr.version DESC LIMIT 1`,
        [sourceId, identity.spaceId, identity.userId],
      );
      const value = row.rows[0];
      if (!value) throw new HttpError(404, "Note not found or inaccessible");
      return {
        ref: { kind: "note_revision", note_id: sourceId, revision_id: value.revision_id, version: value.version, content_hash: value.content_hash },
        text: value.normalized_text,
        visibility: value.visibility,
        ownerUserId: value.owner_user_id,
      };
    }
    if (sourceKind === "inquiry_thread") {
      const row = await this.db.query<{
        revision_id: string; version: number; content_hash: string; statement: string;
        kind: string; answer_state: string | null; evaluation_state: string | null;
        confidence: number | null; state_snapshot_json: unknown;
      }>(
        `SELECT r.id AS revision_id,r.version,r.content_hash,r.statement,r.kind,
                r.answer_state,r.evaluation_state,r.confidence,r.state_snapshot_json
           FROM inquiry_thread_revisions r JOIN inquiry_threads t ON t.id=r.thread_id AND t.space_id=r.space_id
          WHERE r.thread_id=$1 AND r.space_id=$2 AND t.project_id=$3
          ORDER BY r.version DESC LIMIT 1`,
        [sourceId, identity.spaceId, projectId],
      );
      const value = row.rows[0];
      if (!value) throw new HttpError(404, "Inquiry Thread not found");
      return {
        ref: { kind: "inquiry_thread_revision", thread_id: sourceId, revision_id: value.revision_id, version: value.version, content_hash: value.content_hash },
        text: JSON.stringify({
          statement: value.statement,
          kind: value.kind,
          answer_state: value.answer_state,
          evaluation_state: value.evaluation_state,
          confidence: value.confidence,
          state: value.state_snapshot_json,
        }),
        visibility: "space_shared",
        ownerUserId: null,
      };
    }
    if (sourceKind === "experiment_interpretation") {
      const row = await this.db.query<{
        definition_id: string; run_ids_json: unknown; verdict: string; conclusion: string | null;
        negative_results: string | null; limitations: string | null; repro_lock_json: unknown; status: string;
      }>(
        `SELECT definition_id,run_ids_json,verdict,conclusion,negative_results,limitations,repro_lock_json,status
           FROM experiment_interpretations WHERE id=$1 AND space_id=$2 AND project_id=$3`,
        [sourceId, identity.spaceId, projectId],
      );
      const value = row.rows[0];
      if (!value) throw new HttpError(404, "Experiment Interpretation not found");
      if (value.status !== "converted") throw new HttpError(409, "Only a converted Interpretation can be extracted");
      const text = JSON.stringify({
        verdict: value.verdict,
        conclusion: value.conclusion,
        negative_results: value.negative_results,
        limitations: value.limitations,
      });
      const runIds = Array.isArray(value.run_ids_json)
        ? value.run_ids_json.filter((item): item is string => typeof item === "string")
        : [];
      return {
        ref: {
          kind: "experiment_interpretation",
          interpretation_id: sourceId,
          content_hash: await sha256(text),
          definition_id: value.definition_id,
          run_ids: runIds,
          repro_lock_hash: await sha256(JSON.stringify(objectValue(value.repro_lock_json))),
        },
        text,
        visibility: "space_shared",
        ownerUserId: null,
      };
    }
    throw new HttpError(422, "source_kind must be note, inquiry_thread, or experiment_interpretation");
  }
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}
