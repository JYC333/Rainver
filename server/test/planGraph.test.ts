import { describe, expect, it } from "vitest";
import {
  PlanGraphError,
  decidePlanApproval,
  evaluatePlanAtomicity,
  materializePlanGraph,
} from "../src/modules/plans/graph.js";
import { verifyIntegrationNode } from "../src/modules/plans/integrationVerification.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

function definition(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "workflow_definition.v1",
    workflow_id: "agent-plan-1",
    name: "Agent plan",
    description: "A bounded agent-generated plan",
    input_schema_json: {},
    output_artifact_types: [],
    metadata_json: {
      primary_objective: "Complete the requested work.",
      scope_json: { inputs: ["task context"] },
    },
    nodes: [
      {
        id: "work",
        title: "Do the work",
        depends_on: [],
        capability_id: "work",
        contract_json: { risk_level: "low", max_attempts: 1 },
        metadata_json: { runtime_delegation_allowed: false },
        verification_recipe_refs: ["output-check"],
      },
      {
        id: "integrate",
        title: "Integrate result",
        depends_on: ["work"],
        contract_json: { risk_level: "low" },
        metadata_json: { node_kind: "integration" },
      },
    ],
    ...overrides,
  };
}

describe("agent plan graph", () => {
  it("materializes and validates the execution graph", async () => {
    const graph = await materializePlanGraph(definition());
    expect(graph.roots).toEqual(["work"]);
    expect(graph.leaves).toEqual(["integrate"]);
    expect(graph.depth).toBe(2);
    expect(graph.nodes[1]?.kind).toBe("integration");
  });

  it("rejects unknown dependencies, duplicate ids, cycles, and excessive depth", async () => {
    await expect(materializePlanGraph(definition({
      nodes: [{ ...definition().nodes[0], depends_on: ["missing"] }],
    }))).rejects.toThrow();
    await expect(materializePlanGraph(definition({
      nodes: [definition().nodes[0], { ...definition().nodes[1], id: "work" }],
    }))).rejects.toThrow();
    await expect(materializePlanGraph(definition({
      nodes: [
        { ...definition().nodes[0], depends_on: ["integrate"] },
        definition().nodes[1],
      ],
    }))).rejects.toThrow();
    const nodes = Array.from({ length: 4 }, (_, index) => ({
      id: `layer-${index}`,
      title: `Layer ${index}`,
      depends_on: index === 0 ? [] : [`layer-${index - 1}`],
      capability_id: `capability-${index}`,
      contract_json: { risk_level: "low", max_attempts: 1 },
      metadata_json: { runtime_delegation_allowed: false },
      verification_recipe_refs: ["output-check"],
    }));
    await expect(materializePlanGraph(definition({ nodes }))).rejects.toThrowError(PlanGraphError);
  });

  it("requires review when the plan is not safely auto-approvable", async () => {
    const graph = await materializePlanGraph(definition({
      metadata_json: {},
      nodes: [{
        id: "work",
        title: "Work",
        depends_on: [],
        capability_id: "work",
        contract_json: { risk_level: "high" },
        metadata_json: {},
      }],
    }));
    const decision = decidePlanApproval(graph, { budgetCap: null });
    expect(decision.mode).toBe("proposal_required");
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "budget_cap_not_declared",
      "node_work_risk_is_high",
      "primary_objective_not_declared",
      "execution_scope_not_declared",
    ]));
    expect(evaluatePlanAtomicity(graph).valid).toBe(false);
  });

  it("uses the total node count for the auto-approval cap", async () => {
    const nodes = Array.from({ length: 9 }, (_, index) => ({
      id: `node-${index}`,
      title: `Node ${index}`,
      depends_on: [],
      capability_id: `capability-${index}`,
      contract_json: { risk_level: "low", max_attempts: 1 },
      metadata_json: { runtime_delegation_allowed: false },
      verification_recipe_refs: ["output-check"],
    }));
    const graph = await materializePlanGraph(definition({ nodes }));
    expect(decidePlanApproval(graph, { budgetCap: 100 }).reasons).toContain("node_count_exceeds_cap");
  });
});

describe("integration node verification", () => {
  function dependencyRows(rows: Array<Record<string, unknown>>): Queryable {
    return {
      async query() {
        return { rows: rows.map((row) => ({
          run_id: null, outcome_status: null, output_json: null, required_outputs_json: null,
          verification_passed: false, verification_count: 0, ...row,
        })), rowCount: rows.length } as never;
      },
    };
  }

  it("accepts a done approval checkpoint or integration dependency, which never has a Run", async () => {
    // A -> checkpoint -> integration is a valid graph; the root verification
    // already exempts these kinds, and an integration node failing on them
    // failed the whole Plan after every piece of work had succeeded.
    const client = dependencyRows([
      { node_id: "checkpoint", node_key: "checkpoint", node_kind: "approval_checkpoint", status: "done" },
      { node_id: "merge", node_key: "merge", node_kind: "integration", status: "done" },
    ]);
    await expect(verifyIntegrationNode(client, "space-1", "final", ["checkpoint", "merge"]))
      .resolves.toMatchObject({ status: "passed" });
  });

  it("still fails a checkpoint dependency that is not done", async () => {
    const client = dependencyRows([
      { node_id: "checkpoint", node_key: "checkpoint", node_kind: "approval_checkpoint", status: "waiting_for_review" },
    ]);
    await expect(verifyIntegrationNode(client, "space-1", "final", ["checkpoint"]))
      .resolves.toMatchObject({ status: "failed" });
  });
});
