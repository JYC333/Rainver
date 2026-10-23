/** Safe diagnostics: show transport codes, never URLs/headers from a cause. */
export function connectionError(error: unknown): string {
  const codes = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const entry = value as { code?: unknown; cause?: unknown; errors?: unknown[]; name?: string };
    if (typeof entry.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(entry.code)) codes.add(entry.code);
    if (entry.name === "TimeoutError") codes.add("ETIMEDOUT");
    visit(entry.cause);
    if (Array.isArray(entry.errors)) entry.errors.forEach(visit);
  };
  visit(error);
  const has = (...values: string[]) => values.some((v) => codes.has(v));
  const reason = has("EAI_AGAIN", "ENOTFOUND") ? "DNS resolution failed; check this command's network sandbox and DNS access."
    : has("EPERM", "EACCES") ? "Network access was denied by the command's permissions."
    : has("ECONNREFUSED") ? "Connection refused; check the control-plane address and listener."
    : has("ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT") ? "Connection timed out; check routing and control-plane reachability."
    : [...codes].some((c) => /CERT|TLS|SSL/.test(c)) ? "TLS verification failed; check the certificate and trust configuration."
    : "Network request failed; check the command's network permissions and control-plane reachability.";
  return `${codes.size ? `[${[...codes].join(", ")}] ` : ""}${reason} This does not establish that the Host daemon is offline.`;
}
