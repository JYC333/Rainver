/**
 * How long a CLI runtime may say nothing before the Run is given up on.
 *
 * One rule for both execution paths. The server-host path has had it all
 * along; the remote path used a third of the run budget instead, which for
 * the default budget was 100s — shorter than an ordinary long tool call, and
 * a runtime that is busy inside one emits nothing until it returns. Configured
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
