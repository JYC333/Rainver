import { createHash, randomUUID } from "node:crypto";
import {
  HttpError,
  dateIso,
  objectValue,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "../projects/access";
import { contentReadSql } from "../access/contentAccessSql";
import type { PinnedSourceRef } from "./outbox";

const CANDIDATE_KINDS = new Set(["concept", "lesson", "procedure", "decision", "summary"]);
const DECISIONS = new Set(["promote", "dismiss", "defer"]);

interface CandidateRow {
  id: string; space_id: string; project_id: string | null; trigger: string;
  source_kind: string; source_id: string; source_ref_json: unknown;
  candidate_kind: string; proposed_title: string; proposed_content: string;
  visibility: string; owner_user_id: string | null;
  supersedes_knowledge_item_id: string | null; status: string; created_proposal_id: string | null;
  review_packet_id: string | null;
  created_by_user_id: string | null; decided_by_user_id: string | null; decided_at: unknown;
  created_at: unknown; updated_at: unknown;
}

function candidateToOut(row: CandidateRow): Record<string, unknown> {
  return {
    id: row.id, project_id: row.project_id, trigger: row.trigger,
    source_kind: row.source_kind, source_id: row.source_id, source_ref: row.source_ref_json,
    candidate_kind: row.candidate_kind, proposed_title: row.proposed_title, proposed_content: row.proposed_content,
    visibility: row.visibility, owner_user_id: row.owner_user_id,
    supersedes_knowledge_item_id: row.supersedes_knowledge_item_id, status: row.status,
    review_packet_id: row.review_packet_id,
    created_proposal_id: row.created_proposal_id, created_by_user_id: row.created_by_user_id,
    decided_by_user_id: row.decided_by_user_id, decided_at: dateIso(row.decided_at),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Knowledge Candidate extraction and promotion. Scoped to the
 * knowledge_items-backed kinds (concept/lesson/procedure/decision/summary);
 * Claim and Relation keep their existing dedicated extraction flows
 * (claim_candidate_packet, relation_discovery_packet in modules/knowledge/).
 * Extraction here is manual/explicit — a human names the exact source
 * revision and proposed content — matching this codebase's established
 * manual-first sequencing;
 * an AI-driven auto-extraction pipeline is a documented follow-up.
 *
 * `decideCandidate("promote")` never writes `knowledge_items` directly — it
 * creates a pending `knowledge_create`/`knowledge_update` proposal carrying
 * `pinned_source_ref`, so canonical promotion stays proposal-gated exactly
 * like every other Knowledge write path.
 */
export class KnowledgePromotionCandidateService {
  constructor(private readonly db: Queryable) {}

  async createFromNote(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const noteId = requiredString(body.note_id, "note_id");
    const blockAnchors = Array.isArray(body.block_anchors)
      ? body.block_anchors.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0)
      : [];
    return this.create(identity, projectId, body, async (db) => {
      const revision = await db.query<{ id: string; version: number; content_hash: string; visibility: string; owner_user_id: string | null }>(
        `SELECT nr.id, nr.version, nr.content_hash, so.visibility, so.owner_user_id
           FROM note_revisions nr
           JOIN space_objects so ON so.id=nr.note_id AND so.space_id=nr.space_id
          WHERE nr.note_id=$1 AND nr.space_id=$2
            AND ${contentReadSql("space_object", "so", "$3")}
          ORDER BY nr.version DESC LIMIT 1`,
        [noteId, identity.spaceId, identity.userId],
      );
      if (!revision.rows[0]) throw new HttpError(404, "Note not found or inaccessible");
      const ref: PinnedSourceRef = {
        kind: "note_revision", note_id: noteId, revision_id: revision.rows[0].id,
        version: revision.rows[0].version, content_hash: revision.rows[0].content_hash, block_anchors: blockAnchors,
      };
      return {
        sourceKind: "note", sourceId: noteId, sourceRef: ref,
        visibility: revision.rows[0].visibility === "space_shared" ? "space_shared" : "private",
        ownerUserId: revision.rows[0].owner_user_id ?? identity.userId,
      };
    });
  }

  async createFromThread(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const threadId = requiredString(body.thread_id, "thread_id");
    return this.create(identity, projectId, body, async (db) => {
      const revision = await db.query<{ id: string; version: number; content_hash: string }>(
        `SELECT id, version, content_hash FROM inquiry_thread_revisions
          WHERE thread_id=$1 AND space_id=$2 AND project_id=$3 ORDER BY version DESC LIMIT 1`,
        [threadId, identity.spaceId, projectId],
      );
      if (!revision.rows[0]) throw new HttpError(422, "thread_id has no revisions to pin");
      const ref: PinnedSourceRef = {
        kind: "inquiry_thread_revision", thread_id: threadId, revision_id: revision.rows[0].id,
        version: revision.rows[0].version, content_hash: revision.rows[0].content_hash,
      };
      return { sourceKind: "inquiry_thread", sourceId: threadId, sourceRef: ref };
    });
  }

  async createFromInterpretation(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const interpretationId = requiredString(body.interpretation_id, "interpretation_id");
    return this.create(identity, projectId, body, async (db) => {
      const interpretation = await db.query<{
        id: string; definition_id: string; run_ids_json: unknown; verdict: string;
        conclusion: string | null; negative_results: string | null; limitations: string | null;
        repro_lock_json: unknown; status: string;
      }>(
        `SELECT id, definition_id, run_ids_json, verdict, conclusion, negative_results, limitations, repro_lock_json, status
           FROM experiment_interpretations WHERE id=$1 AND space_id=$2 AND project_id=$3`,
        [interpretationId, identity.spaceId, projectId],
      );
      const row = interpretation.rows[0];
      if (!row) throw new HttpError(404, "Experiment Interpretation not found");
      if (row.status !== "converted") throw new HttpError(409, "Only a converted Interpretation can be pinned as a Knowledge source");
      const runIds = Array.isArray(row.run_ids_json) ? row.run_ids_json.filter((v): v is string => typeof v === "string") : [];
      const contentHash = sha256(JSON.stringify({ verdict: row.verdict, conclusion: row.conclusion, negative_results: row.negative_results, limitations: row.limitations }));
      const reproLockHash = sha256(JSON.stringify(objectValue(row.repro_lock_json)));
      const ref: PinnedSourceRef = {
        kind: "experiment_interpretation", interpretation_id: interpretationId, content_hash: contentHash,
        definition_id: row.definition_id, run_ids: runIds, repro_lock_hash: reproLockHash,
      };
      return { sourceKind: "experiment_interpretation", sourceId: interpretationId, sourceRef: ref };
    });
  }

  private async create(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
    resolveSource: (db: Queryable) => Promise<{
      sourceKind: string; sourceId: string; sourceRef: PinnedSourceRef;
      visibility?: "private" | "space_shared"; ownerUserId?: string | null;
    }>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const candidateKind = requiredString(body.candidate_kind, "candidate_kind");
    if (!CANDIDATE_KINDS.has(candidateKind)) throw new HttpError(422, `candidate_kind must be one of: ${[...CANDIDATE_KINDS].join(", ")}`);
    const proposedTitle = requiredString(body.proposed_title, "proposed_title");
    const proposedContent = requiredString(body.proposed_content, "proposed_content");
    const supersedesKnowledgeItemId = optionalString(body.supersedes_knowledge_item_id);
    const trigger = supersedesKnowledgeItemId ? "revalidation" : "promotion";
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      if (supersedesKnowledgeItemId) {
        const existing = await db.query(
          `SELECT ki.object_id FROM knowledge_items ki
             JOIN space_objects so ON so.id=ki.object_id AND so.space_id=ki.space_id
            WHERE ki.object_id=$1 AND ki.space_id=$2
              AND ${contentReadSql("space_object", "so", "$3")}`,
          [supersedesKnowledgeItemId, identity.spaceId, identity.userId],
        );
        if (!existing.rows[0]) throw new HttpError(404, "Knowledge item not found or inaccessible");
      }
      const { sourceKind, sourceId, sourceRef, visibility = "space_shared", ownerUserId = null } = await resolveSource(db);
      const id = randomUUID();
      await db.query(
        `INSERT INTO knowledge_promotion_candidates (
           id, space_id, project_id, trigger, source_kind, source_id, source_ref_json,
           candidate_kind, proposed_title, proposed_content, visibility, owner_user_id,
           supersedes_knowledge_item_id, status, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, 'pending', $14, $15, $15)`,
        [id, identity.spaceId, projectId, trigger, sourceKind, sourceId, JSON.stringify(sourceRef),
          candidateKind, proposedTitle, proposedContent, visibility, ownerUserId,
          supersedesKnowledgeItemId, identity.userId, now],
      );
      const row = await db.query<CandidateRow>(`SELECT * FROM knowledge_promotion_candidates WHERE id=$1 AND space_id=$2`, [id, identity.spaceId]);
      return candidateToOut(row.rows[0]!);
    });
  }

  async listCandidates(identity: SpaceUserIdentity, projectId: string, status?: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const params: unknown[] = [identity.spaceId, projectId];
    let clause = "";
    if (status) {
      params.push(status);
      clause = " AND status = $3";
    }
    const rows = await this.db.query<CandidateRow>(
      `SELECT * FROM knowledge_promotion_candidates
        WHERE space_id=$1 AND project_id=$2
          AND (visibility='space_shared' OR owner_user_id=$${params.length + 1})${clause}
        ORDER BY created_at DESC`,
      [...params, identity.userId],
    );
    return rows.rows.map(candidateToOut);
  }

  async getCandidate(identity: SpaceUserIdentity, projectId: string, candidateId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.db.query<CandidateRow>(
      `SELECT * FROM knowledge_promotion_candidates
        WHERE id=$1 AND space_id=$2 AND project_id=$3
          AND (visibility='space_shared' OR owner_user_id=$4)`,
      [candidateId, identity.spaceId, projectId, identity.userId],
    );
    if (!row.rows[0]) throw new HttpError(404, "Candidate not found");
    return candidateToOut(row.rows[0]);
  }

  async decideCandidate(
    identity: SpaceUserIdentity,
    projectId: string,
    candidateId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const decision = requiredString(body.decision, "decision");
    if (!DECISIONS.has(decision)) throw new HttpError(422, `decision must be one of: ${[...DECISIONS].join(", ")}`);
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const row = await db.query<CandidateRow>(
        `SELECT * FROM knowledge_promotion_candidates
          WHERE id=$1 AND space_id=$2 AND project_id=$3
            AND (visibility='space_shared' OR owner_user_id=$4)
          FOR UPDATE`,
        [candidateId, identity.spaceId, projectId, identity.userId],
      );
      const candidate = row.rows[0];
      if (!candidate) throw new HttpError(404, "Candidate not found");
      if (candidate.status !== "pending") throw new HttpError(409, `Candidate already ${candidate.status}`);

      if (decision === "dismiss" || decision === "defer") {
        const status = decision === "dismiss" ? "dismissed" : "deferred";
        await db.query(
          `UPDATE knowledge_promotion_candidates SET status=$3, decided_by_user_id=$4, decided_at=$5, updated_at=$5 WHERE id=$1 AND space_id=$2`,
          [candidateId, identity.spaceId, status, identity.userId, now],
        );
        const updated = await db.query<CandidateRow>(`SELECT * FROM knowledge_promotion_candidates WHERE id=$1 AND space_id=$2`, [candidateId, identity.spaceId]);
        return candidateToOut(updated.rows[0]!);
      }

      const proposalId = randomUUID();
      const promotedTitle = optionalString(body.proposed_title) ?? candidate.proposed_title;
      const promotedContent = optionalString(body.proposed_content) ?? candidate.proposed_content;
      const payload = candidate.trigger === "revalidation"
        ? {
          proposal_type: "knowledge_update",
          operation: "update",
          target_item_id: candidate.supersedes_knowledge_item_id,
          title: promotedTitle,
          content: promotedContent,
          project_id: projectId,
          pinned_source_ref: candidate.source_ref_json,
          visibility: candidate.visibility,
          owner_user_id: candidate.owner_user_id,
        }
        : {
          proposal_type: "knowledge_create",
          operation: "create",
          knowledge_kind: candidate.candidate_kind,
          title: promotedTitle,
          content: promotedContent,
          project_id: projectId,
          pinned_source_ref: candidate.source_ref_json,
          visibility: candidate.visibility,
          owner_user_id: candidate.owner_user_id,
        };
      await db.query(
        `INSERT INTO proposals (
           id, space_id, proposal_type, status, risk_level, urgency, title, summary,
           payload_json, created_at, updated_at, created_by_user_id, owner_user_id, project_id
         ) VALUES ($1, $2, $3, 'pending', 'low', 'normal', $4, $5, $6::jsonb, $7, $7, $8, $8, $9)`,
        [proposalId, identity.spaceId, payload.proposal_type, `Promote Knowledge Candidate: ${promotedTitle}`,
          `Created from a ${candidate.trigger} Candidate over ${candidate.source_kind} ${candidate.source_id}.`,
          JSON.stringify(payload), now, identity.userId, projectId],
      );
      await db.query(
        `UPDATE knowledge_promotion_candidates SET status='promoted', created_proposal_id=$3, decided_by_user_id=$4, decided_at=$5, updated_at=$5 WHERE id=$1 AND space_id=$2`,
        [candidateId, identity.spaceId, proposalId, identity.userId, now],
      );
      const updated = await db.query<CandidateRow>(`SELECT * FROM knowledge_promotion_candidates WHERE id=$1 AND space_id=$2`, [candidateId, identity.spaceId]);
      return candidateToOut(updated.rows[0]!);
    });
  }

  async reopenCandidate(
    identity: SpaceUserIdentity,
    projectId: string,
    candidateId: string,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const now = new Date().toISOString();
    const row = await this.db.query<CandidateRow>(
      `UPDATE knowledge_promotion_candidates
          SET status='pending', decided_by_user_id=NULL, decided_at=NULL, updated_at=$4
        WHERE id=$1 AND space_id=$2 AND project_id=$3 AND status='deferred'
          AND (visibility='space_shared' OR owner_user_id=$5)
      RETURNING *`,
      [candidateId, identity.spaceId, projectId, now, identity.userId],
    );
    if (!row.rows[0]) throw new HttpError(409, "Only a deferred Candidate can be reopened");
    return candidateToOut(row.rows[0]);
  }

  async getReviewSummary(
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const counts = await this.db.query<{
      pending: number; promotion: number; revalidation: number; no_impact: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE status='pending')::int AS pending,
         count(*) FILTER (WHERE status='pending' AND trigger='promotion')::int AS promotion,
         count(*) FILTER (WHERE status='pending' AND trigger='revalidation')::int AS revalidation,
         (SELECT count(*)::int FROM knowledge_revalidation_outcomes o
           JOIN knowledge_items ki ON ki.object_id=o.knowledge_item_id AND ki.space_id=o.space_id
          JOIN space_objects so ON so.id=ki.object_id AND so.space_id=ki.space_id
          WHERE o.space_id=$1 AND so.primary_project_id=$2 AND o.outcome='no_impact'
            AND (so.visibility='space_shared' OR so.owner_user_id=$3)) AS no_impact
       FROM knowledge_promotion_candidates
        WHERE space_id=$1 AND project_id=$2
          AND (visibility='space_shared' OR owner_user_id=$3)`,
      [identity.spaceId, projectId, identity.userId],
    );
    const row = counts.rows[0] ?? { pending: 0, promotion: 0, revalidation: 0, no_impact: 0 };
    return {
      ...row,
      summary: row.pending === 0
        ? `${row.no_impact} source changes were checked with no review required.`
        : `${row.pending} Knowledge changes need review: ${row.revalidation} updates and ${row.promotion} new promotions. ${row.no_impact} source changes required no action.`,
    };
  }

  async openReviewPacket(
    identity: SpaceUserIdentity,
    projectId: string,
    limit = 10,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const packetSize = Math.max(1, Math.min(limit, 20));
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const previous = await db.query<{ id: string }>(
        `SELECT id FROM knowledge_promotion_review_packets
          WHERE space_id=$1 AND project_id=$2 AND opened_by_user_id=$3 AND status='open'
          FOR UPDATE`,
        [identity.spaceId, projectId, identity.userId],
      );
      if (previous.rows.length > 0) {
        const ids = previous.rows.map((row) => row.id);
        await db.query(
          `UPDATE knowledge_promotion_candidates SET review_packet_id=NULL
            WHERE review_packet_id=ANY($1::varchar[]) AND status='pending'`,
          [ids],
        );
        await db.query(
          `UPDATE knowledge_promotion_review_packets SET status='closed', closed_at=$2
            WHERE id=ANY($1::varchar[])`,
          [ids, now],
        );
      }
      const selected = await db.query<CandidateRow>(
        `SELECT * FROM knowledge_promotion_candidates
          WHERE space_id=$1 AND project_id=$2 AND status='pending' AND review_packet_id IS NULL
            AND (visibility='space_shared' OR owner_user_id=$4)
          ORDER BY CASE WHEN trigger='revalidation' THEN 0 ELSE 1 END, created_at ASC
          LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [identity.spaceId, projectId, packetSize, identity.userId],
      );
      const packetId = randomUUID();
      await db.query(
        `INSERT INTO knowledge_promotion_review_packets
          (id,space_id,project_id,status,opened_by_user_id,created_at)
         VALUES ($1,$2,$3,'open',$4,$5)`,
        [packetId, identity.spaceId, projectId, identity.userId, now],
      );
      if (selected.rows.length > 0) {
        await db.query(
          `UPDATE knowledge_promotion_candidates SET review_packet_id=$1, updated_at=$2
            WHERE id=ANY($3::varchar[])`,
          [packetId, now, selected.rows.map((row) => row.id)],
        );
      }
      return {
        id: packetId,
        status: "open",
        created_at: now,
        candidates: selected.rows.map((row) => candidateToOut({ ...row, review_packet_id: packetId })),
      };
    });
  }

  async closeReviewPacket(
    identity: SpaceUserIdentity,
    projectId: string,
    packetId: string,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      const packet = await db.query<{ id: string }>(
        `SELECT id FROM knowledge_promotion_review_packets
          WHERE id=$1 AND space_id=$2 AND project_id=$3 AND opened_by_user_id=$4
          FOR UPDATE`,
        [packetId, identity.spaceId, projectId, identity.userId],
      );
      if (!packet.rows[0]) throw new HttpError(404, "Review packet not found");
      await db.query(
        `UPDATE knowledge_promotion_candidates SET review_packet_id=NULL
          WHERE review_packet_id=$1 AND status='pending'`,
        [packetId],
      );
      await db.query(
        `UPDATE knowledge_promotion_review_packets SET status='closed', closed_at=COALESCE(closed_at,$2)
          WHERE id=$1`,
        [packetId, now],
      );
      return { id: packetId, status: "closed", closed_at: now };
    });
  }
}
