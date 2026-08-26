import { mkdtemp, rm } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { detectCapabilities, type AskRuntimeOptions, type DaemonCapabilities, type RuntimeLookup } from "./capabilities.js";
import { probeAcpOptions } from "./acpProbe.js";
import { resolveAcpLaunch, substituteCwd } from "./execution.js";
import { collectWorkspaceStatus, type WorkspaceStatusReport } from "./workspaceStatus.js";

const DAEMON_VERSION = "0.1.0";

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
 * into.
 */
export interface RuntimeProbe extends RuntimeLookup {
  argv: string[];
  distribution: unknown;
  version: string | null;
  remote_host_only: boolean;
}

export function parseRuntimeProbes(value: unknown): RuntimeProbe[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = entry as Record<string, unknown> | null;
    if (typeof record?.adapter_type !== "string" || !Array.isArray(record.argv)) return [];
    if (!record.argv.every((arg): arg is string => typeof arg === "string") || record.argv.length === 0) return [];
    const login = record.login as Record<string, unknown> | null;
    return [{
      adapter_type: record.adapter_type,
      runtime: typeof record.runtime === "string" ? record.runtime : null,
      argv: record.argv,
      distribution: record.distribution ?? null,
      version: typeof record.version === "string" ? record.version : null,
      remote_host_only: record.remote_host_only === true,
      login: login && Array.isArray(login.command) && typeof login.home_subdir === "string" && typeof login.credential_file === "string"
        ? {
            command: login.command.map(String),
            ...(Array.isArray(login.managed_command) ? { managed_command: login.managed_command.map(String) } : {}),
            home_subdir: login.home_subdir,
            credential_file: login.credential_file,
            ...(typeof login.hint === "string" ? { hint: login.hint } : {}),
          }
        : null,
    }];
  });
}

/**
 * Asks one copy of a runtime what it can be set to, over ACP, launched
 * exactly as a job for it would be.
 */
function askRuntimeOptions(probes: RuntimeProbe[]): AskRuntimeOptions {
  return async (lookup, installation) => {
    const probe = probes.find((candidate) => candidate.adapter_type === lookup.adapter_type);
    if (!probe) return null;
    const cwd = await mkdtemp(join(tmpdir(), "rainver-acp-probe-"));
    try {
      const [rawCommand, ...args] = probe.argv.map((arg) => substituteCwd(arg, cwd));
      const launch = resolveAcpLaunch(rawCommand!, args, installation, probe.adapter_type);
      const options = await probeAcpOptions(launch.command, launch.args, launch.env, cwd);
      return options
        ? {
            models: options.models,
            current_model: options.currentModel,
            efforts: options.efforts,
            current_effort: options.currentEffort,
          }
        : null;
    } catch {
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
): Promise<{
  platform: string;
  arch: string;
  daemon_version: string;
  environment_kind: string;
  capabilities_json: DaemonCapabilities;
  workspace_reports: WorkspaceStatusReport[];
  /**
   * The address this daemon actually reaches the control plane at. Reported so
   * the server can work out an address for its provider proxy that this
   * machine can resolve — a Compose service name cannot be guessed from the
   * server side, and asking an operator to write one into a file is the wrong
   * shape for something the daemon already knows.
   */
  server_url?: string;
}> {
  const capabilities = await detectCapabilities(probes ? askRuntimeOptions(probes) : undefined, probes ?? []);
  const currentPlatform = platform();
  const environment_kind = currentPlatform === "win32"
    ? "windows_native"
    : currentPlatform === "darwin" ? "macos_native" : "linux_native";
  return {
    platform: currentPlatform,
    arch: arch(),
    daemon_version: DAEMON_VERSION,
    environment_kind,
    capabilities_json: capabilities,
    workspace_reports: await collectWorkspaceStatus(workspaces),
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
  if (files.length === 0) return;
  await request<void>(`${serverUrl}/api/v1/hosts/me/runs/${encodeURIComponent(runId)}/outputs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ files }),
  });
}

export { helloInfo };
