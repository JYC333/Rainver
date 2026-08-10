/**
 * Provenance + relation write helpers for the memory apply path:
 * `write_provenance_links`, `copy_provenance_to_memory`,
 * `record_memory_supersedes_relation`, `dominant_source_trust`,
 * `first_activity_id`, `merge_distinct_provenance_entries`,
 * `proposal_provenance_entry`, and `user_confirmation_entry`.
 *
 * Pure helpers are decision/derivation logic; the DB-write helpers INSERT into
 * `provenance_links` / `memory_relations` and run inside the caller's apply
 * transaction (they never commit). Used by the memory appliers; not wired to any
 * route yet.
 */

import { randomUUID } from "node:crypto";
import { isProvenanceSourceType } from "../ontology/entities";
import type { ProvenanceEntry } from "./sourceMonitoring";

export const TARGET_MEMORY = "memory";
export const TARGET_POLICY = "policy";

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

const SOURCE_TRUST_VALUES = new Set([
  "user_confirmed",
  "internal_system",
  "trusted_external",
  "untrusted_external",
  "agent_inferred",
]);

// Canonical source-trust ranking.
const TRUST_RANK: Record<string, number> = {
  user_confirmed: 50,
  trusted_external: 40,
  internal_system: 35,
  untrusted_external: 20,
  agent_inferred: 10,
};

/** Strongest declared trust among entries (→ `MemoryEntry.source_trust`). */
export function dominantSourceTrust(entries: readonly ProvenanceEntry[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const e of entries) {
    const t = e.source_trust;
    if (typeof t !== "string" || !SOURCE_TRUST_VALUES.has(t)) continue;
    const r = TRUST_RANK[t] ?? 0;
    if (r > bestRank) {
      bestRank = r;
      best = t;
    }
  }
  return best;
}

export function firstActivityId(entries: readonly ProvenanceEntry[]): string | null {
  for (const e of entries) {
    if (e.source_type === "activity") {
      const sid = typeof e.source_id === "string" ? e.source_id.trim() : "";
      if (sid) return sid;
    }
  }
  return null;
}

export function userConfirmationEntry(
  userId: string,
  evidence?: Record<string, unknown>,
): ProvenanceEntry {
  const ev: Record<string, unknown> = { ...(evidence ?? {}) };
  if (ev.channel === undefined) ev.channel = "explicit_user_action";
  return {
    source_type: "user_confirmation",
    source_id: userId,
    source_trust: "user_confirmed",
    evidence_json: ev,
  };
}

export function proposalProvenanceEntry(
  proposalId: string,
  evidence?: Record<string, unknown>,
): ProvenanceEntry {
  return {
    source_type: "proposal",
    source_id: proposalId,
    source_trust: "internal_system",
    evidence_json: { ...(evidence ?? {}) },
  };
}

/** Stable de-dup by (source_type, source_id, source_trust). */
export function mergeDistinctProvenanceEntries(
  ...lists: ReadonlyArray<readonly ProvenanceEntry[]>
): ProvenanceEntry[] {
  const seen = new Set<string>();
  const out: ProvenanceEntry[] = [];
  for (const list of lists) {
    for (const e of list) {
      if (typeof e.source_type !== "string" || typeof e.source_id !== "string") continue;
      const tr = typeof e.source_trust === "string" ? e.source_trust : null;
      const key = `${e.source_type} ${e.source_id} ${tr ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** INSERT provenance rows; returns count inserted. Does not commit. */
export async function writeProvenanceLinks(
  db: Queryable,
  input: {
    spaceId: string;
    targetType: string;
    targetId: string;
    entries: readonly ProvenanceEntry[];
  },
): Promise<number> {
  // Validation lives here rather than at the call sites. It used to be the
  // caller's job and three of them each kept their own copy of the vocabulary,
  // two of which silently dropped what they did not recognize — so a
  // divergence lost provenance with no error anywhere. A bad value is now a
  // rejected write, which is what B12F means by the registry owning the closed
  // set while the column keeps only a format constraint.
  for (const e of input.entries) {
    if (typeof e.source_id !== "string" || !isProvenanceSourceType(e.source_type)) {
      throw new Error(`Unknown provenance source type: ${String(e.source_type)}`);
    }
  }
  const valid = input.entries.filter(
    (e) => typeof e.source_type === "string" && typeof e.source_id === "string",
  );
  if (valid.length === 0) return 0;

  const cols =
    "id, space_id, target_type, target_id, source_type, source_id, source_trust, evidence_json, created_at";
  const now = new Date().toISOString();
  const groups: string[] = [];
  const params: unknown[] = [];
  for (const e of valid) {
    const base = params.length;
    groups.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9})`,
    );
    params.push(
      randomUUID(),
      input.spaceId,
      input.targetType,
      input.targetId,
      e.source_type,
      e.source_id,
      typeof e.source_trust === "string" ? e.source_trust : null,
      e.evidence_json && typeof e.evidence_json === "object" ? JSON.stringify(e.evidence_json) : null,
      now,
    );
  }
  await db.query(`INSERT INTO provenance_links (${cols}) VALUES ${groups.join(", ")}`, params);
  return valid.length;
}

interface ProvenanceLinkRow {
  source_type: string;
  source_id: string;
  source_trust: string | null;
  evidence_json: Record<string, unknown> | null;
}

/** Copy a memory's provenance rows onto a new memory id (versioning). */
export async function copyProvenanceToMemory(
  db: Queryable,
  input: { spaceId: string; fromMemoryId: string; toMemoryId: string },
): Promise<number> {
  const rows = await db.query<ProvenanceLinkRow>(
    `SELECT source_type, source_id, source_trust, evidence_json
       FROM provenance_links
      WHERE space_id = $1 AND target_type = $2 AND target_id = $3`,
    [input.spaceId, TARGET_MEMORY, input.fromMemoryId],
  );
  const entries: ProvenanceEntry[] = rows.rows.map((pl) => ({
    source_type: pl.source_type,
    source_id: pl.source_id,
    ...(pl.source_trust !== null ? { source_trust: pl.source_trust } : {}),
    ...(pl.evidence_json ? { evidence_json: { ...pl.evidence_json } } : {}),
  }));
  return writeProvenanceLinks(db, {
    spaceId: input.spaceId,
    targetType: TARGET_MEMORY,
    targetId: input.toMemoryId,
    entries,
  });
}

/** INSERT a `supersedes` memory_relations edge (new → old). Does not commit. */
export async function recordMemorySupersedesRelation(
  db: Queryable,
  input: { spaceId: string; newMemoryId: string; oldMemoryId: string; proposalId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO memory_relations
       (id, space_id, source_type, source_id, target_type, target_id,
        relation_type, created_from_proposal_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'supersedes', $7, $8)`,
    [
      randomUUID(),
      input.spaceId,
      TARGET_MEMORY,
      input.newMemoryId,
      TARGET_MEMORY,
      input.oldMemoryId,
      input.proposalId,
      new Date().toISOString(),
    ],
  );
}
