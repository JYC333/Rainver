import { describe, expect, it } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common";
import {
  defaultModelProviderForSpace,
  sourcePostProcessingExecutionRequest,
  validateSourcePostProcessingInputContextBinding,
} from "../src/modules/sources/postProcessing/service";
import {
  normalizeActions,
  normalizeInputConfig,
} from "../src/modules/sources/postProcessing/repository";

class FakeDb implements Queryable {
  constructor(private readonly rows: unknown[]) {}

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    expect(sql).toContain("FROM model_provider_space_grants");
    expect(sql).toContain("g.is_default = true");
    expect(sql).toContain("p.enabled = true");
    expect(params).toEqual(["space-1"]);
    return { rows: this.rows as Row[], rowCount: this.rows.length };
  }
}

describe("Source post-processing service", () => {
  it("resolves the space default model provider from provider grants", async () => {
    await expect(defaultModelProviderForSpace(new FakeDb([
      { id: "provider-1", default_model: "model-a" },
    ]), "space-1")).resolves.toEqual({ id: "provider-1", default_model: "model-a" });
  });

  it("returns null when the space has no enabled default provider grant", async () => {
    await expect(defaultModelProviderForSpace(new FakeDb([]), "space-1")).resolves.toBeNull();
  });

  it("rejects project retrieval context when the rule is not project-bound", () => {
    const inputConfig = normalizeInputConfig({
      retrieval_context: {
        enabled: true,
        domains: ["project"],
      },
    });
    expect(() =>
      validateSourcePostProcessingInputContextBinding(null, inputConfig, normalizeActions({ batch_digest: true })),
    ).toThrow(/Project context requires selecting a project/);
  });

  it("allows screening without a project only when the source has a relevance profile", () => {
    const actions = normalizeActions({ batch_digest: true, mark_items: true });
    expect(() =>
      validateSourcePostProcessingInputContextBinding(null, normalizeInputConfig({}), actions),
    ).toThrow(/requires a source-level relevance profile/);

    expect(() =>
      validateSourcePostProcessingInputContextBinding(
        null,
        normalizeInputConfig({
          relevance_profile: { enabled: true, objective: "Find agent-memory papers" },
        }),
        actions,
      ),
    ).not.toThrow();
  });

  it("executes post-processing agent runs without a jobs-table job id", () => {
    expect(sourcePostProcessingExecutionRequest("post-run-1", 120_000)).toEqual({
      worker_id: "source_post_processing:post-run-1",
      job_id: null,
      command_source: "internal",
      timeout_ms: 120_000,
    });
    expect(sourcePostProcessingExecutionRequest("post-run-2")).toEqual({
      worker_id: "source_post_processing:post-run-2",
      job_id: null,
      command_source: "internal",
    });
  });

});
