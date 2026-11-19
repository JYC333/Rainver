/**
 * Withdrawn `gmail_private_read` cards (ADR 0033 §6). The earlier hand-off
 * carried a person's request from a shared conversation into a new private
 * conversation of a Project. It is removed: no Agent tool creates such a card,
 * nothing starts a new conversation for one, and a card is never executed in
 * any compatible form. What stays is history — the owner-only cards, the
 * private conversations they created and their audit rows are kept and read
 * as before (owner-only, `OWNER_ONLY_PROPOSAL_TYPES`).
 *
 * - A still-pending card is shown as no longer decidable
 *   (`projectChatActionPreviews.ts`), and accepting one is refused here and
 *   writes nothing: no consent, no conversation, no Run.
 * - Anyone but the card's owner gets the hidden 404, as before.
 */
import type { GmailPrivateReadProposalPayload } from "@rainver/protocol";
import type { ProposalApplierRegistry } from "../../proposals/applierRegistry.js";
import { hidden, OperationRefusal } from "../../systemActions/operations/errors.js";

export const GMAIL_PRIVATE_READ_PROPOSAL = "gmail_private_read" as const;

/** What a historic card told its owner (shown only to them). */
export function privateReadCardSummary(payload: Pick<GmailPrivateReadProposalPayload, "mailbox_email" | "project_name" | "request_text">): string {
  const request = payload.request_text.length > 280 ? `${payload.request_text.slice(0, 279)}…` : payload.request_text;
  return `Earlier private Gmail check of “${request}” against ${payload.mailbox_email} in ${payload.project_name}.`;
}

export function registerGmailPrivateReadProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register(GMAIL_PRIVATE_READ_PROPOSAL, async ({ proposal, userId }) => {
    if (!proposal.owner_user_id || proposal.owner_user_id !== userId || proposal.visibility !== "private") throw hidden();
    throw new OperationRefusal(409, "gmail", "This Gmail check card is from a hand-off that was withdrawn and can no longer start anything.");
  });
}
