import { isAcpAuthRequiredError, type RuntimeFailureEvidence } from "@rainver/protocol";
import { redactEvidenceText } from "../runs/evidenceRedaction.js";
import { classifyRuntimeFailure } from "../runs/retryPolicy.js";
import { runtimeQuotaResetAt, validQuotaResetAt } from "./quotaReset.js";

/** Safe, bounded failure evidence; never persist the vendor's raw error.data. */
export type AcpRuntimeFailure = RuntimeFailureEvidence;

const HUMAN_FIELDS = ["message", "details", "detail", "error", "additionalDetails", "additional_details"];
const CODEX_CATEGORIES: Record<string, AcpRuntimeFailure["category"]> = {
  usageLimitExceeded: "quota", usage_limit_reached: "quota",
  unauthorized: "auth", rateLimitExceeded: "rate_limit",
  serverOverloaded: "transient", internalServerError: "transient",
  httpConnectionFailed: "transient", responseStreamConnectionFailed: "transient",
  responseStreamDisconnected: "transient", responseTooManyFailedAttempts: "transient",
  badRequest: "configuration", contextWindowExceeded: "configuration", sessionBudgetExceeded: "configuration",
};
const CLAUDE_CATEGORIES: Record<string, AcpRuntimeFailure["category"]> = {
  // Typed startup reasons from current Claude ACP; numeric RPC codes alone
  // never establish authentication failure.
  gateway_signin_required: "auth", org_pin_mismatch: "auth", org_config_refused: "auth",
  cwd_unavailable: "configuration", proxy_invalid: "configuration",
  // Native SDK errorKind values.
  authentication_failed: "auth", oauth_org_not_allowed: "auth",
  billing_error: "quota", rate_limit: "rate_limit", overloaded: "transient", server_error: "transient",
  transport_lost: "transient", invalid_request: "configuration", model_not_found: "configuration", max_output_tokens: "configuration",
  // API error objects may also appear inside human diagnostic fields.
  authentication_error: "auth", rate_limit_error: "rate_limit",
  overloaded_error: "transient", api_error: "transient",
  invalid_request_error: "configuration", not_found_error: "configuration", permission_error: "configuration",
};

export function normalizeAcpFailure(runtimeKey: string, value: unknown, now = new Date()): AcpRuntimeFailure {
  const error = record(value);
  const messages: string[] = [];
  const codes: string[] = [];
  const statuses: number[] = [];
  const resets: unknown[] = [];
  let remaining = 64;
  // Follow only known diagnostic fields, not arbitrary metadata or secrets.
  function visit(value: unknown, depth = 0): void {
    if (depth > 5 || --remaining < 0) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      if (text.startsWith("{")) {
        // JSON diagnostics still use the field allowlist. A truncated or
        // malformed payload must not become an arbitrary raw metadata dump.
        if (text.length > 64_000) return;
        try { visit(JSON.parse(text), depth + 1); } catch { /* unknown diagnostic */ }
        return;
      }
      // Let the canonical redactor own the length boundary and overscan so
      // a secret straddling the cap cannot survive as an unrecognized prefix.
      const safe = redactEvidenceText(text)!;
      if (!messages.includes(safe)) messages.push(safe);
      return;
    }
    const obj = record(value);
    for (const key of ["codexErrorInfo", "errorKind", "startupFailureReason", "code", "type"]) {
      const code = obj[key];
      if (typeof code === "string" && /^[A-Za-z_][\w.-]{0,95}$/.test(code)) codes.push(code);
      else if (key === "codexErrorInfo" && code && typeof code === "object") {
        for (const [name, detail] of Object.entries(record(code)).slice(0, 8)) {
          if (Object.hasOwn(CODEX_CATEGORIES, name)) codes.push(name);
          visit(detail, depth + 1);
        }
      }
    }
    for (const key of ["httpStatusCode", "status_code", "status"]) {
      if (typeof obj[key] === "number") statuses.push(obj[key] as number);
    }
    for (const key of ["resets_at", "reset_at", "resetsAt"]) {
      if (obj[key] !== undefined) resets.push(obj[key]);
    }
    for (const key of HUMAN_FIELDS) if (obj[key] !== undefined) visit(obj[key], depth + 1);
  }
  visit(error.message);
  visit(error.data);
  const message = redactEvidenceText(messages.join(": ") || "unknown protocol error")!;
  const categories = runtimeKey === "codex_cli" ? CODEX_CATEGORIES : runtimeKey === "claude_code" ? CLAUDE_CATEGORIES : {};
  const vendorCode = codes.find(code => Object.hasOwn(categories, code)) ?? codes[0] ?? null;
  const rpcCode = typeof error.code === "number" && Number.isInteger(error.code) ? error.code : null;
  const knownRuntime = runtimeKey === "codex_cli" || runtimeKey === "claude_code";
  const typed = vendorCode && Object.hasOwn(categories, vendorCode) ? categories[vendorCode] : undefined;
  const explicitAuth = isAcpAuthRequiredError(error);
  const auth = explicitAuth || statuses.includes(401)
    || (knownRuntime && /failed to authenticate|authentication required|invalid (?:api key|authentication credentials)|please (?:run )?\/?login|oauth (?:access )?token (?:has been |is )?(?:revoked|expired)|refresh token (?:is |has been )?(?:invalid|revoked)/i.test(message));
  const quota = classifyRuntimeFailure(runtimeKey, message, { providerBound: false }) !== null;
  const category = explicitAuth || statuses.includes(401) ? "auth"
    : typed === "quota" || quota ? "quota"
    : typed === "auth" || (!typed && auth) ? "auth"
    : statuses.includes(429) ? "rate_limit"
    : typed ?? (statuses.some(status => status >= 500 && status <= 599) ? "transient" : "unknown");
  return {
    rpc_code: rpcCode, vendor_code: redactEvidenceText(vendorCode), category, message, occurred_at: now.toISOString(),
    resets_at: category === "quota"
      ? resets.map(value => validQuotaResetAt(value, now)).find(value => value !== null)
        ?? runtimeQuotaResetAt(runtimeKey, message, now)
      : null,
  };
}

/** Complete a vendor-local clock only with the executing Host's timezone. */
export function withAcpFailureTimezone(runtimeKey: string, failure: AcpRuntimeFailure, timeZone?: string): AcpRuntimeFailure {
  if (failure.category !== "quota" || failure.resets_at || !timeZone) return failure;
  return { ...failure, resets_at: runtimeQuotaResetAt(runtimeKey, failure.message, new Date(failure.occurred_at), timeZone) };
}

export function acpFailureRunCode(failure: AcpRuntimeFailure | undefined, providerBound: boolean): string | null {
  if (!failure) return null;
  switch (failure.category) {
    case "quota": return providerBound ? null : "subscription_quota_exhausted";
    case "auth": return "runtime_auth_required";
    case "rate_limit": return "provider_rate_limit";
    case "transient": return "adapter_runtime_error";
    default: return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
