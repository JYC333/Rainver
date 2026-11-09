import {normalizeHostCapabilities} from '../hosts/capabilities.js';
import {hostIsOnline,type ExecutionHostRow,type ExecutionLocationRow,type RuntimeProfileRow} from './executionContextRepository.js';

export function locationIsOnline(location: Pick<ExecutionLocationRow, "host_kind" | "host_status" | "last_heartbeat_at">): boolean {
  return hostIsOnline({
    kind: location.host_kind,
    status: location.host_status,
    last_heartbeat_at: location.last_heartbeat_at,
  });
}

export function runtimeAvailability(
  profile: RuntimeProfileRow,
  host: ExecutionHostRow | null,
  location: ExecutionLocationRow | null,
  options: { allowStaleLocation?: boolean } = {},
): { usable: boolean; reason: string | null } {
  if (!profile.enabled) return { usable: false, reason: "The runtime profile is disabled" };
  if (!profile.execution_host_id || !profile.workspace_mode || !profile.runtime_installation) {
    return { usable: false, reason: "The runtime is not bound to an execution Host and workspace" };
  }
  if (!host) return { usable: false, reason: "The execution Host is unavailable" };
  // `listHosts(userId)` has already applied Host ownership visibility; this
  // helper only evaluates the current heartbeat/capability state.
  if (!hostIsOnline(host)) return { usable: false, reason: "The execution Host is offline" };
  const installation = hostInstallationAvailability(host, profile.runtime_key, profile.runtime_installation);
  if (!installation.usable) return installation;
  if (profile.workspace_mode === "location") {
    if (!location || location.execution_host_id !== host.id) {
      return { usable: false, reason: "The bound Workspace Location is unavailable" };
    }
    if (location.status !== "active" && !(options.allowStaleLocation && location.status === "stale")) {
      return { usable: false, reason: "The bound Workspace Location is unavailable" };
    }
    if (!location.execution_ready || !locationIsOnline(location)) {
      return { usable: false, reason: "The bound Workspace Location is not ready" };
    }
  }
  return { usable: true, reason: null };
}

export function hostInstallationAvailability(
  host: ExecutionHostRow,
  runtimeKey: string,
  installationId: string | null,
): { usable: boolean; reason: string | null } {
  // The built-in host reports its installations like any other daemon, and a
  // container with nothing installed reports none. Do not waive the check
  // for it. That offers a copy that does not exist and fails at launch.
  const installation = normalizeHostCapabilities(host.capabilities_json).installations[runtimeKey]
    ?.find((candidate) => candidate.id === installationId);
  if (!installation) return { usable: false, reason: "The CLI installation is unavailable on the Host" };
  if (installation.logged_in === false && installation.options?.session_available !== true) {
    return { usable: false, reason: "The CLI installation has no signed-in account or available ACP session" };
  }
  return { usable: true, reason: null };
}
