import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";
import { readableCandidateIds } from "./signalService.js";

// Registers Inquiry into the Project Kernel's registries (ADR 0011 decision
// 5): `modules/projects` aggregates through these contracts and never
// queries `inquiry_threads`/`inquiry_signal_candidates` directly.

const inquiryAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "inquiry",
  async listAttentionItems(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAttentionItem[]> {
    const candidates = await db.query<{ id: string; thread_id: string; candidate_kind: string; title: string; summary: string | null }>(
      `SELECT id, thread_id, candidate_kind, title, summary FROM inquiry_signal_candidates
        WHERE space_id = $1 AND project_id = $2 AND status = 'pending'
        ORDER BY created_at ASC`,
      [identity.spaceId, projectId],
    );
    const readable=await readableCandidateIds(db,identity,projectId,candidates.rows,'read_content');
    return [...candidates.rows.filter((candidate) => readable.has(candidate.id)).map((c): ProjectAttentionItem => ({
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
