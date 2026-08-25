import { arch, platform } from "node:os";
import { detectCapabilities, type DaemonCapabilities } from "./capabilities.js";
import { probeAcpOptions } from "./acpProbe.js";
import { resolveAcpEntrypoint } from "./execution.js";
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
 * Asks a runtime what it can be set to, over ACP. Wired here rather than
 * inside `detectCapabilities` so the capability module stays free of the ACP
 * adapter resolution that only the execution path knows about.
 */
async function askRuntimeOptions(bin: string) {
  const command = bin === "claude" ? "claude-agent-acp" : bin === "codex" ? "codex-acp" : null;
  if (!command) return null;
  const entrypoint = resolveAcpEntrypoint(command);
  if (!entrypoint) return null;
  const options = await probeAcpOptions(
    process.execPath,
    [entrypoint],
    // Same environment the execution path gives codex-acp: drive the host's
    // own codex, and never try to open a browser on a headless machine.
    bin === "codex" ? { CODEX_PATH: "codex", NO_BROWSER: "1" } : {},
  );
  return options
    ? {
        models: options.models,
        current_model: options.currentModel,
        efforts: options.efforts,
        current_effort: options.currentEffort,
      }
    : null;
}

async function helloInfo(workspaces: Record<string, string> = {}, serverUrl?: string): Promise<{
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
  const capabilities = await detectCapabilities(askRuntimeOptions);
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
