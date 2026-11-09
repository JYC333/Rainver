import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { HostUsageQuota, RuntimeStateBoundary } from "@rainver/protocol";
import { helperProcessEnv } from "./providerBinding.js";
import { killProcessGroup, settleProcessGroup } from "./processGroup.js";
import { terminalAuthAvailable, ptyArgv, terminalShellCommand } from "./terminalAuth.js";

// Native quota input: https://antigravity.google/docs/cli/statusline/
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const empty = (error: string | null): HostUsageQuota => ({
  available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error,
});
function remaining(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? (1 - v) * 100 : null;
}
function reset(v: unknown): string | null {
  const value = text(v);
  return value && Number.isFinite(Date.parse(value)) ? `Resets ${new Date(value).toISOString()}` : null;
}

const NATIVE_QUOTA_LABELS: ReadonlyMap<string, string> = new Map([
  ["3p-5h", "Claude / GPT · 5 hours"],
  ["3p-weekly", "Claude / GPT · Weekly"],
  ["gemini-5h", "Gemini · 5 hours"],
  ["gemini-weekly", "Gemini · Weekly"],
  ["gemini-argon-wtu-weekly", "Gemini 4 Argon · Weekly"],
]);

export function parseAntigravityQuota(value: unknown): HostUsageQuota {
  const root = record(value);
  const payload = record(root?.response) ?? record(root?.summary) ?? root;
  const windows: NonNullable<HostUsageQuota["windows"]> = [];
  const cadences = new Map<string, string>();
  if (Array.isArray(payload?.groups)) {
    for (const groupValue of payload.groups) {
      const group = record(groupValue);
      if (!Array.isArray(group?.buckets)) continue;
      for (const bucketValue of group.buckets) {
        const bucket = record(bucketValue);
        if (!bucket || bucket.disabled === true) continue;
        const id = text(bucket.bucketId) ?? text(bucket.id);
        if (!id || windows.some(w => w.id === id)) continue;
        const used = remaining(bucket.remainingFraction ?? record(bucket.remaining)?.remainingFraction);
        windows.push({
          id: id.slice(0, 256),
          label: NATIVE_QUOTA_LABELS.get(id) ?? `${text(group.displayName) ?? text(group.name) ?? "Quota"} · ${(text(bucket.displayName) ?? text(bucket.name) ?? id).replace(/\s+remaining$/i, "")}`.slice(0, 256),
          used_pct: used, resets: reset(bucket.resetTime),
        });
        cadences.set(id.slice(0, 256), text(bucket.window) ?? id);
      }
    }
  }
  const result = empty(null);
  result.windows = windows.slice(0, 64);
  result.available = result.windows.some(w => w.used_pct !== null);
  // Aggregate only explicit cadences; model buckets are not assumed to be weekly.
  for (const window of result.windows) {
    if (window.used_pct === null) continue;
    const cadence = cadences.get(window.id) ?? "";
    if (/weekly|seven.day/i.test(cadence) && window.used_pct >= (result.week_pct ?? -1)) {
      result.week_pct = window.used_pct; result.week_resets = window.resets;
    } else if (/5h|five.hour/i.test(cadence) && window.used_pct >= (result.session_pct ?? -1)) {
      result.session_pct = window.used_pct; result.session_resets = window.resets;
    }
  }
  return result;
}

/** Read the selected CLI's documented statusLine JSON without a prompt or model request. */
export async function probeAntigravity(
  home: string,
  state: RuntimeStateBoundary | null,
  seconds: number,
  executable = "agy",
  entryArgs: string[] = [],
): Promise<HostUsageQuota> {
  try {
    await access(join(home, state?.home_subdir ?? ".gemini/antigravity-cli", state?.credential_file ?? "antigravity-oauth-token"));
  } catch {
    return empty("Log in to this Antigravity CLI copy before reading usage.");
  }
  if (!terminalAuthAvailable()) return empty("Antigravity native quota inspection requires the script(1) terminal utility on this Host.");
  const scratch = await mkdtemp(join(tmpdir(), "rainver-antigravity-quota-"));
  const destination = join(scratch, "quota.json");
  const capture = join(scratch, "capture.mjs");
  await writeFile(capture, STATUSLINE_CAPTURE, { mode: 0o600, flag: "wx" });
  const settings = { statusLine: { type: "command", command: terminalShellCommand([process.execPath, capture, destination]) } };
  const pty = ptyArgv([executable, ...entryArgs, "--settings", JSON.stringify(settings), "--log-file", join(scratch, "native.log")]);
  const child = spawn(pty.command, pty.args, {
    cwd: scratch,
    env: { ...helperProcessEnv(process.env, "acp_antigravity_acp"), HOME: home, TERM: "xterm-256color", AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    stdio: ["pipe", "ignore", "ignore"], detached: true,
  });
  let closed = false;
  let failed = false;
  const drained = new Promise<void>(resolve => {
    child.once("error", () => { failed = true; });
    child.once("close", () => { closed = true; resolve(); });
  });
  child.stdin?.on("error", () => {});
  const deadline = Date.now() + Math.max(1, seconds) * 1000;
  try {
    while (Date.now() < deadline) {
      try {
        const buckets: unknown = JSON.parse(await readFile(destination, "utf8"));
        const quota = parseAntigravityQuota({ groups: [{ displayName: "Antigravity", buckets }] });
        if (quota.available) return quota;
      } catch { /* The native CLI has not published a measured quota yet. */ }
      if (closed) break;
      await delay(100);
    }
    return empty(failed ? "Antigravity native quota inspection could not start." : "Antigravity CLI did not report measured quota before the check ended. Login status does not establish remaining capacity.");
  } finally {
    if (!closed) killProcessGroup(child, "SIGTERM");
    await Promise.race([drained, delay(3000)]);
    if (!closed) killProcessGroup(child, "SIGKILL");
    await drained;
    await settleProcessGroup(child.pid, () => {}, { graceMs: 1000 });
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Only quota measurements leave the native status line; account and session fields are discarded. */
const STATUSLINE_CAPTURE = String.raw`
import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Native status line input exceeds its limit");
}
const payload = JSON.parse(input);
const buckets = Object.entries(payload.quota ?? {}).filter(([id]) => /^[a-z0-9_.-]{1,128}$/i.test(id)).slice(0, 64).map(([id, value]) => ({
  bucketId: id, window: id,
  remainingFraction: typeof value?.remaining_fraction === "number" ? value.remaining_fraction : undefined,
  resetTime: typeof value?.reset_time === "string" && Number.isFinite(Date.parse(value.reset_time)) ? new Date(value.reset_time).toISOString() : undefined,
  disabled: value?.disabled === true,
}));
const destination = process.argv[2];
const temporary = destination + "." + randomUUID() + ".tmp";
await writeFile(temporary, JSON.stringify(buckets), { mode: 0o600, flag: "wx" });
await rename(temporary, destination);
`;
