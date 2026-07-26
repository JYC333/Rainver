import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import {
  projectModeProjectionRegistry,
  type ModeOverviewProjection,
  type ProjectModeAreaAdapter,
  type ProjectAreaSummary,
} from "../projects/overviewRegistry";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry";
import { ProjectCorpusRepository } from "../projects/corpusRepository";

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

const inquiryModeAdapter: ProjectModeAreaAdapter = {
  mode: "inquiry",

  async getOverviewProjection(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ModeOverviewProjection> {
    const counts = await db.query<{
      active_threads: number; focused_threads: number; open_questions: number; active_hypotheses: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE lifecycle_status = 'active')::int AS active_threads,
         count(*) FILTER (WHERE attention_state = 'focused')::int AS focused_threads,
         count(*) FILTER (WHERE kind = 'question' AND lifecycle_status = 'active')::int AS open_questions,
         count(*) FILTER (WHERE kind = 'hypothesis' AND lifecycle_status = 'active')::int AS active_hypotheses
       FROM inquiry_threads WHERE space_id = $1 AND project_id = $2`,
      [identity.spaceId, projectId],
    );
    const row = counts.rows[0] ?? { active_threads: 0, focused_threads: 0, open_questions: 0, active_hypotheses: 0 };

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

    const focusSet = await db.query<{ id: string; statement: string }>(
      `SELECT id, statement FROM inquiry_threads
        WHERE space_id = $1 AND project_id = $2 AND attention_state = 'focused'
        ORDER BY updated_at DESC LIMIT 10`,
      [identity.spaceId, projectId],
    );

    return {
      mode: "inquiry",
      current_state_summary: `${row.active_threads} active Thread${row.active_threads === 1 ? "" : "s"} (${row.open_questions} question${row.open_questions === 1 ? "" : "s"}, ${row.active_hypotheses} hypothes${row.active_hypotheses === 1 ? "is" : "es"})`,
      progress_indicators: [
        { metric: "focused_threads", value: row.focused_threads },
        { metric: "pending_candidates", value: pendingTotal },
      ],
      focus_set: focusSet.rows.map((t) => ({ id: t.id, label: t.statement, href: `/projects/${projectId}/inquiry` })),
      next_actions: pendingTotal > 0
        ? [{ id: "review-candidates", label: `Review ${pendingTotal} pending Candidate${pendingTotal === 1 ? "" : "s"}`, href: `/projects/${projectId}/inquiry`, kind: "review" }]
        : [],
    };
  },

  async getAreaSummary(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAreaSummary> {
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
    const status: ProjectAreaSummary["status"] = (blocked.rows[0]?.total ?? 0) > 0
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
  projectModeProjectionRegistry.register(inquiryModeAdapter);
  projectAttentionRegistry.register(inquiryAttentionAdapter);
}
