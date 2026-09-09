import type { HostHelloInfo, RuntimeProbe } from "@rainver/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { detectCapabilities, type AskRuntimeOptions } from "./capabilities.js";
import { ambientSessionCounts } from "./ambientCounts.js";
import { probeAcpOptions } from "./acpProbe.js";
import { adapterIsBeingReplaced, holdingAdapter, resolveAcpLaunch, substituteCwd } from "./execution.js";
import { collectWorkspaceStatus } from "./workspaceStatus.js";
import { listManagedWorkspaces } from "./managedWorkspaces.js";
import { daemonVersion } from "./version.js";
import { ensurePackagedAdapter } from "./adapterInstallation.js";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the control plane at ${url}: ${cause}`);
  }
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? String((body as { detail: unknown }).detail) : response.statusText;
    throw new ApiError(response.status, detail);
  }
  return body as T;
}

/**
 * Everything the control plane knows about one runtime adapter, as sent in
 * `hello_ack.runtime_probes`. The daemon holds no copy of this: a runtime
 * the server can dispatch to is one it can look for, ask, install, and log
 * into. The shape is the wire contract's.
 */
export type { RuntimeProbe } from "@rainver/protocol";

/**
 * Asks one copy of a runtime what it can be set to, over ACP, launched
 * exactly as a job for it would be.
 */
/** Last failure reason logged per copy, so a probe that keeps failing the same way is logged once, not every minute. */
const reportedProbeFailures = new Map<string, string>();

function askRuntimeOptions(probes: RuntimeProbe[], log?: (line: string) => void): AskRuntimeOptions {
  return async (lookup, installation) => {
    const probe = probes.find((candidate) => candidate.adapter_type === lookup.adapter_type);
    if (!probe) return null;
    // A heartbeat probe launches the copy, so it must not run against a
    // directory being renamed away. Returning null leaves the previous answer
    // in the cache rather than caching a failure for this copy.
    if (adapterIsBeingReplaced(lookup.adapter_type)) return null;
    const key = `${lookup.adapter_type}@${installation}`;
    const failed = (reason: string) => {
      if (reportedProbeFailures.get(key) === reason) return;
      reportedProbeFailures.set(key, reason);
      log?.(`${key}: could not read its login methods and options — ${reason}`);
    };
    const cwd = await mkdtemp(join(tmpdir(), "rainver-acp-probe-"));
    try {
      const [rawCommand, ...args] = probe.argv.map((arg) => substituteCwd(arg, cwd));
      const launch = resolveAcpLaunch(rawCommand!, args, installation, probe.adapter_type);
      // Held for the probe's duration, so a replacement waits for it rather
      // than deleting the tree it is executing from.
      const options = await holdingAdapter(
        lookup.adapter_type,
        () => probeAcpOptions(launch.command, launch.args, launch.env, cwd, undefined, failed),
      );
      if (options !== null && reportedProbeFailures.delete(key)) log?.(`${key}: login methods and options read successfully`);
      return options;
    } catch (error) {
      failed(`launch could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}

/**
 * `probes` is what the server said in `hello_ack`; before that (the first
 * hello, registration) no runtime is looked for or asked, so the report
 * names only `git`.
 */
async function helloInfo(
  workspaces: Record<string, string> = {},
  serverUrl?: string,
  probes?: RuntimeProbe[],
  log?: (line: string) => void,
): Promise<HostHelloInfo> {
  const capabilities = await detectCapabilities(
    probes ? askRuntimeOptions(probes, log) : undefined,
    probes ?? [],
    async (lookup) => {
      const command = probes?.find(candidate => candidate.adapter_type === lookup.adapter_type)?.argv[0];
      return command ? ensurePackagedAdapter(command) : true;
    },
  );
  const currentPlatform = platform();
  const environment_kind = currentPlatform === "win32"
    ? "windows_native"
    : currentPlatform === "darwin" ? "macos_native" : "linux_native";
  return {
    platform: currentPlatform,
    arch: arch(),
    daemon_version: daemonVersion(),
    environment_kind,
    capabilities_json: { ...capabilities },
    workspace_reports: await collectWorkspaceStatus(workspaces),
    managed_workspaces: await listManagedWorkspaces(),
    ambient_sessions: ambientSessionCounts(),
    ...(serverUrl ? { server_url: serverUrl } : {}),
  };
}

export interface RegisterResult {
  host_id: string;
  token: string;
  name: string;
}

export async function registerHost(serverUrl: string, pairingCode: string): Promise<RegisterResult> {
  const info = await helloInfo();
  return request<RegisterResult>(`${serverUrl}/api/v1/hosts/register`, {
    method: "POST",
    body: JSON.stringify({ pairing_code: pairingCode, ...info }),
  });
}

/** Revokes the bearer token that authenticates this daemon and its live socket. */
export async function revokeCurrentHost(serverUrl: string, token: string): Promise<void> {
  await request<void>(`${serverUrl}/api/v1/hosts/me/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

export interface WorkspaceOut {
  id: string;
  project_id: string;
  name: string;
  display_path: string | null;
  host_kind: string;
  root_path: string | null;
  created_at: string;
}

export async function createWorkspace(
  serverUrl: string,
  token: string,
  input: { projectId: string; name: string; displayPath: string },
): Promise<WorkspaceOut> {
  return request<WorkspaceOut>(`${serverUrl}/api/v1/hosts/me/workspaces`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ project_id: input.projectId, name: input.name, display_path: input.displayPath }),
  });
}

export async function listWorkspaces(serverUrl: string, token: string): Promise<WorkspaceOut[]> {
  const result = await request<{ items: WorkspaceOut[] }>(`${serverUrl}/api/v1/hosts/me/workspaces`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  return result.items;
}

export async function removeWorkspace(serverUrl: string, token: string, folderId: string): Promise<void> {
  await request<void>(`${serverUrl}/api/v1/hosts/me/workspaces/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function uploadRunDiff(
  serverUrl: string,
  token: string,
  runId: string,
  input: { diff: string; truncated: boolean },
): Promise<void> {
  await request<void>(`${serverUrl}/api/v1/hosts/me/runs/${encodeURIComponent(runId)}/diff`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
}

export async function uploadRunOutputs(
  serverUrl: string,
  token: string,
  runId: string,
  files: Array<{ name: string; content: string }>,
): Promise<void> {
  // Sent even when empty: the control plane applies this run's artifact
  // declarations here, and a run that declared a deliverable and wrote nothing
  // is exactly the case a person needs told about.
  await request<void>(`${serverUrl}/api/v1/hosts/me/runs/${encodeURIComponent(runId)}/outputs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ files }),
  });
}

export { helloInfo };
