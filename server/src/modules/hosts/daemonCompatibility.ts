/**
 * The oldest `rainver-host` this control plane speaks to.
 *
 * The host wire renamed `adapter_type` to `runtime_key` in the 2026-09-21 ACP
 * runtime-authority epoch. A daemon built before that rename reads
 * `frame.runtime_key` as `undefined` and falls back to the raw argv command,
 * so every Run dispatched to it fails for a reason that names neither the
 * daemon nor the rename. A paired machine must update before it can execute
 * again; refusing its `hello` says that once, instead of once per Run.
 *
 * Raise this in the same change that makes the daemon's answer to a frame
 * depend on a field an older daemon does not read, and bump the daemon's own
 * `package.json` version with it.
 */
export const MIN_HOST_DAEMON_VERSION = "0.2.0";

const RELEASE_TRIPLE = /^(\d+)\.(\d+)\.(\d+)/;

function releaseTriple(reported: string | null | undefined): [number, number, number] | null {
  const match = reported?.trim().match(RELEASE_TRIPLE);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether a reported daemon version is at or above the floor.
 *
 * `daemonVersion()` reports `X.Y.Z` with an optional `+<build id>` suffix, and
 * the literal `"unknown"` when its own package metadata is unreadable. Only
 * the release triple is compared — the build id distinguishes two builds of
 * one release, not two releases — and anything with no triple is treated as
 * below the floor: a daemon that cannot name its version cannot be taken to
 * speak the current wire.
 */
export function hostDaemonMeetsMinimumVersion(reported: string | null | undefined): boolean {
  const version = releaseTriple(reported);
  const floor = releaseTriple(MIN_HOST_DAEMON_VERSION);
  if (!version || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== floor[index]) return version[index] > floor[index];
  }
  return true;
}
