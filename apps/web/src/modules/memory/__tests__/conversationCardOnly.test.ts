import { expect, it } from 'vitest'
import { decisionOpen, decisionOpenOutsideConversation } from '../acceptOutcome'

// ADR 0033 §6: Gmail check cards are decided only on their card in the conversation; an old hand-off card nowhere.
it('offers no Accept / Reject for Gmail check cards outside their conversation', () => {
  for (const proposal_type of ['gmail_private_check', 'gmail_private_read']) {
    expect(decisionOpen({ status: 'pending', expired: false })).toBe(true)
    expect(decisionOpenOutsideConversation({ status: 'pending', expired: false, proposal_type })).toBe(false)
  }
  expect(decisionOpenOutsideConversation({ status: 'pending', expired: false, proposal_type: 'gmail_digest_create' })).toBe(true)
  expect(decisionOpenOutsideConversation({ status: 'pending', expired: true, proposal_type: 'memory_update' })).toBe(false)
})
