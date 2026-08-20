import type { Queryable } from "./repository";
import { registerInquiryThreadContinuation } from "../inquiry/inquiryThreadProposalApplier";
import { registerProjectDefinitionContinuation } from "../projects/projectDefinitionProposalApplier";
import { registerAgentDelegationContinuation } from "../agentGroups/delegationContinuation";
import { registerResearchAcquisitionContinuation } from "../projectResearch/researchAcquisitionContinuation";

/**
 * The Proposal fields a continuation handler needs — a narrow read view of
 * the row `rooms/service.ts` already loads, kept independent of that
 * module's own row type so this registry has no reverse dependency on Rooms.
 */
export interface ContinuationProposal {
  id: string;
  space_id: string;
  project_id: string | null;
  proposal_type: string;
  status: "accepted" | "rejected";
  proposed_title: string;
  payload_json: unknown;
  created_by_run_id: string | null;
}

export interface ProposalContinuation {
  /**
   * A short machine-readable tag describing what kind of continuation this
   * is, for a future consumer (frontend, another domain) to key off of.
   * This never forces a specific tool call — see the accepted
   * `inquiry_thread_create` registration below, whose directive names an
   * activity, not an action id, because more than one tool can satisfy it.
   */
  directive: string | null;
  /** Neutral instruction text for the hidden system continuation message. */
  instruction: string;
  /** Structured context alongside the directive, stored in metadata_json. */
  context?: Record<string, unknown>;
}

export type ProposalContinuationHandler = (input: {
  db: Queryable;
  proposal: ContinuationProposal;
}) => Promise<ProposalContinuation> | ProposalContinuation;

/**
 * A domain-completion event (plan Phase 3) — the registry's second trigger
 * source alongside a resolved Proposal. `kind` selects the registered
 * handler; `key` is the idempotency key the caller uses to dedupe repeated
 * reconciliation of the same completion (e.g. a delegation id, an
 * operation id) — the registry itself does not dedupe; the Room dispatch
 * layer does, the same way it already dedupes Proposal continuations.
 */
export interface DomainCompletionEvent {
  kind: string;
  key: string;
  space_id: string;
  project_id: string | null;
  payload: Record<string, unknown>;
}

export type EventContinuationHandler = (input: {
  db: Queryable;
  event: DomainCompletionEvent;
}) => Promise<ProposalContinuation> | ProposalContinuation;

/**
 * Maps a resolved (accepted/rejected) Proposal, or a domain-completion
 * event, to what a Room should tell the continuation run to do next — the
 * typed replacement for the per-`proposal_type` prose that used to be
 * hardcoded in `rooms/service.ts` (plan:
 * `.agent/plans/room-advancement-reliability-plan.md`, Phases 2 and 3).
 * Rooms consumes this registry and holds no domain knowledge of its own;
 * each domain registers its own handler here, mirroring how
 * `ProposalApplierRegistry` lets domains own their apply logic.
 */
export class ConversationContinuationRegistry {
  private readonly handlers = new Map<string, ProposalContinuationHandler>();
  private readonly eventHandlers = new Map<string, EventContinuationHandler>();

  register(proposalType: string, handler: ProposalContinuationHandler): void {
    if (!proposalType) throw new Error("proposalType must be non-empty");
    if (this.handlers.has(proposalType)) {
      throw new Error(`a continuation handler is already registered for proposal type ${proposalType}`);
    }
    this.handlers.set(proposalType, handler);
  }

  registerEvent(eventKind: string, handler: EventContinuationHandler): void {
    if (!eventKind) throw new Error("eventKind must be non-empty");
    if (this.eventHandlers.has(eventKind)) {
      throw new Error(`a continuation handler is already registered for event kind ${eventKind}`);
    }
    this.eventHandlers.set(eventKind, handler);
  }

  async resolve(db: Queryable, proposal: ContinuationProposal): Promise<ProposalContinuation> {
    if (proposal.status === "rejected") {
      return { directive: null, instruction: rejectedInstruction(proposal.proposed_title) };
    }
    const handler = this.handlers.get(proposal.proposal_type);
    if (!handler) return { directive: null, instruction: genericAcceptedInstruction(proposal.proposed_title) };
    return handler({ db, proposal });
  }

  /** Unlike `resolve`, an unregistered event kind is a wiring bug, not a
   * legitimate case needing a generic fallback — every event a call site
   * fires must have a registered handler. */
  async resolveEvent(db: Queryable, event: DomainCompletionEvent): Promise<ProposalContinuation> {
    const handler = this.eventHandlers.get(event.kind);
    if (!handler) throw new Error(`no continuation handler is registered for event kind ${event.kind}`);
    return handler({ db, event });
  }
}

export function createDefaultConversationContinuationRegistry(): ConversationContinuationRegistry {
  const registry = new ConversationContinuationRegistry();
  registerInquiryThreadContinuation(registry);
  registerProjectDefinitionContinuation(registry);
  registerAgentDelegationContinuation(registry);
  registerResearchAcquisitionContinuation(registry);
  return registry;
}

export function isChineseTitle(title: string): boolean {
  return /[㐀-鿿]/u.test(title);
}

function rejectedInstruction(title: string): string {
  const chinese = isChineseTitle(title || "the proposal");
  return chinese
    ? "用户已拒绝上一项方案。请根据当前对话修改方案；如果缺少关键信息，只问一个明确的问题。"
    : "The user rejected the preceding proposal. Revise it from the current conversation, asking at most one focused question if essential information is missing.";
}

function genericAcceptedInstruction(title: string): string {
  const chinese = isChineseTitle(title || "the proposal");
  return chinese
    ? "用户已确认上一项方案。先用一句话确认刚刚完成了什么，再直接开始下一步。"
    : "The user accepted the preceding proposal. Confirm what was completed in one sentence, then begin the next step.";
}
