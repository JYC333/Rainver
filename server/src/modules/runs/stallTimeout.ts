/**
 * How long a CLI runtime may say nothing before the Run is given up on.
 *
 * One rule for both execution paths. Do not use a third of the run budget.
 * For the default budget that is 100s, shorter than an ordinary long tool
 * call, and a runtime that is busy inside one emits nothing until it returns. Configured
 * per dispatch through `adapter_config.stall_timeout_seconds`; the default is
 * five minutes, never longer than the run budget itself.
 */
export function stallTimeoutSeconds(
  adapterConfig: Record<string, unknown> | undefined,
  timeoutSeconds: number,
): number {
  const configured = Number(adapterConfig?.stall_timeout_seconds);
  const requested = Number.isFinite(configured) && configured > 0 ? configured : 300;
  return Math.min(requested, Math.max(1, timeoutSeconds - 1));
}
