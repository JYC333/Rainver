import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";
import { ProjectCorpusRepository } from "../projects/corpusRepository.js";
import { contentReadSql } from "../access/contentAccessSql.js";

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

/** What each recommended next step is called where a person reads it. */
const FOCUS_LABELS: Record<string, string> = {
  clarify_or_decompose: "Split this question into sub-questions",
  search_acquisition: "Search for evidence",
  design_run_experiment: "Design an experiment",
  read_evidence: "Read the evidence gathered",
  synthesize: "Synthesize what the evidence says",
  promote_knowledge: "Promote this into Knowledge",
};

/**
 * The next step the system worked out, where the person will see it.
 *
 * Advice is generated the moment a search finishes and written to
 * `inquiry_thread_advice` — good advice, with its reasoning. It rendered in
 * exactly one place: the Inquiry Area's stage workspace, for the one Thread
 * you had selected. So a finished four-hour search ended with the Project
 * front page saying nothing about what to do next, and the Room's Agent
 * inventing a question of its own because it could not read this either.
 *
 * Stale advice (the Thread changed under it) is left out rather than shown
 * with a caveat: a recommendation about a question that no longer reads that
 * way is not a next step.
 */
async function nextStepAdviceItems(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
): Promise<ProjectAttentionItem[]> {
  const rows = await db.query<{
    thread_id: string; statement: string; recommended_focus_kind: string; rationale: string;
  }>(
    `SELECT advice.thread_id, thread.statement, advice.recommended_focus_kind, advice.rationale
       FROM inquiry_thread_advice advice
       JOIN inquiry_threads thread
         ON thread.object_id = advice.thread_id AND thread.space_id = advice.space_id
       JOIN space_objects object
         ON object.id = thread.object_id AND object.space_id = thread.space_id
      WHERE advice.space_id = $1 AND advice.project_id = $2
        AND advice.status = 'open'
        AND advice.thread_version >= thread.version
        AND thread.lifecycle_status = 'active'
        AND ${contentReadSql("space_object", "object", "$3")}
      ORDER BY advice.updated_at DESC
      LIMIT 10`,
    [identity.spaceId, projectId, identity.userId],
  );
  return rows.rows.map((row): ProjectAttentionItem => ({
    id: `inquiry_advice:${row.thread_id}`,
    attention_class: "next_step",
    project_id: projectId,
    area_kind: "inquiry",
    source_type: "inquiry_advice",
    source_id: row.thread_id,
    severity: "normal",
    title: `${FOCUS_LABELS[row.recommended_focus_kind] ?? row.recommended_focus_kind.replace(/_/g, " ")}: ${row.statement}`,
    summary: row.rationale,
    reason: "suggested next step",
    due_at: null,
    blocking_refs: [],
    action_descriptors: [{ label: "Open", href: `/projects/${projectId}/inquiry?thread=${row.thread_id}` }],
    href: `/projects/${projectId}/inquiry?thread=${row.thread_id}`,
  }));
}

const inquiryAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "inquiry",
  async listAttentionItems(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAttentionItem[]> {
    const candidates = await db.query<{ id: string; thread_id: string; candidate_kind: string; title: string; summary: string | null }>(
      `SELECT id, thread_id, candidate_kind, title, summary FROM inquiry_signal_candidates
        WHERE space_id = $1 AND project_id = $2 AND status = 'pending'
        ORDER BY created_at ASC`,
      [identity.spaceId, projectId],
    );
    const [readable, advice] = await Promise.all([
      readableCandidateIds(db, identity, projectId, candidates.rows.map((candidate) => candidate.id)),
      nextStepAdviceItems(db, identity, projectId),
    ]);
    return [...advice, ...candidates.rows.filter((candidate) => readable.has(candidate.id)).map((c): ProjectAttentionItem => ({
      id: `inquiry_candidate:${c.id}`,
      attention_class: "gate",
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
    }))];
  },
};

// Both registries upsert by key, so calling this repeatedly (module init,
// or a test that resets a registry between cases) is always safe — see the
// See `registerBuiltInAttentionAdapters` for why a "registered
// once" guard flag is the wrong pattern here.
export function registerInquiryProjectIntegration(): void {
  projectAttentionRegistry.replace(inquiryAttentionAdapter);
}
