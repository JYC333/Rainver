/** Browser event used to refresh review indicators after any review decision. */
export const REVIEW_ATTENTION_CHANGED_EVENT = 'rainver:review-attention-changed'

export function notifyReviewAttentionChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(REVIEW_ATTENTION_CHANGED_EVENT))
  }
}
