import type { ProposalAcceptOut } from '../../types/api'

/**
 * Whether a Proposal still offers Accept / Reject: pending and not past its expiry. An expired
 * Proposal stays `pending` (expiry is derived), but no new decision can apply or reject it, so every
 * decision entry (Room card, detail, list, Today) withholds both buttons.
 */
export function decisionOpen(p: { status: string; expired?: boolean | null }): boolean {
  return p.status === 'pending' && !p.expired
}

/**
 * Gmail check cards (ADR 0033 §6) are decided only on their owner-only card under the original
 * message in the conversation; a withdrawn hand-off card (`gmail_private_read`) is history and is
 * decided nowhere. Proposal lists and details show them without Accept / Reject.
 */
export const CONVERSATION_CARD_ONLY_PROPOSAL_TYPES: ReadonlySet<string> = new Set(['gmail_private_check', 'gmail_private_read'])

/** `decisionOpen` for a decision entry outside the conversation (Proposal list and detail). */
export function decisionOpenOutsideConversation(p: { status: string; expired?: boolean | null; proposal_type: string }): boolean {
  return decisionOpen(p) && !CONVERSATION_CARD_ONLY_PROPOSAL_TYPES.has(p.proposal_type)
}

/**
 * An accept can be a decision that applied nothing: a stale approval commits the
 * Proposal as superseded, an expired one leaves it unapplied. Both return HTTP 200
 * with `operation_failure` (also on same-key replay) and must not read as accepted.
 * Returns the i18n key to show as an error, or null when the accept applied.
 */
export function acceptRefusalKey(out: ProposalAcceptOut): string | null {
  if (out.result_type !== 'operation_failure') return null
  const code = (out.result as { error?: { code?: unknown } } | undefined)?.error?.code
  if (code === 'operation_approval_superseded') return 'mixed_surfaces.proposal_accept_superseded'
  if (code === 'operation_approval_expired') return 'mixed_surfaces.proposal_accept_expired'
  return 'mixed_surfaces.proposal_accept_failed'
}
