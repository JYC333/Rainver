import { createHash, randomUUID } from "node:crypto";
import type {
  RetrievalFeedbackSignal,
  RetrievalObjectType,
} from "@agent-space/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { normalizeTextForSearch } from "./normalize.js";
import type { RetrievalRegistry } from "./registry.js";
import type { ScoredCandidate } from "./types.js";

export interface RetrievalFeedbackConfig {
  /** Implicit signals saturate separately so repeated opens cannot dominate. */
  maxImplicitBoost: number;
  /** Explicit user assertions are stronger, but still bounded. */
  maxExplicitBoost: number;
  /** Final cap across all positive feedback. */
  maxTotalBoost: number;
  /** Event half-life in days. */
  halfLifeDays: number;
  /** Ignore very old events so query-time reads stay bounded. */
  maxAgeDays: number;
  /** A dwell signal contributes only once it represents actual use. */
  dwellMinMs: number;
}

export const DEFAULT_RETRIEVAL_FEEDBACK: RetrievalFeedbackConfig = {
  maxImplicitBoost: 0.03,
  maxExplicitBoost: 0.08,
  maxTotalBoost: 0.1,
  halfLifeDays: 45,
  maxAgeDays: 365,
  dwellMinMs: 5_000,
};

const SIGNAL_CLASS: Record<RetrievalFeedbackSignal, "implicit" | "explicit"> = {
  opened: "implicit",
  dwell: "implicit",
  used: "implicit",
  explicit_relevant: "explicit",
  accepted: "explicit",
  pinned: "explicit",
};

const SIGNAL_WEIGHT: Record<RetrievalFeedbackSignal, number> = {
  opened: 0.0025,
  dwell: 0.005,
  used: 0.015,
  explicit_relevant: 0.06,
  accepted: 0.06,
  pinned: 0.08,
};

export interface FeedbackEventRow {
  object_type: RetrievalObjectType;
  object_id: string;
  signal_type: RetrievalFeedbackSignal;
  dwell_ms: number | null;
  created_at: string | Date;
}

export interface RetrievalFeedbackRecordInput {
  spaceId: string;
  viewerUserId: string;
  surface: string;
  query: string;
  objectType: RetrievalObjectType;
  objectId: string;
  signalType: RetrievalFeedbackSignal;
  dwellMs?: number | null;
  metadata?: { source?: "result_open" | "dwell_timer" | "explicit_action" } | null;
}

export interface RetrievalFeedbackBoostInput {
  spaceId: string;
  viewerUserId: string;
  surface: string;
  query: string;
  candidates: ScoredCandidate[];
  nowMs?: number;
}

/**
 * Positive-only feedback capture and ranking boost. This service never records
 * skipped/not-clicked signals, and query-time boosting reads only the current
 * viewer's own positive events for already-revalidated candidates.
 */
export class RetrievalFeedbackService {
  constructor(
    private readonly db: Queryable,
    private readonly registry?: RetrievalRegistry,
    private readonly cfg: RetrievalFeedbackConfig = DEFAULT_RETRIEVAL_FEEDBACK,
  ) {}

  async record(input: RetrievalFeedbackRecordInput): Promise<boolean> {
    const adapter = this.registry?.adapterFor(input.objectType);
    if (!adapter) return false;
    const visible = await adapter.revalidate(
      this.db,
      input.spaceId,
      input.objectType,
      input.objectId,
      input.viewerUserId,
    );
    if (!visible) return false;
    await this.db.query(
      `INSERT INTO retrieval_feedback_events (
         id, space_id, actor_user_id, surface, query_hash,
         object_type, object_id, signal_type, dwell_ms, metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        randomUUID(),
        input.spaceId,
        input.viewerUserId,
        input.surface,
        retrievalFeedbackQueryHash(input.query),
        input.objectType,
        input.objectId,
        input.signalType,
        input.dwellMs ?? null,
        JSON.stringify(input.metadata ?? {}),
        new Date().toISOString(),
      ],
    );
    return true;
  }

  async applyBoosts(input: RetrievalFeedbackBoostInput): Promise<ScoredCandidate[]> {
    const candidates = input.candidates;
    if (candidates.length === 0) return candidates;
    const nowMs = input.nowMs ?? Date.now();
    const objectTypes = [...new Set(candidates.map((candidate) => candidate.objectType))];
    const objectIds = [...new Set(candidates.map((candidate) => candidate.objectId))];
    const candidateKeys = new Set(candidates.map(candidateKey));
    const since = new Date(nowMs - this.cfg.maxAgeDays * 86_400_000).toISOString();
    const result = await this.db.query<FeedbackEventRow>(
      `SELECT object_type, object_id, signal_type, dwell_ms, created_at
         FROM retrieval_feedback_events
        WHERE space_id = $1
          AND actor_user_id = $2
          AND surface = $3
          AND query_hash = $4
          AND object_type = ANY($5::retrieval_object_type[])
          AND object_id = ANY($6::varchar[])
          AND created_at >= $7
        ORDER BY created_at DESC`,
      [
        input.spaceId,
        input.viewerUserId,
        input.surface,
        retrievalFeedbackQueryHash(input.query),
        objectTypes,
        objectIds,
        since,
      ],
    );
    const byObject = new Map<string, FeedbackEventRow[]>();
    for (const row of result.rows) {
      const key = `${row.object_type}:${row.object_id}`;
      if (!candidateKeys.has(key)) continue;
      const rows = byObject.get(key) ?? [];
      rows.push(row);
      byObject.set(key, rows);
    }
    return candidates
      .map((candidate) => ({
        ...candidate,
        score: candidate.score * feedbackBoostMultiplier(byObject.get(candidateKey(candidate)) ?? [], nowMs, this.cfg),
      }))
      .sort((a, b) => b.score - a.score || a.objectId.localeCompare(b.objectId))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }
}

export function retrievalFeedbackQueryHash(query: string): string {
  return createHash("sha256").update(normalizeTextForSearch(query)).digest("hex");
}

export function feedbackBoostMultiplier(
  events: readonly FeedbackEventRow[],
  nowMs: number,
  cfg: RetrievalFeedbackConfig = DEFAULT_RETRIEVAL_FEEDBACK,
): number {
  let implicit = 0;
  let explicit = 0;
  for (const event of events) {
    const contribution = feedbackContribution(event, nowMs, cfg);
    if (SIGNAL_CLASS[event.signal_type] === "explicit") explicit += contribution;
    else implicit += contribution;
  }
  const cappedImplicit = Math.min(cfg.maxImplicitBoost, implicit);
  const cappedExplicit = Math.min(cfg.maxExplicitBoost, explicit);
  return 1 + Math.min(cfg.maxTotalBoost, cappedImplicit + cappedExplicit);
}

function feedbackContribution(
  event: FeedbackEventRow,
  nowMs: number,
  cfg: RetrievalFeedbackConfig,
): number {
  if (event.signal_type === "dwell" && (event.dwell_ms ?? 0) < cfg.dwellMinMs) return 0;
  const createdMs =
    event.created_at instanceof Date ? event.created_at.getTime() : Date.parse(event.created_at);
  if (!Number.isFinite(createdMs)) return 0;
  const ageDays = Math.max(0, (nowMs - createdMs) / 86_400_000);
  if (ageDays > cfg.maxAgeDays) return 0;
  const decay = cfg.halfLifeDays > 0 ? Math.pow(0.5, ageDays / cfg.halfLifeDays) : 1;
  return SIGNAL_WEIGHT[event.signal_type] * decay;
}

function candidateKey(candidate: Pick<ScoredCandidate, "objectType" | "objectId">): string {
  return `${candidate.objectType}:${candidate.objectId}`;
}
