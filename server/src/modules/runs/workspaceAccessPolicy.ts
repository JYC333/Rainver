/** Shared admission/execution check. A remote Host must attest the mechanism, independent of vendor/persona. */
export function readOnlyWorkspaceHostRefusal(access: 'read' | 'write', _runtimeKey: string | null | undefined, hostKind: string | null | undefined, capabilities?: unknown): string | null {
  if (access !== 'read' || hostKind === 'server') return null;
  const capability = (capabilities as {
    workspace_read_only?: {
      supported?: unknown;
      mechanism?: unknown;
    };
  } | null)?.workspace_read_only;
  if (capability?.supported === true && capability.mechanism === 'bwrap-v1') return null;
  return 'This Host has not reported enforceable read-only workspace support. Update both server and personal Linux x64/arm64 Host, install bubblewrap and enable its unprivileged mount/PID namespace and seccomp support, then reconnect. Do not retry as writable or move workspace files automatically.';
}
