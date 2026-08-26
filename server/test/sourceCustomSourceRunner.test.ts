import { readFile } from "node:fs/promises";
import { customSourcePolicyEnvelope, runnerSettings } from "./support/customSourceFixtures.js";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CustomSourcePolicyEnvelope } from "@agent-space/protocol";
import {
  CustomSourceRunner,
  cleanupSandbox,
  type CustomSourceRunnerSettings,
  type CustomSourceRunnerCompletedResult,
} from "../src/modules/sources/customSources/customSourceRunner.js";

const FIXTURES_DIR = join(process.cwd(), "test/fixtures/customSourceHandlers");

const POLICY_ENVELOPE = customSourcePolicyEnvelope({ limits: { timeout_ms: 3000, max_items: 5, max_evidence_items: 10 } });

const HANDLER_INPUT = {
  contract_version: "custom_source.handler_input.v1" as const,
  run: {
    mode: "scan" as const,
    job_id: "job-1",
    connection_id: "conn-1",
    handler_version_id: "handler-1",
    started_at: new Date().toISOString(),
  },
  source: { name: "Example Feed", config: {} },
  policy: {
    allowed_network_origins: [],
    capture_policy: "extract_text" as const,
    retention_policy: "full_text" as const,
    limits: POLICY_ENVELOPE.limits,
  },
};

const enabledSettings = runnerSettings;

async function runFixture(
  fixtureFile: string,
  settings: CustomSourceRunnerSettings,
  policyOverrides: Partial<CustomSourcePolicyEnvelope> = {},
) {
  const runner = new CustomSourceRunner(settings);
  return runner.run({
    policyEnvelope: { ...POLICY_ENVELOPE, ...policyOverrides },
    handlerInput: HANDLER_INPUT,
    handlerEntrypointPath: join(FIXTURES_DIR, fixtureFile),
  });
}

describe("CustomSourceRunner", () => {
  it("fails closed when the instance runner is disabled — no process is spawned", async () => {
    const result = await runFixture("writesValidOutput.js", enabledSettings({ runner_enabled: false }));
    expect(result).toEqual({ status: "blocked", reason: "runner_disabled" });
  });

  it("fails closed for a language outside the instance allowlist", async () => {
    const result = await runFixture(
      "writesValidOutput.js",
      enabledSettings({ allowed_languages: ["python"] }),
    );
    expect(result).toEqual({ status: "blocked", reason: "language_not_allowed" });
  });

  it("fails closed when the policy envelope requests browser automation, regardless of instance flags", async () => {
    const result = await runFixture("writesValidOutput.js", enabledSettings({ browser_automation_available: true }), {
      browser_automation_enabled: true,
    });
    expect(result).toEqual({ status: "blocked", reason: "browser_automation_requested" });
  });

  it("fails closed when the policy envelope requests shell access", async () => {
    const result = await runFixture("writesValidOutput.js", enabledSettings(), { shell_enabled: true });
    expect(result).toEqual({ status: "blocked", reason: "shell_requested" });
  });

  it("fails closed when the policy envelope requests dependency installation", async () => {
    const result = await runFixture("writesValidOutput.js", enabledSettings(), { dependency_installation_enabled: true });
    expect(result).toEqual({ status: "blocked", reason: "dependency_installation_requested" });
  });

  it("runs an allowed handler in a separate process, in a temp sandbox, and captures its output.json", async () => {
    const result = (await runFixture("writesValidOutput.js", enabledSettings())) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.logs).toContain("handler saw connection Example Feed");
    expect(result.raw_output_json).not.toBeNull();
    const parsed = JSON.parse(result.raw_output_json!);
    expect(parsed.contract_version).toBe("custom_source.handler_output.v1");
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("kills a handler that exceeds its timeout and reports timed_out", async () => {
    const result = (await runFixture(
      "timesOut.js",
      enabledSettings(),
      { limits: { ...POLICY_ENVELOPE.limits, timeout_ms: 300 } },
    )) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.timed_out).toBe(true);
    await cleanupSandbox(result.sandbox_files_root);
  }, 10_000);

  it("reports a non-zero exit code and captures stderr without crashing the caller", async () => {
    const result = (await runFixture("exitsNonZero.js", enabledSettings())) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.exit_code).toBe(7);
    expect(result.logs).toContain("handler failed deliberately");
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("caps captured logs at the policy log_max_bytes limit", async () => {
    const result = (await runFixture(
      "writesLotsOfLogs.js",
      enabledSettings(),
      { limits: { ...POLICY_ENVELOPE.limits, log_max_bytes: 1000 } },
    )) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.logs_truncated).toBe(true);
    expect(Buffer.byteLength(result.logs, "utf8")).toBeLessThanOrEqual(1000);
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("caps multi-byte UTF-8 logs at the byte budget without crashing on a mid-character cut", async () => {
    const result = (await runFixture(
      "writesMultibyteLogs.js",
      enabledSettings(),
      { limits: { ...POLICY_ENVELOPE.limits, log_max_bytes: 1001 } },
    )) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.logs_truncated).toBe(true);
    expect(Buffer.byteLength(result.logs, "utf8")).toBeLessThanOrEqual(1001);
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("redacts secret-shaped strings in captured logs and returns null output.json when the handler writes none", async () => {
    const result = (await runFixture(
      "leaksSecretAndNoOutput.js",
      enabledSettings(),
    )) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.logs).not.toContain("sk-abcdefghijklmnop123456");
    expect(result.logs).toContain("[REDACTED_SECRET]");
    expect(result.raw_output_json).toBeNull();
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("blocks a handler's attempt to make an HTTP request or call fetch", async () => {
    const result = (await runFixture("attemptsNetwork.js", enabledSettings())) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.logs).toContain("http-blocked:");
    expect(result.logs).toContain("fetch-blocked:");
    expect(result.logs).not.toContain("succeeded");
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("blocks a handler's attempt to spawn a child process or a worker thread", async () => {
    const result = (await runFixture("attemptsProcessSpawn.js", enabledSettings())) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.logs).toContain("spawn-blocked:");
    expect(result.logs).toContain("worker-blocked:");
    expect(result.logs).not.toContain("succeeded");
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("restricts handler filesystem access to input.json, output.json, and sandbox files/", async () => {
    const result = (await runFixture("attemptsFilesystemEscape.js", enabledSettings())) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.exit_code).toBe(0);
    expect(result.logs).toContain("input-read:Example Feed");
    expect(result.logs).toContain("outside-read-blocked:");
    expect(result.logs).toContain("outside-write-blocked:");
    expect(result.logs).not.toContain("outside-read-succeeded");
    expect(result.logs).not.toContain("outside-write-succeeded");
    await expect(readFile(join(result.sandbox_files_root, "allowed.txt"), "utf8")).resolves.toBe("ok");
    expect(result.raw_output_json).not.toBeNull();
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("blocks handler-created symlinks instead of treating them as output.json", async () => {
    const result = (await runFixture("attemptsOutputSymlink.js", enabledSettings())) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.logs).toContain("symlink-blocked:");
    expect(result.logs).not.toContain("symlink-succeeded");
    expect(result.output_too_large).toBe(false);
    expect(result.raw_output_json).toBeNull();
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("does not read an output.json larger than the effective max_output_bytes into memory", async () => {
    const result = (await runFixture(
      "writesOversizedOutput.js",
      enabledSettings(),
      { limits: { ...POLICY_ENVELOPE.limits, max_output_bytes: 1000 } },
    )) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.output_too_large).toBe(true);
    expect(result.raw_output_json).toBeNull();
    await cleanupSandbox(result.sandbox_files_root);
  });

  it("clamps a policy envelope's limits to the instance hard limits (instance wins)", async () => {
    // timesOut.js never exits on its own; the policy asks for a 10s timeout,
    // but the instance hard limit is 300ms, so the instance limit must apply.
    const result = (await runFixture(
      "timesOut.js",
      enabledSettings({ timeout_ms_max: 300 }),
      { limits: { ...POLICY_ENVELOPE.limits, timeout_ms: 10_000 } },
    )) as CustomSourceRunnerCompletedResult;
    expect(result.status).toBe("completed");
    expect(result.timed_out).toBe(true);
    await cleanupSandbox(result.sandbox_files_root);
  }, 10_000);

  it("does not inherit ambient process.env into the handler process", async () => {
    process.env.CUSTOM_SOURCE_TEST_SECRET = "should-not-leak";
    try {
      const result = (await runFixture("printsEnvVar.js", enabledSettings())) as CustomSourceRunnerCompletedResult;
      expect(result.logs).toContain("env-secret:absent");
      expect(result.logs).not.toContain("should-not-leak");
      await cleanupSandbox(result.sandbox_files_root);
    } finally {
      delete process.env.CUSTOM_SOURCE_TEST_SECRET;
    }
  });
});
