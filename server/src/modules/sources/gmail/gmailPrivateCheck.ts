/**
 * Withdrawn `gmail_private_check` cards (ADR 0033 §6).
 *
 * The in-place private check answered a Room or mainline request in a
 * separate, Session-less, isolated Run whose answer appeared only on its
 * owner's card. It is removed: Gmail is now read in the conversation itself,
 * on its own selected runtime, under the owner's standing Project consent
 * (`gmailAgentReadOperation.ts`). No Agent tool creates such a card any more,
 * nothing starts its Run, and a Run it started is refused before dispatch and
 * at launch (`runs/repository.ts`, `runs/sensitiveRuntimeProfile.ts`).
 *
 * What stays is history: the owner-only cards (`OWNER_ONLY_PROPOSAL_TYPES`)
 * and the `gmail_private_checks` rows. Migration
 * `0039_gmail_private_check_withdrawn` closed every card still pending and
 * every check not yet finished. Accepting a card is refused here and writes
 * nothing — no consent, no Run; anyone but its owner gets the hidden 404.
 * A delivered answer is not shown again.
 */
import type { GmailPrivateCheckProposalPayload } from "@rainver/protocol";
import type { ProposalApplierRegistry } from "../../proposals/applierRegistry.js";
import { hidden, OperationRefusal } from "../../systemActions/operations/errors.js";

/** The withdrawn Agent tool's id: never offered, still reduced in event logs (`privateToolCalls.ts`). */
export const GMAIL_PRIVATE_CHECK_TOOL = "source.gmail.private_check.request" as const;
export const GMAIL_PRIVATE_CHECK_PROPOSAL = "gmail_private_check" as const;

/** What a historic card tells its owner (shown only to them). */
export function privateCheckCardSummary(payload: Pick<GmailPrivateCheckProposalPayload, "mailbox_email" | "project_name">): string {
  return `Earlier private Gmail check against ${payload.mailbox_email} in ${payload.project_name}. Gmail is now read in the conversation itself; ask there again.`;
}

export function registerGmailPrivateCheckProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register(GMAIL_PRIVATE_CHECK_PROPOSAL, async ({ proposal, userId }) => {
    if (!proposal.owner_user_id || proposal.owner_user_id !== userId || proposal.visibility !== "private") throw hidden();
    throw new OperationRefusal(409, "gmail", "This private Gmail check card was withdrawn and can no longer start anything. Ask in the conversation instead.");
  });
}
