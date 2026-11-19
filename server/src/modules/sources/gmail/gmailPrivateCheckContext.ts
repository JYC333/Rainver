/**
 * The private Gmail check a Run executes (ADR 0033 §6), read from the Run's
 * immutable contract. Dependency-free so the launch path can ask it.
 */
export function gmailPrivateCheckRunContext(run: { contract_snapshot_json?: unknown }): { check_id: string } | null {
  const value = (run.contract_snapshot_json as { workflow_input_json?: { gmail_private_check?: unknown } } | null)?.workflow_input_json?.gmail_private_check;
  const checkId = value && typeof value === "object" ? (value as Record<string, unknown>).check_id : null;
  return typeof checkId === "string" ? { check_id: checkId } : null;
}
