/**
 * Accepting a packet of things learned from imported CLI history.
 *
 * Accepting creates one `memory_create` proposal per candidate and writes no
 * memory itself (ADR 0003): the packet exists so one import produces one item
 * on the Project's attention list instead of a dozen, and the real review
 * still happens per memory.
 *
 * The memories land in the project layer, which is the team-shared layer that
 * already exists and is already ACL-gated (ADR 0013 decision 19) — imported
 * history is about how this Project's work is done, not about a person.
 */

import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import { acceptReviewPacket, type ChildProposalDraft } from "../proposals/reviewPackets.js";
import { HttpError } from "../routeUtils/common.js";
import { IMPORTED_HISTORY_PACKET_PROPOSAL_TYPE } from "./extraction.js";

interface Candidate {
  text: string;
  source_record_ids: string[];
  source_session_ids: string[];
}

export function registerImportedHistoryProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register(
    IMPORTED_HISTORY_PACKET_PROPOSAL_TYPE,
    async (context: ProposalApplyContext): Promise<ProposalApplyResult> =>
      acceptReviewPacket(context, {
        expectedOperation: IMPORTED_HISTORY_PACKET_PROPOSAL_TYPE,
        resultType: "imported_history_memory_packet",
        privateMessage: "Only the person who ran this extraction can accept its packet",
        invalidPayload: () => new HttpError(422, "This is not an imported-history memory packet"),
        build: (payload) => {
          const projectId = typeof payload.project_id === "string" ? payload.project_id : null;
          if (!projectId) throw new HttpError(422, "The packet is missing the Project its memories belong to");
          const candidates = Array.isArray(payload.candidates) ? (payload.candidates as Candidate[]) : [];
          const children: ChildProposalDraft[] = candidates
            .filter((candidate) => typeof candidate?.text === "string" && candidate.text.trim().length > 0)
            .map((candidate) => ({
              proposalType: "memory_create",
              title: candidate.text.slice(0, 120),
              payload: {
                operation: "create",
                proposed_content: candidate.text,
                memory_type: "project",
                // Project memory is the shared layer by definition: the apply
                // path rejects a project memory that is not space_shared, and
                // rightly — a private one would be a user memory wearing a
                // Project's name.
                target_scope: "project",
                target_namespace: `project.${projectId}`,
                target_visibility: "space_shared",
                project_id: projectId,
                provenance_entries: (candidate.source_session_ids ?? []).map((id) => ({
                  source_type: "imported_session",
                  source_id: id,
                  source_trust: "user_confirmed",
                })),
                source_refs_metadata: {
                  imported_session_record_ids: candidate.source_record_ids ?? [],
                  extraction_checkpoint_id: payload.checkpoint_id ?? null,
                },
              },
              rationale: "Extracted from imported CLI history and accepted into review by the Project.",
              visibility: "space_shared",
              riskLevel: "low",
              projectId,
            }));
          return { children };
        },
      }),
  );
}
