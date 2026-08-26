import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ServerConfig } from "../../config.js";
import { getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters/index.js";

export interface RuntimeToolDefinition {
  runtime: string;
  label: string;
  source: "npm";
  package_name: string;
  bin_name: string;
  bin_relative_path: string;
  package_json_relative_path: string;
  default_version: string;
  /**
   * ACP runtime replatform P3: set only for codex_cli. The managed package
   * is the ACP adapter (`bin_relative_path` -> `codex-acp`), but two
   * features that predate the ACP migration — CLI device-auth login and the
   * TUI-scraping quota probe — still spawn the underlying vendor `codex`
   * binary directly and speak its own protocol, not ACP. codex-acp bundles
   * a compatible `@openai/codex` as a regular dependency, so the same
   * managed install already places a working `codex` binary at this sibling
   * path — resolved via `resolveVendorCliForExecution`, never
   * `resolveForExecution` (which resolves `bin_relative_path`, the adapter).
   */
  vendor_cli_bin_relative_path?: string;
  /**
   * A runtime may use a pinned ACP adapter for execution while retaining the
   * vendor CLI package for login and legacy quota-probe flows. The vendor
   * package is installed into the same isolated version root and never used as
   * the conversation executable.
   */
  vendor_package_name?: string;
  vendor_package_version?: string;
}

export interface RuntimeToolManifest {
  schema_version: 1;
  runtime: string;
  source: "npm";
  package_name: string;
  requested_version: string;
  version: string;
  bin_name: string;
  bin_relative_path: string;
  installed_at: string;
}

export interface RuntimeToolStatus {
  runtime: string;
  label: string;
  source: "npm";
  package_name: string;
  bin_name: string;
  installed: boolean;
  active_version: string | null;
  executable_path: string | null;
  executable_exists: boolean;
  manifest: RuntimeToolManifest | null;
  installed_versions: RuntimeToolInstalledVersion[];
  warnings: string[];
}

export interface RuntimeToolInstalledVersion {
  version: string;
  installed: boolean;
  executable_path: string | null;
  executable_exists: boolean;
  manifest: RuntimeToolManifest | null;
  warnings: string[];
}

export interface RuntimeToolInstallInput {
  version?: string | null;
  activate?: boolean;
  force?: boolean;
}

export interface RuntimeToolInstallResult extends RuntimeToolStatus {
  installed_version: string;
  activated: boolean;
}

export interface RuntimeToolLatest {
  runtime: string;
  package_name: string;
  latest_version: string | null;
}

export interface ResolvedRuntimeTool {
  runtime: string;
  executable_path: string;
  version: string;
  source: "npm";
  package_name: string;
}

export interface RuntimeToolResolverPort {
  resolveForExecution(runtime: string, version?: string | null): Promise<ResolvedRuntimeTool>;
}

export interface RuntimeToolInstallRunner {
  run(input: {
    package_ref: string;
    prefix: string;
    cache_dir: string;
    ignore_scripts?: boolean;
  }): Promise<void>;
}

export const RUNTIME_TOOL_DEFINITIONS: Record<string, RuntimeToolDefinition> = {
  claude_code: {
    runtime: "claude_code",
    label: "Claude Code",
    source: "npm",
    package_name: "@agentclientprotocol/claude-agent-acp",
    bin_name: "claude-agent-acp",
    bin_relative_path: join("node_modules", ".bin", "claude-agent-acp"),
    package_json_relative_path: join("node_modules", "@agentclientprotocol", "claude-agent-acp", "package.json"),
    default_version: "latest",
    vendor_package_name: "@anthropic-ai/claude-code",
    vendor_package_version: "latest",
    vendor_cli_bin_relative_path: join("node_modules", ".bin", "claude"),
  },
  // ACP runtime replatform P3: server-host runs codex through the ACP
  // adapter (bundles a compatible @openai/codex, driven via CODEX_HOME the
  // same way the raw CLI already was), not the raw `codex` package directly.
  codex_cli: {
    runtime: "codex_cli",
    label: "Codex CLI",
    source: "npm",
    package_name: "@agentclientprotocol/codex-acp",
    bin_name: "codex-acp",
    bin_relative_path: join("node_modules", ".bin", "codex-acp"),
    package_json_relative_path: join("node_modules", "@agentclientprotocol", "codex-acp", "package.json"),
    default_version: "latest",
    vendor_cli_bin_relative_path: join("node_modules", ".bin", "codex"),
  },
  opencode: {
    runtime: "opencode",
    label: "OpenCode",
    source: "npm",
    package_name: "opencode-ai",
    bin_name: "opencode",
    bin_relative_path: join("node_modules", ".bin", "opencode"),
    package_json_relative_path: join("node_modules", "opencode-ai", "package.json"),
    default_version: "latest",
  },
};

const INSTALL_OUTPUT_LIMIT = 12_000;
const NPM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const LATEST_VERSION_TIMEOUT_MS = 10_000;
const VERSION_REF_RE = /^[A-Za-z0-9_.@+-]+$/;
const COMPONENT_RE = /^[A-Za-z0-9_.-]+$/;
const NPM_NETWORK_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_NOPROXY",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_STRICT_SSL",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_FETCH_RETRIES",
  "NPM_CONFIG_FETCH_RETRY_MINTIMEOUT",
  "NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_noproxy",
  "npm_config_registry",
  "npm_config_strict_ssl",
  "npm_config_cafile",
  "npm_config_fetch_retries",
  "npm_config_fetch_retry_mintimeout",
  "npm_config_fetch_retry_maxtimeout",
] as const;

export class RuntimeToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "RuntimeToolError";
  }
}

function definitionFor(runtime: string): RuntimeToolDefinition {
  const definition = RUNTIME_TOOL_DEFINITIONS[runtime];
  const spec = getLocalCliRuntimeAdapterSpec(runtime);
  if (
    !definition ||
    !spec ||
    spec.implementation_status !== "implemented" ||
    spec.credentials.credential_runtime_name !== runtime
  ) {
    throw new RuntimeToolError(
      "runtime_tool_not_allowlisted",
      `Runtime tool '${runtime}' is not allowlisted.`,
      404,
    );
  }
  if (spec.executable.command !== definition.bin_name) {
    throw new RuntimeToolError(
      "runtime_tool_spec_mismatch",
      `Runtime tool '${runtime}' does not match its adapter spec.`,
      500,
    );
  }
  return definition;
}

function cleanComponent(value: string, field: string): string {
  if (!COMPONENT_RE.test(value)) {
    throw new RuntimeToolError(
      "invalid_runtime_tool_component",
      `${field} may contain only letters, numbers, dot, underscore, and dash.`,
      400,
    );
  }
  return value;
}

function validateVersionRef(value: string): string {
  if (!VERSION_REF_RE.test(value)) {
    throw new RuntimeToolError(
      "invalid_runtime_tool_version",
      "version may contain only letters, numbers, dot, underscore, dash, plus, and @.",
      400,
    );
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const stat = await lstat(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

async function claudePlacedBinaryReady(prefix: string): Promise<boolean> {
  const size = await fileSize(claudePlacedBinaryPath(prefix));
  return size !== null && size > 4096;
}

async function runtimeToolVersionReady(
  definition: RuntimeToolDefinition,
  versionRoot: string,
): Promise<boolean> {
  if (!(await executableExists(resolve(versionRoot, definition.bin_relative_path)))) {
    return false;
  }
  if (
    definition.vendor_cli_bin_relative_path
    && !(await executableExists(resolve(versionRoot, definition.vendor_cli_bin_relative_path)))
  ) {
    return false;
  }
  if (definition.runtime === "opencode" && !(await openCodeBinaryReady(versionRoot))) {
    return false;
  }
  for (const nativePackagePath of nativeOptionalPackagePaths(definition, versionRoot)) {
    if (!(await exists(nativePackagePath))) return false;
  }
  if (definition.runtime === "claude_code" && !(await claudePlacedBinaryReady(versionRoot))) {
    return false;
  }
  return true;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (current.length >= INSTALL_OUTPUT_LIMIT) return current;
  const next = current + chunk.toString("utf8");
  return next.length > INSTALL_OUTPUT_LIMIT
    ? `${next.slice(0, INSTALL_OUTPUT_LIMIT)}\n[TRUNCATED]`
    : next;
}

function packageRef(definition: RuntimeToolDefinition, version: string): string {
  return `${definition.package_name}@${version}`;
}

function codexNativePackageName(): string | null {
  if (process.platform !== "linux") return null;
  if (process.arch === "x64") return "@openai/codex-linux-x64";
  if (process.arch === "arm64") return "@openai/codex-linux-arm64";
  return null;
}

function claudeNativePackageName(): string | null {
  if (process.platform === "linux") {
    if (process.arch === "x64") {
      return isMuslRuntime()
        ? "@anthropic-ai/claude-code-linux-x64-musl"
        : "@anthropic-ai/claude-code-linux-x64";
    }
    if (process.arch === "arm64") {
      return isMuslRuntime()
        ? "@anthropic-ai/claude-code-linux-arm64-musl"
        : "@anthropic-ai/claude-code-linux-arm64";
    }
  }
  if (process.platform === "darwin") {
    if (process.arch === "x64") return "@anthropic-ai/claude-code-darwin-x64";
    if (process.arch === "arm64") return "@anthropic-ai/claude-code-darwin-arm64";
  }
  if (process.platform === "win32") {
    if (process.arch === "x64") return "@anthropic-ai/claude-code-win32-x64";
    if (process.arch === "arm64") return "@anthropic-ai/claude-code-win32-arm64";
  }
  return null;
}

function claudeAcpNativePackageName(): string | null {
  if (process.platform === "linux") {
    if (process.arch === "x64") {
      return isMuslRuntime()
        ? "@anthropic-ai/claude-agent-sdk-linux-x64-musl"
        : "@anthropic-ai/claude-agent-sdk-linux-x64";
    }
    if (process.arch === "arm64") {
      return isMuslRuntime()
        ? "@anthropic-ai/claude-agent-sdk-linux-arm64-musl"
        : "@anthropic-ai/claude-agent-sdk-linux-arm64";
    }
  }
  if (process.platform === "darwin") {
    if (process.arch === "x64") return "@anthropic-ai/claude-agent-sdk-darwin-x64";
    if (process.arch === "arm64") return "@anthropic-ai/claude-agent-sdk-darwin-arm64";
  }
  if (process.platform === "win32") {
    if (process.arch === "x64") return "@anthropic-ai/claude-agent-sdk-win32-x64";
    if (process.arch === "arm64") return "@anthropic-ai/claude-agent-sdk-win32-arm64";
  }
  return null;
}

function isMuslRuntime(): boolean {
  if (process.platform !== "linux") return false;
  const report = typeof process.report?.getReport === "function"
    ? process.report.getReport()
    : null;
  const header = report && typeof report === "object"
    ? (report as { header?: { glibcVersionRuntime?: string } }).header
    : undefined;
  return Boolean(header && !header.glibcVersionRuntime);
}

function linuxSupportsAvx2(): boolean {
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  try {
    return /(^|\s)avx2(\s|$)/i.test(readFileSync("/proc/cpuinfo", "utf8"));
  } catch {
    return false;
  }
}

/**
 * OpenCode's npm postinstall has its own libc probe and can select a musl
 * package even when the Node runtime is glibc-based. Keep the selection in
 * the server installer, where the runtime that will execute the tool is
 * authoritative, and never mix libc variants in the fallback list.
 */
function openCodeNativePackageNames(): string[] {
  const libcSuffix = isMuslRuntime() ? "-musl" : "";
  if (process.platform === "linux") {
    if (process.arch === "x64") {
      const base = "opencode-linux-x64";
      return linuxSupportsAvx2()
        ? [`${base}${libcSuffix}`, `${base}-baseline${libcSuffix}`]
        : [`${base}-baseline${libcSuffix}`, `${base}${libcSuffix}`];
    }
    if (process.arch === "arm64") return [`opencode-linux-arm64${libcSuffix}`];
    return [];
  }
  if (process.platform === "darwin") {
    if (process.arch === "x64") return ["opencode-darwin-x64", "opencode-darwin-x64-baseline"];
    if (process.arch === "arm64") return ["opencode-darwin-arm64"];
    return [];
  }
  if (process.platform === "win32") {
    if (process.arch === "x64") return ["opencode-windows-x64", "opencode-windows-x64-baseline"];
    if (process.arch === "arm64") return ["opencode-windows-arm64"];
    return [];
  }
  return [];
}

function openCodeNativeBinaryName(): string {
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function openCodeWrapperBinaryPath(prefix: string): string {
  return join(prefix, "node_modules", "opencode-ai", "bin", "opencode.exe");
}

function openCodeNativeBinaryPath(prefix: string, packageName: string): string {
  return join(packageInstallPath(prefix, packageName), "bin", openCodeNativeBinaryName());
}

async function openCodeBinaryReady(prefix: string): Promise<boolean> {
  if (!(await executableExists(openCodeWrapperBinaryPath(prefix)))) return false;
  const nativeBinaryChecks = await Promise.all(
    openCodeNativePackageNames().map(packageName =>
      executableExists(openCodeNativeBinaryPath(prefix, packageName)),
    ),
  );
  return nativeBinaryChecks.some(Boolean);
}

function nativeOptionalPackageName(definition: RuntimeToolDefinition): string | null {
  if (definition.runtime === "codex_cli") return codexNativePackageName();
  if (definition.runtime === "claude_code") return claudeNativePackageName();
  return null;
}

function packageInstallPath(prefix: string, packageName: string): string {
  const [scope, name] = packageName.split("/");
  return name
    ? join(prefix, "node_modules", scope, name)
    : join(prefix, "node_modules", packageName);
}

function nativeOptionalPackageNames(definition: RuntimeToolDefinition): string[] {
  const names = [nativeOptionalPackageName(definition)];
  if (definition.runtime === "claude_code") names.push(claudeAcpNativePackageName());
  return names.filter((name): name is string => Boolean(name));
}

function nativeOptionalPackagePaths(
  definition: RuntimeToolDefinition,
  versionRoot: string,
): string[] {
  return nativeOptionalPackageNames(definition).map((name) => packageInstallPath(versionRoot, name));
}

function claudeWrapperPackagePath(prefix: string): string {
  return join(prefix, "node_modules", "@anthropic-ai", "claude-code");
}

function claudePostinstallPath(prefix: string): string {
  return join(claudeWrapperPackagePath(prefix), "install.cjs");
}

function claudePlacedBinaryPath(prefix: string): string {
  return join(claudeWrapperPackagePath(prefix), "bin", "claude.exe");
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function npmInstallEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TERM"]) {
    const value = source[key];
    if (value) safe[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value && key.startsWith("LC_")) safe[key] = value;
  }
  for (const key of NPM_NETWORK_ENV_KEYS) {
    const value = source[key];
    if (value) safe[key] = value;
  }
  return safe;
}

async function runNpmInstall(input: {
  package_ref: string;
  prefix: string;
  cache_dir: string;
  ignore_scripts?: boolean;
}): Promise<void> {
  await mkdir(input.cache_dir, { recursive: true, mode: 0o700 });
  const args = [
    "install",
    "--prefix",
    input.prefix,
    "--omit=dev",
    "--include=optional",
    "--no-audit",
    "--no-fund",
    "--fetch-retries=5",
    "--fetch-retry-mintimeout=10000",
    "--fetch-retry-maxtimeout=120000",
    "--cache",
    input.cache_dir,
    input.package_ref,
  ];
  if (input.ignore_scripts) args.splice(1, 0, "--ignore-scripts");
  const safeEnv = npmInstallEnv();
  await new Promise<void>((resolvePromise, reject) => {
    let output = "";
    let settled = false;
    let proc;
    try {
      proc = spawn("npm", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: safeEnv,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(
        new RuntimeToolError(
          "runtime_tool_install_timeout",
          "Runtime tool install timed out.",
          504,
        ),
      );
    }, NPM_INSTALL_TIMEOUT_MS);
    proc.stdout?.on("data", (chunk: Buffer) => {
      output = boundedAppend(output, chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      output = boundedAppend(output, chunk);
    });
    proc.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolvePromise();
      reject(
        new RuntimeToolError(
          "runtime_tool_install_failed",
          output.trim() || `npm install exited with ${code ?? -1}.`,
          502,
        ),
      );
    });
  });
}

async function runNodePostinstall(scriptPath: string, cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let output = "";
    let settled = false;
    let proc;
    try {
      proc = spawn(process.execPath, [scriptPath], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: npmInstallEnv(),
      });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(
        new RuntimeToolError(
          "runtime_tool_postinstall_timeout",
          "Runtime tool postinstall timed out.",
          504,
        ),
      );
    }, NPM_INSTALL_TIMEOUT_MS);
    proc.stdout?.on("data", (chunk: Buffer) => {
      output = boundedAppend(output, chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      output = boundedAppend(output, chunk);
    });
    proc.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolvePromise();
      reject(
        new RuntimeToolError(
          "runtime_tool_postinstall_failed",
          output.trim() || `postinstall exited with ${code ?? -1}.`,
          502,
        ),
      );
    });
  });
}

export class RuntimeToolRegistry implements RuntimeToolResolverPort {
  constructor(
    private readonly config: ServerConfig,
    private readonly runner: RuntimeToolInstallRunner = { run: runNpmInstall },
  ) {}

  listDefinitions(): RuntimeToolDefinition[] {
    return Object.values(RUNTIME_TOOL_DEFINITIONS);
  }

  async listStatus(): Promise<RuntimeToolStatus[]> {
    return Promise.all(this.listDefinitions().map((definition) => this.status(definition.runtime)));
  }

  async status(runtime: string): Promise<RuntimeToolStatus> {
    const definition = definitionFor(runtime);
    const root = this.runtimeRoot(definition.runtime);
    const activePath = join(root, "active");
    const warnings: string[] = [];
    const installedVersions = await this.listInstalledVersions(runtime);
    let activeVersion: string | null = null;
    let manifest: RuntimeToolManifest | null = null;
    let executablePath: string | null = null;
    let executableOk = false;

    try {
      const stat = await lstat(activePath);
      if (!stat.isSymbolicLink()) {
        warnings.push("active path exists but is not a symlink");
      } else {
        const target = await readlink(activePath);
        if (!target.startsWith("versions/")) {
          warnings.push("active symlink target is invalid");
        } else {
          activeVersion = cleanComponent(target.slice("versions/".length), "active_version");
        }
        if (!activeVersion) {
          return {
            runtime: definition.runtime,
            label: definition.label,
            source: definition.source,
            package_name: definition.package_name,
            bin_name: definition.bin_name,
            installed: false,
            active_version: null,
            executable_path: null,
            executable_exists: false,
            manifest: null,
            installed_versions: installedVersions,
            warnings,
          };
        }
        const versionRoot = this.versionRoot(definition.runtime, activeVersion);
        manifest = await this.readManifest(definition.runtime, activeVersion);
        executablePath = resolve(versionRoot, definition.bin_relative_path);
        executableOk = await executableExists(executablePath);
        if (!executableOk) warnings.push("active executable is missing or not executable");
        if (
          definition.vendor_cli_bin_relative_path
          && !(await executableExists(resolve(versionRoot, definition.vendor_cli_bin_relative_path)))
        ) {
          executableOk = false;
          warnings.push(`${definition.label}'s bundled vendor CLI executable is missing; reinstall the ${definition.label} runtime tool.`);
        }
        if (definition.runtime === "opencode" && !(await openCodeBinaryReady(versionRoot))) {
          executableOk = false;
          warnings.push("OpenCode libc-compatible native binary is missing; reinstall the OpenCode runtime tool.");
        }
        for (const nativePackageName of nativeOptionalPackageNames(definition)) {
          const nativePackagePath = packageInstallPath(versionRoot, nativePackageName);
          if (!(await exists(nativePackagePath))) {
            executableOk = false;
            warnings.push(`${nativePackageName} is missing; reinstall the ${definition.label} runtime tool.`);
          }
        }
        if (definition.runtime === "claude_code" && !(await claudePlacedBinaryReady(versionRoot))) {
          executableOk = false;
          warnings.push("Claude native binary is missing; reinstall the Claude Code runtime tool.");
        }
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") warnings.push(error instanceof Error ? error.message : String(error));
    }

    return {
      runtime: definition.runtime,
      label: definition.label,
      source: definition.source,
      package_name: definition.package_name,
      bin_name: definition.bin_name,
      installed: executableOk,
      active_version: activeVersion,
      executable_path: executablePath,
      executable_exists: executableOk,
      manifest,
      installed_versions: installedVersions,
      warnings,
    };
  }

  async listInstalledVersions(runtime: string): Promise<RuntimeToolInstalledVersion[]> {
    const definition = definitionFor(runtime);
    const versionsRoot = join(this.runtimeRoot(definition.runtime), "versions");
    let entries: string[];
    try {
      entries = await readdir(versionsRoot);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const versions = await Promise.all(
      entries
        .filter((entry) => COMPONENT_RE.test(entry))
        .sort()
        .map((version) => this.installedVersionStatus(definition, version)),
    );
    return versions;
  }

  /**
   * Look up the package's current published version from the npm registry — the
   * same registry `install` pulls from — so the UI can tell whether an update is
   * available. Network call; surfaces a 502 RuntimeToolError when unreachable.
   */
  async latestVersion(runtime: string): Promise<RuntimeToolLatest> {
    const definition = definitionFor(runtime);
    const url = `https://registry.npmjs.org/${definition.package_name}/latest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATEST_VERSION_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new RuntimeToolError(
          "runtime_tool_latest_failed",
          `npm registry returned ${response.status}.`,
          502,
        );
      }
      const body = (await response.json()) as { version?: unknown };
      return {
        runtime: definition.runtime,
        package_name: definition.package_name,
        latest_version: typeof body.version === "string" ? body.version : null,
      };
    } catch (error) {
      if (error instanceof RuntimeToolError) throw error;
      throw new RuntimeToolError(
        "runtime_tool_latest_failed",
        "Could not reach the npm registry to check for updates.",
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveForExecution(runtime: string, version?: string | null): Promise<ResolvedRuntimeTool> {
    const definition = definitionFor(runtime);
    if (version?.trim()) {
      const cleanVersion = cleanComponent(version.trim(), "version");
      const versionStatus = await this.installedVersionStatus(definition, cleanVersion);
      if (!versionStatus.installed || !versionStatus.executable_path) {
        throw new RuntimeToolError(
          "runtime_tool_version_not_installed",
          `Runtime tool '${runtime}' version '${cleanVersion}' is not installed.`,
          409,
        );
      }
      const root = this.runtimeRoot(runtime);
      const resolved = resolve(versionStatus.executable_path);
      if (!isWithinRoot(root, resolved)) {
        throw new RuntimeToolError(
          "runtime_tool_path_escape",
          "Runtime tool executable escapes its installation root.",
          500,
        );
      }
      return {
        runtime,
        executable_path: resolved,
        version: cleanVersion,
        source: definition.source,
        package_name: definition.package_name,
      };
    }
    const status = await this.status(runtime);
    if (!status.installed || !status.executable_path || !status.active_version) {
      throw new RuntimeToolError(
        "cli_tool_not_installed",
        `Runtime tool '${runtime}' is not installed.`,
        409,
      );
    }
    const root = this.runtimeRoot(runtime);
    const resolved = resolve(status.executable_path);
    if (!isWithinRoot(root, resolved)) {
      throw new RuntimeToolError(
        "runtime_tool_path_escape",
        "Runtime tool executable escapes its installation root.",
        500,
      );
    }
    return {
      runtime,
      executable_path: resolved,
      version: status.active_version,
      source: definition.source,
      package_name: definition.package_name,
    };
  }

  /**
   * ACP runtime replatform P3: for codex_cli only, resolves the underlying
   * vendor `codex` binary bundled alongside the managed `codex-acp` adapter
   * — for the CLI device-auth login flow and the TUI-scraping quota probe,
   * both of which spawn the vendor CLI directly and predate the ACP
   * migration. `resolveForExecution` resolves the adapter binary instead;
   * the two are never interchangeable.
   */
  async resolveVendorCliForExecution(runtime: string): Promise<ResolvedRuntimeTool> {
    const definition = definitionFor(runtime);
    if (!definition.vendor_cli_bin_relative_path) {
      throw new RuntimeToolError(
        "runtime_tool_vendor_cli_not_applicable",
        `Runtime tool '${runtime}' has no separate vendor CLI executable to resolve.`,
        500,
      );
    }
    const status = await this.status(runtime);
    if (!status.installed || !status.active_version) {
      throw new RuntimeToolError(
        "cli_tool_not_installed",
        `Runtime tool '${runtime}' is not installed.`,
        409,
      );
    }
    const root = this.runtimeRoot(runtime);
    const versionRoot = this.versionRoot(runtime, status.active_version);
    const resolved = resolve(versionRoot, definition.vendor_cli_bin_relative_path);
    if (!isWithinRoot(root, resolved)) {
      throw new RuntimeToolError(
        "runtime_tool_path_escape",
        "Runtime tool executable escapes its installation root.",
        500,
      );
    }
    if (!(await executableExists(resolved))) {
      throw new RuntimeToolError(
        "cli_tool_not_installed",
        `Runtime tool '${runtime}' is missing its bundled vendor CLI executable; reinstall it.`,
        409,
      );
    }
    return {
      runtime,
      executable_path: resolved,
      version: status.active_version,
      source: definition.source,
      package_name: definition.package_name,
    };
  }

  async install(runtime: string, input: RuntimeToolInstallInput = {}): Promise<RuntimeToolInstallResult> {
    const definition = definitionFor(runtime);
    const requestedVersion = validateVersionRef(input.version?.trim() || definition.default_version);
    const runtimeRoot = this.runtimeRoot(runtime);
    const tmpRoot = join(runtimeRoot, ".tmp");
    const tmpDir = join(tmpRoot, `install-${Date.now()}-${randomUUID()}`);
    await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
    try {
      await this.runner.run({
        package_ref: packageRef(definition, requestedVersion),
        prefix: tmpDir,
        cache_dir: join(this.config.rainverHome, "cache", "npm"),
        ignore_scripts: definition.runtime === "opencode",
      });
      if (definition.vendor_package_name) {
        await this.runner.run({
          package_ref: `${definition.vendor_package_name}@${definition.vendor_package_version ?? "latest"}`,
          prefix: tmpDir,
          cache_dir: join(this.config.rainverHome, "cache", "npm"),
        });
      }
      const packageJson = await readJsonFile<{
        version?: string;
        optionalDependencies?: Record<string, string>;
      }>(
        join(tmpDir, definition.package_json_relative_path),
      );
      const installedVersion = cleanComponent(
        packageJson?.version ?? requestedVersion,
        "installed_version",
      );
      if (definition.runtime === "opencode") {
        await this.ensureOpenCodeBinary(
          tmpDir,
          packageJson?.optionalDependencies ?? {},
        );
      }
      const binPath = join(tmpDir, definition.bin_relative_path);
      if (!(await executableExists(binPath))) {
        throw new RuntimeToolError(
          "runtime_tool_binary_missing",
          `Installed package did not provide executable '${definition.bin_name}'.`,
          502,
        );
      }
      if (
        definition.vendor_cli_bin_relative_path
        && !(await executableExists(join(tmpDir, definition.vendor_cli_bin_relative_path)))
      ) {
        throw new RuntimeToolError(
          "runtime_tool_binary_missing",
          `Installed package did not bundle the vendor CLI executable required by ${definition.label}'s login and quota-probe flows.`,
          502,
        );
      }
      await this.ensureNativeOptionalPackages(
        definition,
        tmpDir,
        packageJson?.optionalDependencies ?? {},
      );
      const missingNativePackages: string[] = [];
      for (const nativePackageName of nativeOptionalPackageNames(definition)) {
        if (!(await exists(packageInstallPath(tmpDir, nativePackageName)))) {
          missingNativePackages.push(nativePackageName);
        }
      }
      if (missingNativePackages.length > 0) {
        throw new RuntimeToolError(
          "runtime_tool_optional_dependency_missing",
          `${missingNativePackages.join(", ")} was not installed. Reinstall ${definition.label} with optional npm dependencies enabled.`,
          502,
        );
      }
      if (definition.runtime === "claude_code" && !(await claudePlacedBinaryReady(tmpDir))) {
        throw new RuntimeToolError(
          "runtime_tool_native_binary_missing",
          "Claude native binary was not installed. Reinstall Claude Code with optional npm dependencies and postinstall scripts enabled.",
          502,
        );
      }
      const target = this.versionRoot(runtime, installedVersion);
      if (await exists(target)) {
        if (!input.force && await runtimeToolVersionReady(definition, target)) {
          await rm(tmpDir, { recursive: true, force: true });
          if (input.activate !== false) await this.activate(runtime, installedVersion);
          const status = await this.status(runtime);
          return { ...status, installed_version: installedVersion, activated: input.activate !== false };
        }
        await rm(target, { recursive: true, force: true });
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(
        join(tmpDir, "tool.json"),
        `${JSON.stringify(
          {
            schema_version: 1,
            runtime,
            source: definition.source,
            package_name: definition.package_name,
            requested_version: requestedVersion,
            version: installedVersion,
            bin_name: definition.bin_name,
            bin_relative_path: definition.bin_relative_path,
            installed_at: new Date().toISOString(),
          } satisfies RuntimeToolManifest,
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await rename(tmpDir, target);
      if (input.activate !== false) await this.activate(runtime, installedVersion);
      const status = await this.status(runtime);
      return { ...status, installed_version: installedVersion, activated: input.activate !== false };
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async ensureNativeOptionalPackages(
    definition: RuntimeToolDefinition,
    prefix: string,
    optionalDependencies: Record<string, string>,
  ): Promise<void> {
    for (const nativePackageName of nativeOptionalPackageNames(definition)) {
      const nativePackagePath = packageInstallPath(prefix, nativePackageName);
      if (await exists(nativePackagePath)) continue;
      // Claude's two native packages come from different packages: the vendor
      // binary is declared by claude-code, while the ACP adapter's native SDK
      // is declared by @anthropic-ai/claude-agent-sdk. Codex's package remains
      // a nested optional dependency of @openai/codex.
      const sourcePackageName = definition.runtime === "claude_code"
        ? nativePackageName === claudeNativePackageName()
          ? definition.vendor_package_name
          : "@anthropic-ai/claude-agent-sdk"
        : definition.runtime === "codex_cli"
          ? "@openai/codex"
          : null;
      const sourceOptionalDependencies = sourcePackageName
        ? (await readJsonFile<{ optionalDependencies?: Record<string, string> }>(
            join(packageInstallPath(prefix, sourcePackageName), "package.json"),
          ))?.optionalDependencies ?? {}
        : optionalDependencies;
      const nativePackageSpec = sourceOptionalDependencies[nativePackageName];
      if (!nativePackageSpec) continue;
      await this.runner.run({
        package_ref: `${nativePackageName}@${nativePackageSpec}`,
        prefix,
        cache_dir: join(this.config.rainverHome, "cache", "npm"),
      });
    }
    if (definition.runtime === "claude_code") await this.ensureClaudePostinstall(prefix);
  }

  private async ensureOpenCodeBinary(
    prefix: string,
    optionalDependencies: Record<string, string>,
  ): Promise<void> {
    const candidates = openCodeNativePackageNames();
    const target = openCodeWrapperBinaryPath(prefix);
    for (const packageName of candidates) {
      const packagePath = packageInstallPath(prefix, packageName);
      if (!(await exists(packagePath))) {
        const packageSpec = optionalDependencies[packageName];
        if (!packageSpec) continue;
        await this.runner.run({
          package_ref: `${packageName}@${packageSpec}`,
          prefix,
          cache_dir: join(this.config.rainverHome, "cache", "npm"),
          ignore_scripts: true,
        });
      }
      const source = openCodeNativeBinaryPath(prefix, packageName);
      if (!(await exists(source))) continue;
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      await chmod(target, 0o755);
      return;
    }
    throw new RuntimeToolError(
      "runtime_tool_optional_dependency_missing",
      `No libc-compatible OpenCode binary was installed. Tried: ${candidates.join(", ") || "none"}.`,
      502,
    );
  }

  private async ensureClaudePostinstall(prefix: string): Promise<void> {
    if (await claudePlacedBinaryReady(prefix)) return;
    await runNodePostinstall(claudePostinstallPath(prefix), claudeWrapperPackagePath(prefix));
  }

  async activate(runtime: string, version: string): Promise<RuntimeToolStatus> {
    const definition = definitionFor(runtime);
    const cleanVersion = cleanComponent(version, "version");
    const versionRoot = this.versionRoot(runtime, cleanVersion);
    const executablePath = join(versionRoot, definition.bin_relative_path);
    if (!(await executableExists(executablePath))) {
      throw new RuntimeToolError(
        "runtime_tool_version_not_installed",
        `Runtime tool '${runtime}' version '${version}' is not installed or is not executable.`,
        404,
      );
    }
    const runtimeRoot = this.runtimeRoot(runtime);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const tmpLink = join(runtimeRoot, `.active-${randomUUID()}`);
    await symlink(join("versions", cleanVersion), tmpLink);
    await rename(tmpLink, join(runtimeRoot, "active"));
    return this.status(runtime);
  }

  private runtimeRoot(runtime: string): string {
    return resolve(this.config.cliToolsRoot, cleanComponent(runtime, "runtime"));
  }

  private versionRoot(runtime: string, version: string): string {
    return resolve(this.runtimeRoot(runtime), "versions", cleanComponent(version, "version"));
  }

  private async readManifest(runtime: string, version: string): Promise<RuntimeToolManifest | null> {
    return readJsonFile<RuntimeToolManifest>(join(this.versionRoot(runtime, version), "tool.json"));
  }

  private async installedVersionStatus(
    definition: RuntimeToolDefinition,
    version: string,
  ): Promise<RuntimeToolInstalledVersion> {
    const cleanVersion = cleanComponent(version, "version");
    const versionRoot = this.versionRoot(definition.runtime, cleanVersion);
    const executablePath = resolve(versionRoot, definition.bin_relative_path);
    const warnings: string[] = [];
    const manifest = await this.readManifest(definition.runtime, cleanVersion);
    let executableOk = await executableExists(executablePath);
    if (!executableOk) warnings.push("executable is missing or not executable");
    if (definition.runtime === "opencode" && !(await openCodeBinaryReady(versionRoot))) {
      executableOk = false;
      warnings.push("OpenCode libc-compatible native binary is missing");
    }
    for (const nativePackageName of nativeOptionalPackageNames(definition)) {
      if (await exists(packageInstallPath(versionRoot, nativePackageName))) continue;
      executableOk = false;
      warnings.push(`${nativePackageName} is missing`);
    }
    if (definition.runtime === "claude_code" && !(await claudePlacedBinaryReady(versionRoot))) {
      executableOk = false;
      warnings.push("Claude native binary is missing");
    }
    return {
      version: cleanVersion,
      installed: executableOk,
      executable_path: executablePath,
      executable_exists: executableOk,
      manifest,
      warnings,
    };
  }
}
