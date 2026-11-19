/** The fixed-code refusal every Gmail mail-read step throws. */
export type GmailReadErrorCode =
  | "gmail_not_found" | "gmail_connection_changed" | "gmail_connection_inactive" | "gmail_selection_changed"
  | "gmail_cursor_invalid" | "gmail_cursor_expired" | "gmail_query_invalid" | "gmail_not_configured"
  | "gmail_reauth_required" | "gmail_refresh_unavailable" | "gmail_quota_exhausted" | "gmail_rate_limited"
  | "gmail_thread_unavailable" | "gmail_upstream_error" | "gmail_upstream_timeout" | "gmail_cancelled"
  | "gmail_audit_unavailable" | "gmail_authority_busy" | "gmail_agent_read_unavailable" | "gmail_digest_unavailable"
  | "gmail_digest_audience_outside_project";

/** A refused Gmail read: a fixed code only, never a query, Google id, header, body or upstream message. */
export class GmailReadError extends Error {
  constructor(readonly status: 404 | 409 | 422 | 429 | 499 | 502 | 503 | 504, readonly code: GmailReadErrorCode, readonly retryAt?: string) {
    super(code);
    this.name = "GmailReadError";
  }
}
