import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { customSourcePolicyEnvelope, runnerSettings } from "./support/customSourceFixtures.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCustomSourceHandler } from "../src/modules/sources/customSources/customSourceHandlerExecution.js";
import type { HandlerVersionRow } from "../src/modules/sources/customSources/customSourceHandlerRepository.js";
import {
  effectiveSourceExecutionLimits,
  evaluateCustomSourceExecutionBlockReason,
} from "../src/modules/sources/sourceExecutionPolicy.js";

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

describe("Source execution policy", () => {
  beforeEach(() => {
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("Removed handler languages must not spawn a process");
    });
    syncBuiltinESMExports();
  });

  afterEach(() => {
    try {
      expect(childProcess.spawn).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it("fails closed when instance execution is disabled", () => {
    expect(evaluateCustomSourceExecutionBlockReason(enabledSettings({ runner_enabled: false }), POLICY_ENVELOPE))
      .toBe("runner_disabled");
  });

  it("fails closed for a language outside the instance allowlist", () => {
    expect(evaluateCustomSourceExecutionBlockReason(enabledSettings({ allowed_languages: [] }), POLICY_ENVELOPE))
      .toBe("language_not_allowed");
  });

  it("refuses browser automation regardless of instance availability", () => {
    expect(evaluateCustomSourceExecutionBlockReason(enabledSettings({ browser_automation_available: true }), {
      ...POLICY_ENVELOPE, browser_automation_enabled: true,
    })).toBe("browser_automation_requested");
  });

  it("refuses shell access regardless of instance availability", () => {
    expect(evaluateCustomSourceExecutionBlockReason(enabledSettings({ shell_available: true }), {
      ...POLICY_ENVELOPE, shell_enabled: true,
    })).toBe("shell_requested");
  });

  it("refuses dependency installation regardless of instance availability", () => {
    expect(evaluateCustomSourceExecutionBlockReason(enabledSettings({ dependency_installation_available: true }), {
      ...POLICY_ENVELOPE, dependency_installation_enabled: true,
    })).toBe("dependency_installation_requested");
  });

  it("leaves declarative evaluation available only to its owning interpreter", () => {
    expect(evaluateCustomSourceExecutionBlockReason(
      enabledSettings({ allowed_languages: ["declarative_pipeline_v1"] }),
      customSourcePolicyEnvelope({ language: "declarative_pipeline_v1" }),
    )).toBeNull();
    expect(evaluateCustomSourceExecutionBlockReason(enabledSettings(), POLICY_ENVELOPE))
      .toBe("handler_language_removed");
  });

  it("blocks shared legacy dispatch before requiring an artifact or pipeline manifest", async () => {
    const version: HandlerVersionRow = {
      id: "handler-1", space_id: "space-1", source_connection_id: "conn-1",
      version_number: 1, language: "typescript_node", entrypoint: "handler.cjs",
      handler_artifact_id: null, manifest_json: null,
      input_schema_json: null, output_schema_json: null,
      policy_envelope_json: POLICY_ENVELOPE, requested_capabilities_json: [],
      checksum: "legacy-checksum", status: "active", created_by_user_id: "user-1",
      created_by_run_id: null, proposal_id: null, test_result_json: null,
      created_at: "2026-10-29T00:00:00Z", activated_at: null, superseded_at: null,
    };
    await expect(executeCustomSourceHandler(enabledSettings(), {
      version, policyEnvelope: POLICY_ENVELOPE, handlerInput: HANDLER_INPUT,
    })).resolves.toEqual({ status: "blocked", reason: "handler_language_removed" });
  });

  it("keeps policy budgets bounded by instance limits for the supported execution paths", () => {
    const policy = customSourcePolicyEnvelope({ limits: {
      timeout_ms: 10_000, max_download_bytes: 2_000, max_output_bytes: 3_000,
      max_files: 20, log_max_bytes: 4_000, max_items: 7, max_evidence_items: 9,
    } }).limits;
    expect(effectiveSourceExecutionLimits(enabledSettings({
      timeout_ms_max: 300, download_bytes_max: 1_000, output_bytes_max: 2_000,
      max_files: 10, log_bytes_max: 1_500,
    }), policy)).toEqual({
      ...policy, timeout_ms: 300, max_download_bytes: 1_000,
      max_output_bytes: 2_000, max_files: 10, log_max_bytes: 1_500,
    });
    expect(effectiveSourceExecutionLimits(enabledSettings(), policy)).toEqual(policy);
  });
});
