import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import {
  projectEntitySummaryRegistry,
  type ProjectEntitySummary,
  type ProjectEntitySummaryAdapter,
} from "../projects/overviewRegistry.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";
import { ProjectCorpusRepository } from "../projects/corpusRepository.js";

async function readableCandidateIds(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const signals = await db.query<{ candidate_id: string; corpus_item_id: string }>(
    `SELECT candidate_id, corpus_item_id FROM inquiry_evidence_signals
      WHERE candidate_id=ANY($1::varchar[])`,
    [candidateIds],
  );
  const readableCorpus = await new ProjectCorpusRepository(db).readableItemIds(
    identity,
    projectId,
    signals.rows.map((signal) => signal.corpus_item_id),
  );
  const counts = new Map<string, { total: number; readable: number }>();
  for (const signal of signals.rows) {
    const count = counts.get(signal.candidate_id) ?? { total: 0, readable: 0 };
    count.total += 1;
    if (readableCorpus.has(signal.corpus_item_id)) count.readable += 1;
    counts.set(signal.candidate_id, count);
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count.total > 0 && count.total === count.readable)
      .map(([candidateId]) => candidateId),
  );
}

// Registers Inquiry into the Project Kernel's registries (ADR 0011 decision
// 5): `modules/projects` aggregates through these contracts and never
// queries `inquiry_threads`/`inquiry_signal_candidates` directly.

/**
 * Inquiry is an entity every Project can hold, not a way of advancing work.
 *
 * It used to register a Primary Mode projection. Asking is how research
 * starts, so `research` absorbed that Mode; a Thread is still a first-class
 * object with its own Area, and pending Candidates still reach the shell
 * through the attention adapter below.
 */
const inquiryEntitySummaryAdapter: ProjectEntitySummaryAdapter = {
  entityType: "inquiry_thread",
  label: "Inquiry Threads",
  detail: "Open questions and hypotheses",
  href: (projectId) => `/projects/${projectId}/inquiry`,

  async getSummary(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectEntitySummary> {
    const active = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM inquiry_threads WHERE space_id = $1 AND project_id = $2 AND lifecycle_status = 'active'`,
      [identity.spaceId, projectId],
    );
    const blocked = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM inquiry_threads WHERE space_id = $1 AND project_id = $2 AND attention_state = 'blocked'`,
      [identity.spaceId, projectId],
    );
    const pendingCandidates = await db.query<{ id: string }>(
      `SELECT id FROM inquiry_signal_candidates WHERE space_id = $1 AND project_id = $2 AND status = 'pending'`,
      [identity.spaceId, projectId],
    );
    const pendingTotal = (await readableCandidateIds(
      db,
      identity,
      projectId,
      pendingCandidates.rows.map((candidate) => candidate.id),
    )).size;
    const status: ProjectEntitySummary["status"] = (blocked.rows[0]?.total ?? 0) > 0
      ? "blocked"
      : pendingTotal > 0
        ? "attention"
        : "ok";
    return { count: active.rows[0]?.total ?? 0, status };
  },
};

const inquiryAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "inquiry",
  async listAttentionItems(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAttentionItem[]> {
    const candidates = await db.query<{ id: string; thread_id: string; candidate_kind: string; title: string; summary: string | null }>(
      `SELECT id, thread_id, candidate_kind, title, summary FROM inquiry_signal_candidates
        WHERE space_id = $1 AND project_id = $2 AND status = 'pending'
        ORDER BY created_at ASC`,
      [identity.spaceId, projectId],
    );
    const readable = await readableCandidateIds(db, identity, projectId, candidates.rows.map((candidate) => candidate.id));
    return candidates.rows.filter((candidate) => readable.has(candidate.id)).map((c): ProjectAttentionItem => ({
      id: `inquiry_candidate:${c.id}`,
      project_id: projectId,
      area_kind: "inquiry",
      source_type: "inquiry_candidate",
      source_id: c.id,
      severity: c.candidate_kind === "contradiction" ? "high" : "normal",
      title: c.title,
      summary: c.summary,
      reason: `${c.candidate_kind.replace(/_/g, " ")} needs review`,
      due_at: null,
      blocking_refs: [],
      action_descriptors: [{ label: "Review", href: `/projects/${projectId}/inquiry?candidate=${c.id}` }],
      href: `/projects/${projectId}/inquiry?candidate=${c.id}`,
    }));
  },
};

// Both registries upsert by key, so calling this repeatedly (module init,
// or a test that resets a registry between cases) is always safe — see the
// See `registerBuiltInAttentionAdapters` for why a "registered
// once" guard flag is the wrong pattern here.
export function registerInquiryProjectIntegration(): void {
  projectEntitySummaryRegistry.register(inquiryEntitySummaryAdapter, "inquiry");
  projectAttentionRegistry.replace(inquiryAttentionAdapter);
}
