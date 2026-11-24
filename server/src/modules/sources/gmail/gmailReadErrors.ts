/** The fixed-code refusal every Gmail mail-read step throws. */
export type GmailReadErrorCode =
  | "gmail_not_found" | "gmail_connection_changed" | "gmail_connection_inactive" | "gmail_selection_changed"
  | "gmail_cursor_invalid" | "gmail_cursor_expired" | "gmail_query_invalid" | "gmail_not_configured"
  | "gmail_reauth_required" | "gmail_refresh_unavailable" | "gmail_quota_exhausted" | "gmail_rate_limited"
  | "gmail_thread_unavailable" | "gmail_upstream_error" | "gmail_upstream_timeout" | "gmail_cancelled"
  | "gmail_audit_unavailable" | "gmail_authority_busy" | "gmail_agent_read_unavailable" | "gmail_delegation_unavailable" | "gmail_digest_unavailable"
  | "gmail_digest_audience_outside_project" | "gmail_digest_audience_not_owner" | "gmail_digest_rule_changed"
  | "gmail_digest_model_fallback"
  | "gmail_digest_runtime_changed" | "gmail_digest_agent_not_in_project";

export type GmailReadStage = "admission" | "list_first_page" | "list_next_page" | "fetch_message";

interface GmailReadDiagnostic {
  stage?: GmailReadStage;
  cause?: "authority_check_failed" | "network_failed" | "request_refused" | "broker_failed"
    | "upstream_http" | "invalid_json" | "response_too_large" | "repeated_page_token";
  upstream_status?: number;
  upstream_reason?: string;
}

/** A refused Gmail read with allowlisted diagnostics safe for the Run log. */
export class GmailReadError extends Error {
  constructor(
    readonly status: 404 | 409 | 422 | 429 | 499 | 502 | 503 | 504,
    readonly code: GmailReadErrorCode,
    readonly retryAt?: string,
    readonly diagnostic: GmailReadDiagnostic = {},
  ) {
    super(code);
    this.name = "GmailReadError";
  }
}

export async function withGmailReadStage<T>(stage: GmailReadStage, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof GmailReadError)) throw error;
    throw new GmailReadError(error.status, error.code, error.retryAt, { ...error.diagnostic, stage });
  }
}
