import type { VendorCliAdapterType } from "../runtimeAdapters/specs.js";

export const SANDBOX_RUNNER_PROTOCOL_VERSION = 1 as const;

export type SandboxAccess = "read_only" | "read_write";
export type SandboxEgressProfile = "none" | "provider" | "tools" | "provider_and_tools";

export interface SandboxMountRef {
  root: "workspaces" | "sandboxes" | "runtime_tools" | "run_homes" | "conversation_homes" | "login_homes";
  id: string;
  target: "/workspace" | "/delivery" | "/runtime-tool" | "/home/sandbox"
    | "/run-exchange/input" | "/run-exchange/output";
  access: SandboxAccess;
}

export interface SandboxRuntimeEnvironment {
  locale?: string;
  term?: string;
  codex_home?: "/home/sandbox/.codex";
  provider_channel?: { kind: "managed_proxy" | "credential_profile" };
  anthropic?: {
    base_url?: string;
    auth_token?: string;
    model?: string;
    default_sonnet_model?: string;
    default_opus_model?: string;
    default_haiku_model?: string;
  };
  proxy?: {
    http?: string;
    https?: string;
    all?: string;
    no_proxy?: string;
  };
  tool_channel?: { url: string; token: string };
  exchange?: boolean;
}

export interface SandboxLaunchRequest {
  protocol_version: typeof SANDBOX_RUNNER_PROTOCOL_VERSION;
  run_id: string;
  scope_id: string;
  runtime: VendorCliAdapterType | "verification";
  runtime_tool_id: string;
  arguments: string[];
  sandbox_mode: "read_only" | "read_write";
  egress_profile: SandboxEgressProfile;
  mounts: SandboxMountRef[];
  environment: SandboxRuntimeEnvironment;
  timeout_seconds: number;
  stall_timeout_seconds?: number;
  stdin_mode: "none" | "fixed" | "interactive";
  terminal_mode: "pipe" | "pty";
}

export type SandboxClientFrame =
  | { type: "launch"; token: string; request: SandboxLaunchRequest }
  | { type: "stdin"; value: string }
  | { type: "stdin_close" }
  | { type: "terminate"; force: boolean };

export type SandboxRunnerFrame =
  | { type: "ready" }
  | { type: "stdout"; value: string }
  | { type: "stderr"; value: string }
  | { type: "exit"; returncode: number; timed_out: boolean; failure_code?: "timeout" | "stall_timeout" | "sandbox_runner_unavailable" | "sandbox_namespace_unavailable" }
  | { type: "error"; code: "invalid_request" | "sandbox_runner_unavailable" | "sandbox_namespace_unavailable"; message: string };

export function isSafeMountId(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
