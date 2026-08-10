import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  LocalCliConformanceProbeRunner,
  type LocalCliConformanceProbeRunnerDeps,
} from "../src/modules/runtimeConformance";
import type { CliExecutionResult } from "../src/modules/runs/localCliExecution";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalCliConformanceProbeRunner", () => {
  it("runs the structured-output and credential-leakage probes through the executor boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-conformance-"));
    roots.push(root);
    const executor = {
      async runCommand(input: { command: string[]; cwd: string | null }): Promise<CliExecutionResult> {
        expect(input.cwd).toContain(join(root, "sandboxes", "conformance"));
        return {
          returncode: 0,
          stdout: '{"result":"PASS"}\n',
          stderr: "",
          timed_out: false,
        };
      },
    };
    const deps: LocalCliConformanceProbeRunnerDeps = {
      executor,
      toolRegistry: {
        async resolveForExecution(runtime) {
          return {
            runtime,
            executable_path: join(root, "runtime-tools", "opencode"),
            version: "1.0.0",
            source: "npm",
            package_name: "opencode-ai",
          };
        },
      },
      credentialBroker: {
        async grantForRun(runId, spaceId, runtime, executorMode) {
          expect(runId).toContain("conformance-");
          expect(spaceId).toBe("space-1");
          expect(runtime).toBe("opencode");
          expect(executorMode).toBe("worktree");
          return {
            granted: true,
            profile_id: "profile-1",
            runtime,
            executor_mode: executorMode,
            readonly: true,
            temp_home: null,
            host_source_path: null,
            target_path: null,
            env: {},
            network_profile_id: null,
            fallback_reason: null,
          };
        },
        async cleanupRunHome() {},
      },
    };
    const runner = new LocalCliConformanceProbeRunner(
      loadConfig({ AGENT_SPACE_HOME: root }),
      { spaceId: "space-1", userId: "user-1" },
      deps,
    );
    const context = {
      runtime_adapter_type: "opencode",
      runtime_version: "1.0.0",
      suite_version: "runtime_conformance.v1",
    } as const;

    await expect(runner.runCheck("structured_output_compliance", context)).resolves.toMatchObject({ passed: true });
    await expect(runner.runCheck("credential_leakage", context)).resolves.toMatchObject({ passed: true });
  });
});
