/**
 * The thread status a quiet runtime records once per Run. Informational: it
 * neither ends the turn nor stops the runtime, and the conversation renders
 * it in the reader's language (`turnProjection.ts`).
 */
export const RUN_QUIET_STATUS = "run_quiet";

/** Legacy configuration name; this now controls an informational notice only. */
export function stallTimeoutSeconds(
  adapterConfig: Record<string, unknown> | undefined,
): number {
  const configured = Number(adapterConfig?.stall_timeout_seconds);
  return Number.isFinite(configured) && configured > 0 ? configured : 300;
}
