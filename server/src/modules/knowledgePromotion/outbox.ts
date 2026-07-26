import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";

export type DomainChangeSourceKind = "note" | "inquiry_thread" | "experiment_interpretation";
export type DomainChangeSignificance = "trivial" | "material";

/**
 * A Knowledge Candidate's stored, pinned reference — chosen at promotion
 * time (a human picks which Note blocks matter), never a pointer to a
 * mutable "current object." `experiment_interpretation` never appears in
 * `domain_change_outbox`: once converted, an Interpretation is immutable
 * (its Runs/Observations/repro_lock are already terminal), so it never
 * needs revalidation, only promotion.
 */
export type PinnedSourceRef =
  | { kind: "note_revision"; note_id: string; revision_id: string; version: number; content_hash: string; block_anchors: number[] }
  | { kind: "inquiry_thread_revision"; thread_id: string; revision_id: string; version: number; content_hash: string }
  | { kind: "experiment_interpretation"; interpretation_id: string; content_hash: string; definition_id: string; run_ids: string[]; repro_lock_hash: string | null };

/** The revision a `domain_change_outbox` row reports — no anchors: it describes the new revision, not any one Candidate's pin into it. */
export type SourceRevisionRef =
  | { kind: "note_revision"; note_id: string; revision_id: string; version: number; content_hash: string }
  | { kind: "inquiry_thread_revision"; thread_id: string; revision_id: string; version: number; content_hash: string };

/**
 * The one write path into `domain_change_outbox`. Source
 * domains (Note, Inquiry) call this in the SAME transaction as the new
 * eligible revision it describes — never as a separate, later write, so an
 * event can never be recorded for a revision that didn't actually commit.
 * Pure transport/audit: this function owns no domain state and creates no
 * cross-domain relationship.
 */
export async function emitDomainChangeEvent(db: Queryable, input: {
  spaceId: string;
  sourceKind: Exclude<DomainChangeSourceKind, "experiment_interpretation">;
  sourceId: string;
  sourceRef: SourceRevisionRef;
  changeKind: string;
  // Null when the source domain has no cheap non-LLM significance signal at
  // write time (Notes: any edit could touch any block, so only comparing
  // the Candidate's own pinned block_anchors at revalidation time can tell
  // trivial from material). Inquiry Threads always pass one — see
  // threadRevisionService.ts.
  changeSignificance: DomainChangeSignificance | null;
  occurredAt: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO domain_change_outbox (
       id, space_id, source_kind, source_id, source_ref_json, change_kind, change_significance, occurred_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [randomUUID(), input.spaceId, input.sourceKind, input.sourceId, JSON.stringify(input.sourceRef),
      input.changeKind, input.changeSignificance ?? null, input.occurredAt],
  );
}
