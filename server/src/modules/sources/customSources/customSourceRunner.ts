import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
  CustomSourceHandlerInput,
  CustomSourcePolicyEnvelope,
  CustomSourcePolicyLimits,
} from "@rainver/protocol";
import { redactSecretPatterns } from "../../runs/evidenceRedaction.js";

/**
 * Runner MVP for Source Custom Source handlers. See
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md#runner-expectations`.
 *
 * Honesty boundary (matches B13 / the audit's stated security gaps): this
 * executes the handler as a separate OS process with a temp sandbox
 * directory, a minimal explicit environment, and wall-clock/output-size
 * limits enforced as effective = min(policy envelope, instance hard limit).
 * Before loading the untrusted handler module, a generated bootstrap script
 * (`sandboxBootstrapScript`) monkey-patches `node:net`/`node:tls`/`node:http`/
 * `node:https`/`node:dgram`, `fetch`, `child_process`, `worker_threads`, and
 * common `fs`/`fs.promises` entrypoints to throw unless the operation stays
 * inside the handler contract. This is defense-in-depth, **not** container,
 * network-namespace, or OS-level filesystem isolation: a native addon, a raw
 * syscall, process internals, or an unpatched API could still reach outside
 * the sandbox at the OS permission level. Do not describe this runner as
 * OS-sandboxed in product docs — that mirrors the existing `one_shot_docker`
 * honesty requirement.
 */

export type CustomSourceRunnerBlockReason =
  | "runner_disabled"
  | "language_not_allowed"
  | "browser_automation_requested"
  | "shell_requested"
  | "dependency_installation_requested";

export interface CustomSourceRunnerBlockedResult {
  status: "blocked";
  reason: CustomSourceRunnerBlockReason;
}

export interface CustomSourceRunnerCompletedResult {
  status: "completed";
  exit_code: number | null;
  timed_out: boolean;
  /** Redacted, byte-capped combined stdout/stderr. */
  logs: string;
  logs_truncated: boolean;
  /** Raw (unparsed, unvalidated) contents of the sandbox output.json, or null if the handler never wrote one or output_too_large is true. Phase 3's contract validator must run on this before any Source write. */
  raw_output_json: string | null;
  /** True when the handler wrote an output.json larger than the effective max_output_bytes limit; it was never read into memory and raw_output_json is null. */
  output_too_large: boolean;
  /** Absolute path to the sandbox `files/` directory, for the contract validator/materializer to resolve declared snapshot paths against. Caller is responsible for cleanup via `cleanupSandbox`. */
  sandbox_files_root: string;
}

export type CustomSourceRunnerResult = CustomSourceRunnerBlockedResult | CustomSourceRunnerCompletedResult;

export interface CustomSourceRunnerInput {
  policyEnvelope: CustomSourcePolicyEnvelope;
  handlerInput: CustomSourceHandlerInput;
  /** Absolute path to the handler's entrypoint JS file, already materialized on disk by the caller. Code provisioning is out of this runner's scope. */
  handlerEntrypointPath: string;
}

export interface CustomSourceRunnerSettings {
  runner_enabled: boolean;
  allowed_languages: string[];
  network_hard_deny_rules: string[];
  timeout_ms_max: number;
  output_bytes_max: number;
  download_bytes_max: number;
  log_bytes_max: number;
  max_files: number;
  browser_automation_available: boolean;
  shell_available: boolean;
  dependency_installation_available: boolean;
}

export function evaluateCustomSourceRunnerBlockReason(
  settings: CustomSourceRunnerSettings,
  policyEnvelope: CustomSourcePolicyEnvelope,
): CustomSourceRunnerBlockReason | null {
  if (!settings.runner_enabled) return "runner_disabled";
  if (!settings.allowed_languages.includes(policyEnvelope.language)) return "language_not_allowed";
  // Phase 4 acceptance: browser automation, shell, and dependency installation
  // remain disabled unconditionally, regardless of instance availability flags
  // (those flags are for a later phase's proposal-gated enablement).
  if (policyEnvelope.browser_automation_enabled) return "browser_automation_requested";
  if (policyEnvelope.shell_enabled) return "shell_requested";
  if (policyEnvelope.dependency_installation_enabled) return "dependency_installation_requested";
  return null;
}

/**
 * Instance hard limits always win over a handler version's policy envelope
 * (an explicit plan decision rule) — a handler version cannot request a
 * timeout/log/output/download/file budget beyond what the instance allows.
 */
export function effectiveCustomSourceLimits(
  settings: CustomSourceRunnerSettings,
  policyLimits: CustomSourcePolicyLimits,
): CustomSourcePolicyLimits {
  return {
    ...policyLimits,
    timeout_ms: Math.min(policyLimits.timeout_ms, settings.timeout_ms_max),
    log_max_bytes: Math.min(policyLimits.log_max_bytes, settings.log_bytes_max),
    max_output_bytes: Math.min(policyLimits.max_output_bytes, settings.output_bytes_max),
    max_download_bytes: Math.min(policyLimits.max_download_bytes, settings.download_bytes_max),
    max_files: Math.min(policyLimits.max_files, settings.max_files),
  };
}

/**
 * Generates the sandbox bootstrap script content. Written to the sandbox
 * per run (not a static file) so it ships with the compiled runner without
 * a separate build-asset step. See the module doc comment for what this
 * does and does not guarantee.
 */
function sandboxBootstrapScript(): string {
  return `'use strict';
function blocked(apiName) {
  return function () {
    throw new Error(
      'Custom Source handlers cannot use ' + apiName +
      ' in this runner (network, process-spawn, and filesystem access are restricted by default).',
    );
  };
}
const path = require('node:path');
const { fileURLToPath, URL: NodeURL } = require('node:url');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const dgram = require('node:dgram');
const childProcess = require('node:child_process');
const workerThreads = require('node:worker_threads');
// Node creates pipe-backed stdout/stderr lazily through net internals. Build
// those streams before patching common net entrypoints below, otherwise
// console output can be silently dropped.
void process.stdout;
void process.stderr;
const sandboxRoot = process.cwd();
const inputPath = path.resolve(sandboxRoot, 'input.json');
const outputPath = path.resolve(sandboxRoot, 'output.json');
const filesRoot = path.resolve(sandboxRoot, 'files');
const bootstrapPath = path.resolve(__filename);
const handlerPath = path.resolve(process.argv[2]);
function normalizeUserPath(value) {
  if (typeof value === 'number') {
    throw new Error('Custom Source handlers cannot use numeric file descriptors in this runner.');
  }
  if (value instanceof NodeURL) return path.resolve(fileURLToPath(value));
  if (Buffer.isBuffer(value)) return path.resolve(sandboxRoot, value.toString('utf8'));
  return path.resolve(sandboxRoot, String(value));
}
function insideRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
const allowedReadFiles = new Set([inputPath, outputPath, bootstrapPath, handlerPath]);
function assertReadPath(value) {
  const target = normalizeUserPath(value);
  if (allowedReadFiles.has(target) || insideRoot(target, filesRoot)) return target;
  throw new Error('Custom Source handlers cannot read files outside input.json, output.json, their entrypoint, and sandbox files/.');
}
function assertWritePath(value) {
  const target = normalizeUserPath(value);
  if (target === outputPath || insideRoot(target, filesRoot)) return target;
  throw new Error('Custom Source handlers cannot write files outside output.json and sandbox files/.');
}
function flagsWrite(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'string') return flags !== 'r' && flags !== 'rs' && flags !== 'sr';
  if (typeof flags === 'number') {
    const constants = fs.constants;
    return Boolean(
      flags & constants.O_WRONLY ||
      flags & constants.O_RDWR ||
      flags & constants.O_CREAT ||
      flags & constants.O_TRUNC ||
      flags & constants.O_APPEND
    );
  }
  return true;
}
function patchPathFunction(obj, name, guard) {
  const original = obj[name];
  if (typeof original !== 'function') return;
  obj[name] = function (filePath, ...args) {
    guard(filePath);
    return original.call(this, filePath, ...args);
  };
}
function patchOpenFunction(obj, name) {
  const original = obj[name];
  if (typeof original !== 'function') return;
  obj[name] = function (filePath, flags, ...args) {
    if (flagsWrite(flags)) assertWritePath(filePath);
    else assertReadPath(filePath);
    return original.call(this, filePath, flags, ...args);
  };
}
function patchTwoPathFunction(obj, name, firstGuard, secondGuard) {
  const original = obj[name];
  if (typeof original !== 'function') return;
  obj[name] = function (firstPath, secondPath, ...args) {
    firstGuard(firstPath);
    secondGuard(secondPath);
    return original.call(this, firstPath, secondPath, ...args);
  };
}
for (const name of ['readFile']) {
  patchPathFunction(fsPromises, name, assertReadPath);
}
for (const name of ['appendFile', 'mkdir', 'rm', 'unlink', 'writeFile']) {
  patchPathFunction(fsPromises, name, assertWritePath);
}
patchOpenFunction(fsPromises, 'open');
patchTwoPathFunction(fsPromises, 'copyFile', assertReadPath, assertWritePath);
patchTwoPathFunction(fsPromises, 'rename', assertWritePath, assertWritePath);
for (const name of ['link', 'symlink']) {
  fsPromises[name] = blocked('fs.promises.' + name);
}
for (const name of ['readFileSync']) {
  patchPathFunction(fs, name, assertReadPath);
}
for (const name of ['appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'writeFileSync']) {
  patchPathFunction(fs, name, assertWritePath);
}
patchPathFunction(fs, 'createReadStream', assertReadPath);
patchPathFunction(fs, 'createWriteStream', assertWritePath);
patchOpenFunction(fs, 'open');
patchOpenFunction(fs, 'openSync');
patchTwoPathFunction(fs, 'copyFile', assertReadPath, assertWritePath);
patchTwoPathFunction(fs, 'copyFileSync', assertReadPath, assertWritePath);
patchTwoPathFunction(fs, 'rename', assertWritePath, assertWritePath);
patchTwoPathFunction(fs, 'renameSync', assertWritePath, assertWritePath);
for (const name of ['link', 'linkSync', 'symlink', 'symlinkSync']) {
  fs[name] = blocked('fs.' + name);
}
net.connect = net.createConnection = net.createServer = blocked('net.connect');
tls.connect = tls.createServer = blocked('tls.connect');
http.request = http.get = http.createServer = blocked('http.request');
https.request = https.get = https.createServer = blocked('https.request');
dgram.createSocket = blocked('dgram.createSocket');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = blocked('child_process.' + name);
}
workerThreads.Worker = blocked('worker_threads.Worker');
if (typeof globalThis.fetch === 'function') globalThis.fetch = blocked('fetch');
if (typeof globalThis.XMLHttpRequest !== 'undefined') globalThis.XMLHttpRequest = blocked('XMLHttpRequest');
require(process.argv[2]);
`;
}

export class CustomSourceRunner {
  constructor(private readonly settings: CustomSourceRunnerSettings) {}

  async run(input: CustomSourceRunnerInput): Promise<CustomSourceRunnerResult> {
    const blockReason = evaluateCustomSourceRunnerBlockReason(this.settings, input.policyEnvelope);
    if (blockReason) return { status: "blocked", reason: blockReason };

    const sandboxRoot = join(tmpdir(), `custom-source-run-${randomUUID()}`);
    await mkdir(sandboxRoot, { recursive: true });
    const filesRoot = join(sandboxRoot, "files");
    await mkdir(filesRoot, { recursive: true });
    await writeFile(join(sandboxRoot, "input.json"), JSON.stringify(input.handlerInput), "utf8");
    const bootstrapPath = join(sandboxRoot, "__custom_source_bootstrap.cjs");
    await writeFile(bootstrapPath, sandboxBootstrapScript(), "utf8");

    return this.execute(sandboxRoot, filesRoot, bootstrapPath, input);
  }

  private async execute(
    sandboxRoot: string,
    filesRoot: string,
    bootstrapPath: string,
    input: CustomSourceRunnerInput,
  ): Promise<CustomSourceRunnerCompletedResult> {
    const limits = effectiveCustomSourceLimits(this.settings, input.policyEnvelope.limits);
    const outputPath = join(sandboxRoot, "output.json");
    const logPath = join(sandboxRoot, "__handler.log");
    const logHandle = await open(logPath, "w");

    const { exitCode, timedOut, processErrorLog } = await new Promise<{
      exitCode: number | null;
      timedOut: boolean;
      processErrorLog: string | null;
    }>((resolveRun) => {
      let settled = false;
      let processErrorLog: string | null = null;

      let proc: ChildProcess;
      try {
        proc = spawn(process.execPath, [bootstrapPath, input.handlerEntrypointPath], {
          cwd: sandboxRoot,
          env: minimalHandlerEnv(sandboxRoot),
          detached: true,
          shell: false,
          stdio: ["ignore", logHandle.fd, logHandle.fd],
        });
      } catch (error) {
        resolveRun({
          exitCode: null,
          timedOut: false,
          processErrorLog: error instanceof Error ? error.message : "handler spawn failed",
        });
        return;
      }

      const finish = (exitCode: number | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRun({
          exitCode,
          timedOut,
          processErrorLog,
        });
      };

      proc.on("error", (error: Error) => {
        processErrorLog = error.message;
        finish(null, false);
      });
      proc.on("close", (code: number | null) => finish(code, false));

      const timer = setTimeout(() => {
        try {
          if (proc.pid) process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        finish(null, true);
      }, limits.timeout_ms);
    });
    await logHandle.close();
    const capturedLog = await readCappedLogFile(logPath, limits.log_max_bytes);
    const logs = processErrorLog
      ? [capturedLog.logs, processErrorLog].filter((part) => part.length > 0).join("\n")
      : capturedLog.logs;

    const { rawOutputJson, outputTooLarge } = await readSandboxOutputJson(
      sandboxRoot,
      outputPath,
      limits.max_output_bytes,
    );

    return {
      status: "completed",
      exit_code: exitCode,
      timed_out: timedOut,
      logs: redactSecretPatterns(logs),
      logs_truncated: capturedLog.logsTruncated,
      raw_output_json: rawOutputJson,
      output_too_large: outputTooLarge,
      sandbox_files_root: filesRoot,
    };
  }
}

async function readCappedLogFile(
  logPath: string,
  maxLogBytes: number,
): Promise<{ logs: string; logsTruncated: boolean }> {
  const info = await lstat(logPath).catch(() => null);
  if (!info || !info.isFile()) return { logs: "", logsTruncated: false };

  const bytesToRead = Math.max(0, Math.min(info.size, maxLogBytes));
  if (bytesToRead === 0) {
    return { logs: "", logsTruncated: info.size > 0 };
  }

  const handle = await open(logPath, "r");
  try {
    const buf = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buf, 0, bytesToRead, 0);
    return {
      logs: trimIncompleteUtf8Tail(buf.subarray(0, bytesRead)).toString("utf8"),
      logsTruncated: info.size > maxLogBytes,
    };
  } finally {
    await handle.close();
  }
}

async function readSandboxOutputJson(
  sandboxRoot: string,
  outputPath: string,
  maxOutputBytes: number,
): Promise<{ rawOutputJson: string | null; outputTooLarge: boolean }> {
  // lstat before reading: an oversized output.json must never be loaded into
  // memory, and a symlink must be rejected rather than followed.
  const outputInfo = await lstat(outputPath).catch(() => null);
  if (!outputInfo || outputInfo.isSymbolicLink() || !outputInfo.isFile()) {
    return { rawOutputJson: null, outputTooLarge: false };
  }
  if (outputInfo.size > maxOutputBytes) {
    return { rawOutputJson: null, outputTooLarge: true };
  }
  const realSandboxRoot = await realpath(sandboxRoot).catch(() => resolve(sandboxRoot));
  const realOutputPath = await realpath(outputPath).catch(() => null);
  if (!realOutputPath || !isInsideRoot(realOutputPath, realSandboxRoot)) {
    return { rawOutputJson: null, outputTooLarge: false };
  }
  return {
    rawOutputJson: await readFile(outputPath, "utf8").catch(() => null),
    outputTooLarge: false,
  };
}

function isInsideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Drops a trailing incomplete UTF-8 multi-byte sequence, if the buffer was
 * cut mid-character. Without this, decoding a mid-sequence cut with
 * `.toString("utf8")` substitutes a 3-byte U+FFFD replacement character,
 * which can make the decoded string's byte length exceed the buffer's own
 * byte budget — defeating the point of a byte-count log cap.
 */
function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  const len = buf.length;
  for (let back = 1; back <= 3 && back <= len; back++) {
    const byte = buf[len - back]!;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue; // continuation byte; keep scanning back
    let sequenceLength = 1;
    if ((byte & 0b1110_0000) === 0b1100_0000) sequenceLength = 2;
    else if ((byte & 0b1111_0000) === 0b1110_0000) sequenceLength = 3;
    else if ((byte & 0b1111_1000) === 0b1111_0000) sequenceLength = 4;
    return sequenceLength > back ? buf.subarray(0, len - back) : buf;
  }
  return buf;
}

/** No ambient process.env — only what a Node child process strictly needs to run. */
function minimalHandlerEnv(sandboxRoot: string): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: "production",
    CUSTOM_SOURCE_SANDBOX_ROOT: sandboxRoot,
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

export async function cleanupSandbox(sandboxFilesRoot: string): Promise<void> {
  // sandbox_files_root is <sandboxRoot>/files; remove the parent sandbox dir.
  const sandboxRoot = resolve(sandboxFilesRoot, "..");
  await rm(sandboxRoot, { recursive: true, force: true });
}
