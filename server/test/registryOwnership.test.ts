import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import {
  actionNodeHandlerRegistry,
  type ActionNodeHandler,
} from "../src/modules/automations/actionNodeRegistry.js";
import {
  automationTargetHandlerRegistry,
  type AutomationTargetHandler,
} from "../src/modules/automations/targetRegistry.js";
import {
  workflowExecutionOutcomeHandlerRegistry,
  type WorkflowExecutionOutcomeHandler,
} from "../src/modules/automations/workflowExecutionOutcomeRegistry.js";
import {
  autonomyDiscovererRegistry,
  type AutonomyDiscoverer,
} from "../src/modules/autonomy/registry.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
} from "../src/modules/projects/attentionRegistry.js";
import { runFinalizationReconcilerRegistry } from "../src/modules/runs/finalizationReconcilerRegistry.js";
import { sourceConnectorRegistry } from "../src/modules/sources/catalog/sourceConnectorRegistry.js";

const actionHandler: ActionNodeHandler = async () => ({ output: {} });
const automationHandler: AutomationTargetHandler = {
  preflight: async () => ({}),
  execute: async () => ({}),
};
const outcomeHandler: WorkflowExecutionOutcomeHandler = async () => {};
const discoverer: AutonomyDiscoverer = {
  discover: async () => [],
  buildLaunch: () => ({ capabilityId: "test", capabilities: [], prompt: "", instruction: "" }),
  buildReport: () => ({ artifactType: "test", title: "test", fallbackContent: "" }),
};
const reconciler = { reconcile: async () => {} };

function resetOwnedRegistries(): void {
  actionNodeHandlerRegistry.__resetForTests();
  automationTargetHandlerRegistry.__resetForTests();
  workflowExecutionOutcomeHandlerRegistry.__resetForTests();
  autonomyDiscovererRegistry.__resetForTests();
  runFinalizationReconcilerRegistry.__resetForTests();
  projectAttentionRegistry.__resetForTests();
}

function registrySnapshot() {
  return {
    actionNodes: [...actionNodeHandlerRegistry.registeredKeys()].sort(),
    automationTargets: [...automationTargetHandlerRegistry.registeredTypes()].sort(),
    workflowOutcomes: [...workflowExecutionOutcomeHandlerRegistry.registeredKeys()].sort(),
    autonomyDiscoverers: autonomyDiscovererRegistry.entries().map(([kind]) => kind).sort(),
    runFinalizers: [...runFinalizationReconcilerRegistry.registeredKeys()].sort(),
  };
}

beforeEach(resetOwnedRegistries);
afterEach(resetOwnedRegistries);

describe("owned contribution registries", () => {
  it("allows same-owner re-registration and rejects a different owner with the existing owner named", () => {
    actionNodeHandlerRegistry.register("test.action", actionHandler, "first");
    actionNodeHandlerRegistry.register("test.action", actionHandler, "first");
    expect(() => actionNodeHandlerRegistry.register("test.action", actionHandler, "second"))
      .toThrow("test.action is already registered by first");

    automationTargetHandlerRegistry.register("agent_run", automationHandler, "first");
    automationTargetHandlerRegistry.register("agent_run", automationHandler, "first");
    expect(() => automationTargetHandlerRegistry.register("agent_run", automationHandler, "second"))
      .toThrow("agent_run is already registered by first");

    workflowExecutionOutcomeHandlerRegistry.register("test.workflow", outcomeHandler, "first");
    workflowExecutionOutcomeHandlerRegistry.register("test.workflow", outcomeHandler, "first");
    expect(() => workflowExecutionOutcomeHandlerRegistry.register("test.workflow", outcomeHandler, "second"))
      .toThrow("test.workflow is already registered by first");

    autonomyDiscovererRegistry.register("periodic_digest", discoverer, "first");
    autonomyDiscovererRegistry.register("periodic_digest", discoverer, "first");
    expect(() => autonomyDiscovererRegistry.register("periodic_digest", discoverer, "second"))
      .toThrow("periodic_digest is already registered by first");

    runFinalizationReconcilerRegistry.register("test.finalizer", reconciler, "first");
    runFinalizationReconcilerRegistry.register("test.finalizer", reconciler, "first");
    expect(() => runFinalizationReconcilerRegistry.register("test.finalizer", reconciler, "second"))
      .toThrow("test.finalizer is already registered by first");
  });

  it("replaces project attention adapters deliberately by area kind", () => {
    const first: ProjectAttentionAdapter = { areaKind: "test", listAttentionItems: async () => [] };
    const replacement: ProjectAttentionAdapter = { areaKind: "test", listAttentionItems: async () => [] };
    projectAttentionRegistry.replace(first);
    projectAttentionRegistry.replace(replacement);
    expect(projectAttentionRegistry.list()).toEqual([replacement]);
  });

  it("re-registers the same module owners across two app builds without registry drift", async () => {
    const firstApp = buildServer(loadConfig({}), { logger: false });
    const afterFirstBuild = registrySnapshot();
    expect(afterFirstBuild.actionNodes).toEqual(expect.arrayContaining([
      "project_research.apply_stage_run",
      "project_research.materialize_report",
      "project_research.reconcile_pass",
    ]));
    expect(sourceConnectorRegistry.get("arxiv_api").connectorKey).toBe("arxiv_api");

    const secondApp = buildServer(loadConfig({}), { logger: false });
    expect(registrySnapshot()).toEqual(afterFirstBuild);

    await firstApp.close();
    await secondApp.close();
  });
});
