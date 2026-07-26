import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import {
  HttpError,
  dateIso,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { getDbPool } from "../../db/pool";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "../projects/access";
import { ProjectCorpusRepository } from "../projects/corpusRepository";
import { InquiryIterationService } from "./iterationService";

const SIGNAL_CLASSIFICATIONS = ["supports", "contradicts", "adds_context", "adds_method", "fills_gap", "raises_gap", "unrelated"] as const;
type SignalClassification = (typeof SIGNAL_CLASSIFICATIONS)[number];

// Deterministic routine-vs-material default per classification (plan section
// 10.1-10.2): "routine support and context may attach automatically";
// contradictions and gap changes are always material. A caller may still
// force `is_material: true` for any classification.
const MATERIAL_BY_DEFAULT = new Set<SignalClassification>(["contradicts", "raises_gap", "fills_gap"]);

// One Candidate kind per material classification, so the unique
// (thread_id, candidate_kind) "open" index gives exactly one pending
// Candidate per contradiction/gap on a Thread — the mechanism behind "a
// contradiction produces one explainable Candidate."
const CANDIDATE_KIND_BY_CLASSIFICATION: Partial<Record<SignalClassification, string>> = {
  contradicts: "contradiction",
  raises_gap: "state_change",
  fills_gap: "state_change",
};
const DEFAULT_CANDIDATE_KIND = "state_change";

const CANDIDATE_DECISIONS = ["accept", "merge", "defer", "dismiss", "gap"] as const;
type CandidateDecision = (typeof CANDIDATE_DECISIONS)[number];

const DEFAULT_REVIEW_PACKET_SIZE = 5;

interface SignalRow {
  id: string;
  space_id: string;
  project_id: string;
  thread_id: string;
  corpus_item_id: string | null;
  experiment_interpretation_id: string | null;
  classification: string;
  is_material: boolean;
  confidence: number | null;
  model_version: string | null;
  source_provenance_json: unknown;
  dedupe_key: string;
  producer_idempotency_key: string | null;
  status: string;
  candidate_id: string | null;
  created_by_user_id: string | null;
  created_by_run_id: string | null;
  created_at: unknown;
}

interface CandidateRow {
  id: string;
  space_id: string;
  project_id: string;
  thread_id: string;
  candidate_kind: string;
  semantic_key: string;
  title: string;
  summary: string | null;
  proposed_change_json: unknown;
  status: string;
  review_packet_id: string | null;
  resulting_iteration_id: string | null;
  resulting_thread_id: string | null;
  merged_into_candidate_id: string | null;
  decision_reason: string | null;
  defer_until: unknown;
  decided_by_user_id: string | null;
  decided_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function signalToOut(row: SignalRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    thread_id: row.thread_id,
    corpus_item_id: row.corpus_item_id,
    experiment_interpretation_id: row.experiment_interpretation_id,
    classification: row.classification,
    is_material: row.is_material,
    confidence: row.confidence,
    model_version: row.model_version,
    source_provenance: row.source_provenance_json,
    dedupe_key: row.dedupe_key,
    producer_idempotency_key: row.producer_idempotency_key,
    status: row.status,
    candidate_id: row.candidate_id,
    created_by_user_id: row.created_by_user_id,
    created_by_run_id: row.created_by_run_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function candidateToOut(row: CandidateRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    thread_id: row.thread_id,
    candidate_kind: row.candidate_kind,
    semantic_key: row.semantic_key,
    title: row.title,
    summary: row.summary,
    proposed_change: row.proposed_change_json,
    status: row.status,
    review_packet_id: row.review_packet_id,
    resulting_iteration_id: row.resulting_iteration_id,
    resulting_thread_id: row.resulting_thread_id,
    merged_into_candidate_id: row.merged_into_candidate_id,
    decision_reason: row.decision_reason,
    defer_until: dateIso(row.defer_until),
    decided_by_user_id: row.decided_by_user_id,
    decided_at: dateIso(row.decided_at),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Evidence Signals, Candidate consolidation, Review Packets, and Research
 * Delta Briefs (plan section 10). Candidate acceptance reuses
 * `InquiryIterationService.recordIteration` rather than
 * duplicating cognitive-write logic — confirming a Candidate is exactly a
 * confirmed Inquiry Iteration with a Candidate/Signal provenance trail.
 */
export class InquirySignalService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): InquirySignalService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new InquirySignalService(getDbPool(config.databaseUrl));
  }

  // Signal creation is the manual/deterministic entry point in this phase:
  // the caller (a human reviewer or a future automated classifier run)
  // supplies the classification, confidence, and model_version; this service
  // owns only routine/material routing and Candidate consolidation, not the
  // classification judgement itself.
  async createSignal(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.createSignalInternal(identity, projectId, threadId, body, false);
  }

  /** Internal Experiment-domain bridge; the public Signal route cannot select this source kind. */
  async createSignalFromReviewedExperiment(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    interpretationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.createSignalInternal(identity, projectId, threadId, {
      ...body,
      corpus_item_id: null,
      experiment_interpretation_id: interpretationId,
    }, true);
  }

  private async createSignalInternal(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    body: Record<string, unknown>,
    allowExperimentSource: boolean,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const classification = requiredString(body.classification, "classification");
    if (!SIGNAL_CLASSIFICATIONS.includes(classification as SignalClassification)) {
      throw new HttpError(422, `classification must be one of: ${SIGNAL_CLASSIFICATIONS.join(", ")}`);
    }
    const corpusItemId = optionalString(body.corpus_item_id);
    const experimentInterpretationId = optionalString(body.experiment_interpretation_id);
    if ((corpusItemId === null) === (experimentInterpretationId === null)) {
      throw new HttpError(422, "Exactly one of corpus_item_id or experiment_interpretation_id is required");
    }
    if (experimentInterpretationId && !allowExperimentSource) {
      throw new HttpError(422, "Experiment Evidence Signals must be created through reviewed Interpretation conversion");
    }
    const confidence = optionalNumber(body.confidence, "confidence");
    if (confidence !== null && (confidence < 0 || confidence > 1)) {
      throw new HttpError(422, "confidence must be between 0 and 1");
    }
    const isMaterial = typeof body.is_material === "boolean"
      ? body.is_material
      : MATERIAL_BY_DEFAULT.has(classification as SignalClassification);
    const now = new Date().toISOString();

    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const thread = await db.query<{ id: string; lifecycle_status: string }>(
        `SELECT id, lifecycle_status FROM inquiry_threads
          WHERE id = $1 AND space_id = $2 AND project_id = $3`,
        [threadId, identity.spaceId, projectId],
      );
      if (!thread.rows[0]) throw new HttpError(422, "Thread not found in this Project");
      if (thread.rows[0].lifecycle_status !== "active") {
        throw new HttpError(409, "Evidence Signals can only target an active Thread");
      }
      if (corpusItemId) {
        if (!(await new ProjectCorpusRepository(db).canReadItem(identity, projectId, corpusItemId))) {
          throw new HttpError(422, "Readable Corpus item not found in this Project");
        }
      } else {
        const interpretation = await db.query<{ id: string }>(
          `SELECT i.id FROM experiment_interpretations i
             JOIN experiment_definitions d
               ON d.id=i.definition_id AND d.space_id=i.space_id AND d.project_id=i.project_id
            WHERE i.id=$1 AND i.project_id=$2 AND i.space_id=$3
              AND i.status='reviewed'
              AND d.primary_hypothesis_thread_id=$4
            FOR UPDATE OF i`,
          [experimentInterpretationId, projectId, identity.spaceId, threadId],
        );
        if (!interpretation.rows[0]) {
          throw new HttpError(409, "Experiment Interpretation must be reviewed and target this primary Hypothesis");
        }
      }

      const signalId = randomUUID();
      const producerIdempotencyKey = optionalString(body.producer_idempotency_key);
      const dedupeKey = createHash("sha256")
        .update(JSON.stringify({
          thread_id: threadId,
          corpus_item_id: corpusItemId,
          experiment_interpretation_id: experimentInterpretationId,
          classification,
          model_version: optionalString(body.model_version),
          producer_idempotency_key: producerIdempotencyKey,
        }))
        .digest("hex");
      // Routine signals attach without ever creating review noise; only
      // material signals enter consolidation.
      const initialStatus = classification === "unrelated" ? "dismissed" : isMaterial ? "pending" : "auto_attached";
      const inserted = await db.query<SignalRow>(
        `INSERT INTO inquiry_evidence_signals (
           id, space_id, project_id, thread_id, corpus_item_id, experiment_interpretation_id, classification, is_material,
           confidence, model_version, source_provenance_json, dedupe_key, producer_idempotency_key,
           status, created_by_user_id, created_by_run_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          signalId,
          identity.spaceId,
          projectId,
          threadId,
          corpusItemId,
          experimentInterpretationId,
          classification,
          isMaterial,
          confidence,
          optionalString(body.model_version),
          JSON.stringify(body.source_provenance ?? {}),
          dedupeKey,
          producerIdempotencyKey,
          initialStatus,
          identity.userId,
          null,
          now,
        ],
      );
      let signal = inserted.rows[0];
      if (!signal) {
        const existing = await db.query<SignalRow>(
          `SELECT * FROM inquiry_evidence_signals
            WHERE project_id=$1
              AND (dedupe_key=$2 OR ($3::text IS NOT NULL AND producer_idempotency_key=$3))
            ORDER BY CASE WHEN dedupe_key=$2 THEN 0 ELSE 1 END
            LIMIT 1`,
          [projectId, dedupeKey, producerIdempotencyKey],
        );
        const delivered = existing.rows[0];
        if (!delivered) throw new HttpError(409, "Signal delivery conflicted; retry");
        if (delivered.dedupe_key !== dedupeKey) {
          throw new HttpError(409, "producer_idempotency_key was already used for a different Signal payload");
        }
        return signalToOut(delivered);
      }
      if (isMaterial && initialStatus === "pending") {
        const candidateId = await this.consolidateSignal(
          db,
          identity,
          projectId,
          threadId,
          classification as SignalClassification,
          signal,
          optionalString(body.semantic_key) ?? signal.dedupe_key,
          body.proposed_change ?? {},
          now,
        );
        const linked = await db.query<SignalRow>(
          `UPDATE inquiry_evidence_signals SET status = 'consolidated', candidate_id = $1 WHERE id = $2 RETURNING *`,
          [candidateId, signalId],
        );
        signal = linked.rows[0]!;
      }
      return signalToOut(signal);
    });
  }

  // Consolidation (plan section 10.2): find the one open Candidate for this
  // (thread, candidate_kind), or create it. Multiple Signals about the same
  // contradiction merge into that single Candidate rather than each spawning
  // a separate review item.
  private async consolidateSignal(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    classification: SignalClassification,
    signal: SignalRow,
    semanticKey: string,
    proposedChange: unknown,
    now: string,
  ): Promise<string> {
    const candidateKind = CANDIDATE_KIND_BY_CLASSIFICATION[classification] ?? DEFAULT_CANDIDATE_KIND;
    const candidateId = randomUUID();
    const title = candidateTitle(candidateKind, classification);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO inquiry_signal_candidates (
         id, space_id, project_id, thread_id, candidate_kind, semantic_key, title, summary,
         proposed_change_json, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending', $10, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [candidateId, identity.spaceId, projectId, threadId, candidateKind, semanticKey, title, `Raised by a ${classification} Signal.`, JSON.stringify(proposedChange), now],
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = await db.query<CandidateRow>(
      `SELECT * FROM inquiry_signal_candidates
        WHERE thread_id=$1 AND candidate_kind=$2 AND semantic_key=$3 AND status='pending' FOR UPDATE`,
      [threadId, candidateKind, semanticKey],
    );
    if (!existing.rows[0]) throw new HttpError(409, "Candidate consolidation conflicted; retry");
    await db.query(`UPDATE inquiry_signal_candidates SET updated_at=$1 WHERE id=$2`, [now, existing.rows[0].id]);
    void signal;
    return existing.rows[0].id;
  }

  // Retrieved/Referenced/Adopted (plan section 15.5). A raw search/graph hit
  // that never became a Signal is "Retrieved" — ephemeral, not modeled here.
  // Creating a Signal is already the durable domain link that defines
  // "Referenced"; a Signal whose Candidate was explicitly accepted (produced
  // a confirmed Iteration) has cleared the Adopted checkpoint. This is a
  // read-time classification, not a stored column, so it never drifts from
  // the Signal/Candidate rows it derives from.
  async listAllSignals(identity: SpaceUserIdentity, projectId: string, threadId?: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const params: unknown[] = [identity.spaceId, projectId];
    let clause = "";
    if (threadId) {
      params.push(threadId);
      clause = " AND s.thread_id = $3";
    }
    const rows = await this.db.query<SignalRow & { candidate_status: string | null }>(
      `SELECT s.*, c.status AS candidate_status
         FROM inquiry_evidence_signals s
         LEFT JOIN inquiry_signal_candidates c ON c.id = s.candidate_id
        WHERE s.space_id = $1 AND s.project_id = $2${clause}
        ORDER BY s.created_at DESC`,
      params,
    );
    const readable = await new ProjectCorpusRepository(this.db).readableItemIds(
      identity,
      projectId,
      corpusItemIds(rows.rows),
    );
    return rows.rows
      .filter((row) => signalReadable(row, readable))
      .map((row) => ({
        ...signalToOut(row),
        reference_tier: row.candidate_status === "accepted" ? "adopted" : "referenced",
      }));
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
      `SELECT * FROM inquiry_signal_candidates WHERE space_id = $1 AND project_id = $2${clause} ORDER BY created_at DESC`,
      params,
    );
    return this.filterReadableCandidates(identity, projectId, rows.rows);
  }

  async getCandidate(identity: SpaceUserIdentity, projectId: string, candidateId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.db.query<CandidateRow>(
      `SELECT * FROM inquiry_signal_candidates WHERE id = $1 AND space_id = $2 AND project_id = $3`,
      [candidateId, identity.spaceId, projectId],
    );
    if (!row.rows[0]) throw new HttpError(404, "Candidate not found");
    const signals = await this.db.query<SignalRow>(
      `SELECT * FROM inquiry_evidence_signals WHERE candidate_id = $1`,
      [candidateId],
    );
    const readable = await new ProjectCorpusRepository(this.db).readableItemIds(
      identity,
      projectId,
      corpusItemIds(signals.rows),
    );
    if (signals.rows.length === 0 || !signals.rows.every((signal) => signalReadable(signal, readable))) {
      throw new HttpError(404, "Candidate not found");
    }
    return { ...candidateToOut(row.rows[0]), signals: signals.rows.map(signalToOut) };
  }

  // Dismissing (or deferring/merging/flagging-a-gap on) a Candidate never
  // deletes or mutates the contributing Signal rows — they remain a durable
  // audit record regardless of the review decision (plan section 10.4,
  // Candidate review completion invariant).
  async decideCandidate(
    identity: SpaceUserIdentity,
    projectId: string,
    candidateId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const decision = requiredString(body.decision, "decision");
    if (!CANDIDATE_DECISIONS.includes(decision as CandidateDecision)) {
      throw new HttpError(422, `decision must be one of: ${CANDIDATE_DECISIONS.join(", ")}`);
    }
    const now = new Date().toISOString();

    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const row = await db.query<CandidateRow>(
        `SELECT * FROM inquiry_signal_candidates WHERE id = $1 AND space_id = $2 AND project_id = $3 FOR UPDATE`,
        [candidateId, identity.spaceId, projectId],
      );
      const candidate = row.rows[0];
      if (!candidate) throw new HttpError(404, "Candidate not found");
      await this.assertCandidateReadable(db, identity, projectId, candidate.id);
      if (candidate.status !== "pending") throw new HttpError(409, `Candidate already decided (${candidate.status})`);

      let resultingIterationId: string | null = null;
      let newStatus: string;
      switch (decision as CandidateDecision) {
        case "accept": {
          await this.assertActiveThread(db, identity.spaceId, projectId, candidate.thread_id);
          const proposed = isRecord(candidate.proposed_change_json) ? candidate.proposed_change_json : {};
          const edits = isRecord(body.edits) ? body.edits : {};
          const iterationBody = {
            ...proposed,
            ...edits,
            ...body,
            change_summary: optionalString(body.change_summary) ?? candidate.summary ?? candidate.title,
            trigger_kind: "candidate_accept",
            trigger_ref: candidate.id,
          };
          const iteration = await new InquiryIterationService(db).recordIteration(identity, projectId, candidate.thread_id, iterationBody);
          resultingIterationId = iteration.id as string;
          newStatus = "accepted";
          break;
        }
        case "merge": {
          const targetId = requiredString(body.target_candidate_id, "target_candidate_id");
          if (targetId === candidateId) throw new HttpError(422, "A Candidate cannot merge into itself");
          const target = await db.query<CandidateRow>(
            `SELECT * FROM inquiry_signal_candidates
              WHERE id=$1 AND space_id=$2 AND project_id=$3 AND status='pending'
                AND thread_id=$4 AND candidate_kind=$5
              FOR UPDATE`,
            [targetId, identity.spaceId, projectId, candidate.thread_id, candidate.candidate_kind],
          );
          if (!target.rows[0]) throw new HttpError(422, "Merge target must be pending on the same Thread and of the same kind");
          await this.assertCandidateReadable(db, identity, projectId, targetId);
          await db.query(`UPDATE inquiry_evidence_signals SET candidate_id=$1 WHERE candidate_id=$2`, [targetId, candidateId]);
          newStatus = "merged";
          break;
        }
        case "defer": {
          requiredString(body.reason, "reason");
          const deferUntil = requiredString(body.defer_until, "defer_until");
          if (!Number.isFinite(Date.parse(deferUntil)) || Date.parse(deferUntil) <= Date.now()) {
            throw new HttpError(422, "defer_until must be a future ISO timestamp");
          }
          newStatus = "deferred";
          break;
        }
        case "gap": {
          await this.assertActiveThread(db, identity.spaceId, projectId, candidate.thread_id);
          const gapStatement = requiredString(body.gap_statement, "gap_statement");
          const threadId = randomUUID();
          await db.query(
            `INSERT INTO inquiry_threads
              (id,space_id,project_id,kind,statement,lifecycle_status,attention_state,priority,primary_parent_id,created_from,created_by_user_id,created_at,updated_at)
             VALUES ($1,$2,$3,'question',$4,'active','backlog',0,$5,'ai_candidate',$6,$7,$7)`,
            [threadId, identity.spaceId, projectId, gapStatement, candidate.thread_id, identity.userId, now],
          );
          await db.query(
            `INSERT INTO inquiry_question_states (thread_id,space_id,answer_state) VALUES ($1,$2,'open')`,
            [threadId, identity.spaceId],
          );
          await db.query(
            `INSERT INTO inquiry_thread_relations
              (id,space_id,project_id,from_thread_id,to_thread_id,relation_kind,created_by_user_id,created_at)
             VALUES ($1,$2,$3,$4,$5,'decomposes_into',$6,$7)`,
            [randomUUID(), identity.spaceId, projectId, candidate.thread_id, threadId, identity.userId, now],
          );
          await db.query(
            `INSERT INTO inquiry_thread_structure_events
              (id,space_id,project_id,thread_id,action_kind,from_value_json,to_value_json,actor_user_id,created_at)
             VALUES ($1,$2,$3,$4,'definition_child_created',$5::jsonb,$6::jsonb,$7,$8)`,
            [
              randomUUID(),
              identity.spaceId,
              projectId,
              candidate.thread_id,
              JSON.stringify({ candidate_id: candidateId }),
              JSON.stringify({ thread_id: threadId, statement: gapStatement }),
              identity.userId,
              now,
            ],
          );
          await db.query(
            `UPDATE inquiry_signal_candidates SET resulting_thread_id=$1 WHERE id=$2`,
            [threadId, candidateId],
          );
          newStatus = "gap";
          break;
        }
        case "dismiss":
        default:
          newStatus = "dismissed";
          break;
      }

      const updated = await db.query<CandidateRow>(
        `UPDATE inquiry_signal_candidates SET
           status = $1::varchar, resulting_iteration_id = $2, decided_by_user_id = $3, decided_at = $4,
           decision_reason=$5,
           defer_until=CASE WHEN $1::varchar='deferred' THEN $6::timestamptz ELSE defer_until END,
           merged_into_candidate_id=CASE WHEN $1::varchar='merged' THEN $7 ELSE merged_into_candidate_id END,
           updated_at = $4
         WHERE id = $8 RETURNING *`,
        [
          newStatus,
          resultingIterationId,
          identity.userId,
          now,
          optionalString(body.reason),
          optionalString(body.defer_until),
          optionalString(body.target_candidate_id),
          candidateId,
        ],
      );
      return candidateToOut(updated.rows[0]!);
    });
  }

  // Bounded review round (plan section 10.4): a fixed small set of pending
  // Candidates not already assigned to another open packet.
  async openReviewPacket(identity: SpaceUserIdentity, projectId: string, limit?: number): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const packetSize = limit && limit > 0 ? Math.min(limit, 20) : DEFAULT_REVIEW_PACKET_SIZE;
    const now = new Date().toISOString();

    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      // A tab can disappear before its best-effort close request completes.
      // Starting the next checkpoint therefore closes this reviewer's older
      // open packets and releases their still-pending Candidates.
      const previousPackets = await db.query<{ id: string }>(
        `SELECT id FROM inquiry_review_packets
          WHERE space_id=$1 AND project_id=$2 AND opened_by_user_id=$3 AND status='open'
          FOR UPDATE`,
        [identity.spaceId, projectId, identity.userId],
      );
      if (previousPackets.rows.length > 0) {
        const ids = previousPackets.rows.map((packet) => packet.id);
        await db.query(
          `UPDATE inquiry_signal_candidates SET review_packet_id=NULL
            WHERE review_packet_id=ANY($1::varchar[]) AND status='pending'`,
          [ids],
        );
        await db.query(
          `UPDATE inquiry_review_packets SET status='closed', closed_at=$1
            WHERE id=ANY($2::varchar[])`,
          [now, ids],
        );
      }
      // Lock the available pool first, apply the owning Corpus ACL, and only
      // then take the bounded batch. Applying LIMIT before ACL filtering can
      // falsely return an empty packet while later readable Candidates exist.
      const available = await db.query<CandidateRow>(
        `SELECT * FROM inquiry_signal_candidates
          WHERE space_id=$1 AND project_id=$2 AND status='pending' AND review_packet_id IS NULL
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED`,
        [identity.spaceId, projectId],
      );
      const visible = await this.filterReadableCandidates(identity, projectId, available.rows, db);
      const selected = visible.slice(0, packetSize);
      if (selected.length === 0) {
        return { id: null, project_id: projectId, status: "empty", created_at: now, candidates: [] };
      }
      const packetId = randomUUID();
      await db.query(
        `INSERT INTO inquiry_review_packets (id, space_id, project_id, status, opened_by_user_id, created_at)
         VALUES ($1, $2, $3, 'open', $4, $5)`,
        [packetId, identity.spaceId, projectId, identity.userId, now],
      );
      await db.query(
        `UPDATE inquiry_signal_candidates SET review_packet_id=$1, updated_at=$2
          WHERE id=ANY($3::varchar[])`,
        [packetId, now, selected.map((candidate) => candidate.id)],
      );
      return { id: packetId, project_id: projectId, status: "open", created_at: now, candidates: selected };
    });
  }

  async getReviewPacket(identity: SpaceUserIdentity, projectId: string, packetId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const packet = await this.db.query<{ id: string; status: string; created_at: unknown; closed_at: unknown }>(
      `SELECT id, status, created_at, closed_at FROM inquiry_review_packets WHERE id = $1 AND space_id = $2 AND project_id = $3`,
      [packetId, identity.spaceId, projectId],
    );
    if (!packet.rows[0]) throw new HttpError(404, "Review packet not found");
    const candidates = await this.db.query<CandidateRow>(
      `SELECT * FROM inquiry_signal_candidates WHERE review_packet_id = $1 ORDER BY created_at ASC`,
      [packetId],
    );
    return {
      id: packet.rows[0].id,
      status: packet.rows[0].status,
      created_at: dateIso(packet.rows[0].created_at),
      closed_at: dateIso(packet.rows[0].closed_at),
      candidates: await this.filterReadableCandidates(identity, projectId, candidates.rows),
    };
  }

  async closeReviewPacket(identity: SpaceUserIdentity, projectId: string, packetId: string): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const packet = await db.query<{ id: string }>(
        `SELECT id FROM inquiry_review_packets WHERE id = $1 AND space_id = $2 AND project_id = $3 FOR UPDATE`,
        [packetId, identity.spaceId, projectId],
      );
      if (!packet.rows[0]) throw new HttpError(404, "Review packet not found");
      // Still-pending Candidates go back into the unassigned pool so a later
      // packet can pick them up; decided Candidates keep the historical link.
      await db.query(
        `UPDATE inquiry_signal_candidates SET review_packet_id = NULL WHERE review_packet_id = $1 AND status = 'pending'`,
        [packetId],
      );
      await db.query(
        `UPDATE inquiry_review_packets SET status = 'closed', closed_at = COALESCE(closed_at, $1) WHERE id = $2`,
        [now, packetId],
      );
      return { id: packetId, status: "closed", closed_at: now };
    });
  }

  // Read-only cited change summary (plan section 10.3). Never writes Thread
  // position, confidence tier, status, or Next Focus.
  async generateDeltaBrief(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const coverageEnd = new Date().toISOString();
    const coverageStart = optionalString(body.coverage_start);

    const params: unknown[] = [identity.spaceId, projectId];
    let windowClause = "";
    if (coverageStart) {
      params.push(coverageStart, coverageEnd);
      windowClause = ` AND s.created_at >= $3 AND s.created_at <= $4`;
    } else {
      params.push(coverageEnd);
      windowClause = ` AND s.created_at <= $3`;
    }

    const rawSignals = await this.db.query<SignalRow & { thread_statement: string }>(
      `SELECT s.*, t.statement AS thread_statement
         FROM inquiry_evidence_signals s
         JOIN inquiry_threads t ON t.id = s.thread_id AND t.space_id = s.space_id
        WHERE s.space_id = $1 AND s.project_id = $2${windowClause}
        ORDER BY s.created_at ASC`,
      params,
    );

    const readable = await new ProjectCorpusRepository(this.db).readableItemIds(
      identity,
      projectId,
      corpusItemIds(rawSignals.rows),
    );
    const signals = { rows: rawSignals.rows.filter((row) => signalReadable(row, readable)) };
    const reinforced = new Map<string, { thread_id: string; statement: string; count: number }>();
    const challenged = new Map<string, { thread_id: string; statement: string; count: number }>();
    const gaps = new Map<string, { thread_id: string; statement: string; new_gaps: number; filled_gaps: number }>();
    for (const row of signals.rows) {
      const bucket = (map: typeof reinforced) => {
        const existing = map.get(row.thread_id) ?? { thread_id: row.thread_id, statement: row.thread_statement, count: 0 };
        existing.count += 1;
        map.set(row.thread_id, existing);
      };
      if (row.classification === "supports" || row.classification === "adds_context" || row.classification === "adds_method") bucket(reinforced);
      if (row.classification === "contradicts") bucket(challenged);
      if (row.classification === "raises_gap" || row.classification === "fills_gap") {
        const existing = gaps.get(row.thread_id) ?? { thread_id: row.thread_id, statement: row.thread_statement, new_gaps: 0, filled_gaps: 0 };
        if (row.classification === "raises_gap") existing.new_gaps += 1;
        else existing.filled_gaps += 1;
        gaps.set(row.thread_id, existing);
      }
    }

    const pendingCandidates = await this.db.query<CandidateRow>(
      `SELECT * FROM inquiry_signal_candidates WHERE space_id = $1 AND project_id = $2 AND status = 'pending'`,
      [identity.spaceId, projectId],
    );
    const decisionsRequired = await this.filterReadableCandidates(identity, projectId, pendingCandidates.rows);

    const content = {
      schema_version: "inquiry_delta_brief.v1",
      input_and_coverage_window: { coverage_start: coverageStart ?? null, coverage_end: coverageEnd, signal_count: signals.rows.length },
      reinforced_positions: [...reinforced.values()],
      challenged_positions: [...challenged.values()],
      gap_changes: [...gaps.values()],
      decisions_required: decisionsRequired.length,
      no_change_statement: signals.rows.length === 0 ? "No new Evidence Signals in this window." : null,
      source_and_thread_refs: signals.rows.map((row) => ({ signal_id: row.id, thread_id: row.thread_id, corpus_item_id: row.corpus_item_id })),
    };

    const briefId = randomUUID();
    const now = new Date().toISOString();
    await withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await db.query(
        `INSERT INTO inquiry_delta_briefs (id, space_id, project_id, coverage_start, coverage_end, content_json, generated_by_user_id, generated_by_run_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [briefId, identity.spaceId, projectId, coverageStart, coverageEnd, JSON.stringify(content), identity.userId, null, now],
      );
    });
    return { id: briefId, project_id: projectId, coverage_start: coverageStart ?? null, coverage_end: coverageEnd, content, created_at: now };
  }

  async reopenCandidate(
    identity: SpaceUserIdentity,
    projectId: string,
    candidateId: string,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const candidate = await db.query<CandidateRow>(
        `SELECT * FROM inquiry_signal_candidates
          WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`,
        [candidateId, identity.spaceId, projectId],
      );
      if (!candidate.rows[0] || candidate.rows[0].status !== "deferred") {
        throw new HttpError(409, "Only a deferred Candidate can be reopened");
      }
      await this.assertCandidateReadable(db, identity, projectId, candidateId);
      const equivalent = await db.query(
        `SELECT 1 FROM inquiry_signal_candidates
          WHERE thread_id=$1 AND candidate_kind=$2 AND semantic_key=$3
            AND status='pending' AND id<>$4
          FOR UPDATE`,
        [candidate.rows[0].thread_id, candidate.rows[0].candidate_kind, candidate.rows[0].semantic_key, candidateId],
      );
      if (equivalent.rows[0]) throw new HttpError(409, "An equivalent Candidate is already pending");
      const updated = await db.query<CandidateRow>(
        `UPDATE inquiry_signal_candidates SET status='pending', defer_until=NULL,
           review_packet_id=NULL,
           decided_by_user_id=NULL, decided_at=NULL, decision_reason=NULL, updated_at=$1
         WHERE id=$2 AND space_id=$3 AND project_id=$4
         RETURNING *`,
        [new Date().toISOString(), candidateId, identity.spaceId, projectId],
      );
      return candidateToOut(updated.rows[0]);
    });
  }

  private async filterReadableCandidates(
    identity: SpaceUserIdentity,
    projectId: string,
    candidates: CandidateRow[],
    db: Queryable = this.db,
  ): Promise<Record<string, unknown>[]> {
    if (candidates.length === 0) return [];
    const signals = await db.query<SignalRow>(
      `SELECT * FROM inquiry_evidence_signals WHERE candidate_id = ANY($1::varchar[])`,
      [candidates.map((candidate) => candidate.id)],
    );
    const readable = await new ProjectCorpusRepository(db).readableItemIds(
      identity,
      projectId,
      corpusItemIds(signals.rows),
    );
    const counts = new Map<string, { total: number; readable: number }>();
    for (const signal of signals.rows) {
      if (!signal.candidate_id) continue;
      const count = counts.get(signal.candidate_id) ?? { total: 0, readable: 0 };
      count.total += 1;
      if (signalReadable(signal, readable)) count.readable += 1;
      counts.set(signal.candidate_id, count);
    }
    const visibleCandidates = new Set(
      [...counts.entries()].filter(([, count]) => count.total > 0 && count.total === count.readable).map(([id]) => id),
    );
    return candidates.filter((candidate) => visibleCandidates.has(candidate.id)).map(candidateToOut);
  }

  private async assertCandidateReadable(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
    candidateId: string,
  ): Promise<void> {
    const signals = await db.query<SignalRow>(
      `SELECT * FROM inquiry_evidence_signals WHERE candidate_id=$1`,
      [candidateId],
    );
    const readable = await new ProjectCorpusRepository(db).readableItemIds(
      identity,
      projectId,
      corpusItemIds(signals.rows),
    );
    if (signals.rows.length === 0 || !signals.rows.every((signal) => signalReadable(signal, readable))) {
      throw new HttpError(404, "Candidate not found");
    }
  }

  private async assertActiveThread(db: Queryable, spaceId: string, projectId: string, threadId: string): Promise<void> {
    const thread = await db.query(
      `SELECT 1 FROM inquiry_threads
        WHERE id=$1 AND space_id=$2 AND project_id=$3 AND lifecycle_status='active'`,
      [threadId, spaceId, projectId],
    );
    if (!thread.rows[0]) throw new HttpError(409, "Candidate target Thread is not active");
  }
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(422, `${label} must be a number`);
  return n;
}

function candidateTitle(candidateKind: string, classification: string): string {
  if (candidateKind === "contradiction") return "New contradiction needs review";
  if (classification === "raises_gap") return "New gap identified";
  if (classification === "fills_gap") return "A known gap may now be resolved";
  return "Material change needs review";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corpusItemIds(signals: Array<{ corpus_item_id: string | null }>): string[] {
  return signals.map((signal) => signal.corpus_item_id).filter((id): id is string => id !== null);
}

// An Experiment-Interpretation-sourced Signal has no Corpus item to
// per-object-ACL-check — Project membership (already asserted by every
// caller) is the only gate for it, same as an Interpretation itself.
function signalReadable(signal: { corpus_item_id: string | null }, readableCorpusItemIds: Set<string>): boolean {
  return signal.corpus_item_id === null || readableCorpusItemIds.has(signal.corpus_item_id);
}
