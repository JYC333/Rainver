import { describe, expect, it } from "vitest";
import { InputBindingResolutionError, resolveNodeInputs } from "../src/modules/execution/nodeInputResolver";

describe("node input resolver", () => {
  it("resolves passed text, JSON pointer, and artifact inputs", async () => {
    const db = {
      async query<Row>(sql: string) {
        if (sql.includes("FROM artifacts")) return { rows: [{ id: "artifact-1" }] as Row[], rowCount: 1 };
        return { rows: [{
          node_id: "node-1",
          run_id: "run-1",
          output_json: {
            schema_version: "run_output.v1",
            status: "succeeded",
            summary: "done",
            result: { result: { value: 42 } },
            output_manifest: [],
          },
        }] as Row[], rowCount: 1 };
      },
    };
    const result = await resolveNodeInputs(db, {
      spaceId: "space-1",
      bindings: [
        { name: "summary", from_node: "source", source: "output_text", required: true },
        { name: "value", from_node: "source", source: "output_json", json_pointer: "/result/value", required: true },
        { name: "report", from_node: "source", source: "artifact", artifact_type: "report", required: true },
      ],
      sourceTable: "plan_nodes",
      linkTable: "plan_node_runs",
      linkNodeColumn: "plan_node_id",
      scopeColumn: "plan_version_id",
      scopeId: "version-1",
    });
    expect(result.values).toEqual({ summary: "done", value: 42, report: { artifact_id: "artifact-1", artifact_type: "report" } });
    expect(result.contextArtifactIds).toEqual(["artifact-1"]);
  });

  it("fails closed for a missing required input and records optional absence", async () => {
    const db = { async query<Row>() { return { rows: [] as Row[], rowCount: 0 }; } };
    const common = {
      spaceId: "space-1",
      sourceTable: "plan_nodes" as const,
      linkTable: "plan_node_runs" as const,
      linkNodeColumn: "plan_node_id" as const,
      scopeColumn: "plan_version_id" as const,
      scopeId: "version-1",
    };
    await expect(resolveNodeInputs(db, { ...common, bindings: [{ name: "required", from_node: "source", source: "output_text", required: true }] }))
      .rejects.toBeInstanceOf(InputBindingResolutionError);
    const optional = await resolveNodeInputs(db, { ...common, bindings: [{ name: "optional", from_node: "source", source: "output_text", required: false }] });
    expect(optional.bindings[0]?.missing_reason).toBe("passed_source_run_missing");
  });
});
