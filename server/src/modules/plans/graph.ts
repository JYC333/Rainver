import type { WorkflowDefinition, WorkflowNode, WorkflowNodeInputBinding } from "@rainver/protocol";
import * as protocol from "@rainver/protocol";
import { sha256Json } from "../evolution/hash.js";
import { resolveBudgetSources, type RunBudgetSource } from "../runs/contractSnapshot.js";

export const PLAN_GRAPH_VERSION = "plan_graph.v1" as const;
export const PLAN_GRAPH_LIMITS = {
  maxNodes: 30,
  maxAutoApproveNodes: 8,
  /** @deprecated Use maxAutoApproveNodes; the cap applies to total nodes. */
  maxInitialNodes: 8,
  // Keep decomposition bounded to three execution layers. A deeper graph is
  // difficult to review and makes budget/verification ownership ambiguous.
  maxDepth: 3,
} as const;

export type PlanNodeKind = "leaf" | "integration" | "approval_checkpoint" | "exploratory" | "action";
export type PlanApprovalMode = "auto_approved" | "proposal_required";

export interface PlanNodeRecord {
  key: string;
  title: string;
  description: string | null;
  dependsOn: string[];
  inputBindings: WorkflowNodeInputBinding[];
  kind: PlanNodeKind;
  agentId: string | null;
  runtimeProfileId: string | null;
  capabilityId: string | null;
  promptAssetKey: string | null;
  verificationRecipeRefs: string[];
  approvalRequired: boolean;
  approvalProposalType: string | null;
  /** Deterministic-handler dispatch key for `kind: "action"` nodes (`metadata_json.action_key`); null otherwise. */
  actionKey: string | null;
  /** Sub-classification for `kind: "approval_checkpoint"` nodes (`metadata_json.checkpoint_kind`), e.g. "screening_review", "idea_review". */
  checkpointKind: string | null;
  contractJson: Record<string, unknown>;
  metadataJson: Record<string, unknown>;
}

export interface MaterializedPlanGraph {
  graphVersion: typeof PLAN_GRAPH_VERSION;
  definition: WorkflowDefinition;
  nodes: PlanNodeRecord[];
  depth: number;
  roots: string[];
  leaves: string[];
}

export interface PlanApprovalDecision {
  mode: PlanApprovalMode;
  reasons: string[];
  aggregateMaxCost: number | null;
}

export interface PlanAtomicityEvaluation {
  valid: boolean;
  reasons: string[];
}

export async function materializePlanGraph(input: unknown): Promise<MaterializedPlanGraph> {
  const definition = protocol.WorkflowDefinitionSchema.parse(unwrapStoredGraph(input));
  if (definition.nodes.length > PLAN_GRAPH_LIMITS.maxNodes) {
    throw new PlanGraphError(`Plan contains more than ${PLAN_GRAPH_LIMITS.maxNodes} nodes`, "plan_size_exceeded");
  }

  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const depthById = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new PlanGraphError("Plan graph contains a dependency cycle", "plan_cycle");
    visiting.add(id);
    const node = byId.get(id);
    const depth = node && node.depends_on.length > 0
      ? Math.max(...node.depends_on.map((dependency) => depthOf(dependency))) + 1
      : 1;
    visiting.delete(id);
    depthById.set(id, depth);
    return depth;
  };
  for (const node of definition.nodes) depthOf(node.id);
  const depth = Math.max(...depthById.values());
  if (depth > PLAN_GRAPH_LIMITS.maxDepth) {
    throw new PlanGraphError(`Plan depth exceeds ${PLAN_GRAPH_LIMITS.maxDepth}`, "plan_depth_exceeded");
  }

  const nodes = definition.nodes.map(toPlanNode);
  const roots = nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.key);
  const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn));
  const leaves = nodes.filter((node) => !dependedOn.has(node.key)).map((node) => node.key);
  for (const node of nodes) {
    if ((node.kind === "integration" || node.kind === "approval_checkpoint") && node.dependsOn.length === 0) {
      throw new PlanGraphError(
        `Plan node '${node.key}' of kind '${node.kind}' must depend on at least one node`,
        "invalid_node_atomicity",
      );
    }
    if ((node.kind === "leaf" || node.kind === "exploratory") && !node.capabilityId && !node.promptAssetKey && !node.agentId) {
      throw new PlanGraphError(
        `Plan leaf '${node.key}' has no capability, prompt asset, or agent binding`,
        "leaf_not_executable",
      );
    }
    if (node.kind === "action" && !node.actionKey) {
      throw new PlanGraphError(
        `Plan node '${node.key}' of kind 'action' has no action_key`,
        "action_not_executable",
      );
    }
  }
  return { graphVersion: PLAN_GRAPH_VERSION, definition, nodes, depth, roots, leaves };
}

function unwrapStoredGraph(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  return value.graphVersion === PLAN_GRAPH_VERSION && value.definition !== undefined
    ? value.definition
    : input;
}

export function decidePlanApproval(
  graph: MaterializedPlanGraph,
  input: { budgetCap?: number | null; budgetSources?: RunBudgetSource[]; nodeLimit?: number } = {},
): PlanApprovalDecision {
  const reasons: string[] = [];
  reasons.push(...evaluatePlanAtomicity(graph).reasons);
  const nodeLimit = input.nodeLimit ?? PLAN_GRAPH_LIMITS.maxAutoApproveNodes;
  const aggregateMaxCost = aggregatePlanCost(graph, input.budgetSources ?? []);
  if (graph.nodes.length > nodeLimit) reasons.push("node_count_exceeds_cap");
  if (input.budgetCap === null || input.budgetCap === undefined) reasons.push("budget_cap_not_declared");
  if (aggregateMaxCost !== null && input.budgetCap !== null && input.budgetCap !== undefined && aggregateMaxCost > input.budgetCap) {
    reasons.push("aggregate_budget_exceeds_cap");
  }
  for (const node of graph.nodes) {
    const risk = riskForNode(node);
    if (!risk) reasons.push(`node_${node.key}_risk_not_declared`);
    else if (risk !== "low") reasons.push(`node_${node.key}_risk_is_${risk}`);
    if (hasPermissionBypass(node)) reasons.push(`node_${node.key}_requests_permission_bypass`);
    const capabilityRisk = stringValue(node.metadataJson.capability_risk) ?? stringValue(node.metadataJson.required_capability_risk);
    if (capabilityRisk === "high" || capabilityRisk === "critical") reasons.push(`node_${node.key}_capability_risk_is_${capabilityRisk}`);
    if (node.kind === "exploratory") reasons.push(`node_${node.key}_is_exploratory`);
  }
  return {
    mode: reasons.length === 0 ? "auto_approved" : "proposal_required",
    reasons: [...new Set(reasons)],
    aggregateMaxCost,
  };
}

export function evaluatePlanAtomicity(graph: MaterializedPlanGraph): PlanAtomicityEvaluation {
  const reasons: string[] = [];
  const metadata = graph.definition.metadata_json;
  const objective = stringValue(metadata.primary_objective) ?? stringValue(metadata.objective);
  const objectives = Array.isArray(metadata.objectives) ? metadata.objectives : null;
  if (!objective || (objectives && objectives.length !== 1)) reasons.push("primary_objective_not_declared");

  const scope = metadata.scope_json ?? metadata.input_scope_json ?? metadata.file_scope;
  if (!hasNonEmptyScope(scope)) reasons.push("execution_scope_not_declared");

  const runtimeProfiles = new Set(graph.nodes.map((node) => node.runtimeProfileId).filter(Boolean));
  const modelProviders = new Set(
    graph.nodes
      .map((node) => stringValue(node.metadataJson.model_provider_id) ?? stringValue(node.contractJson.model_provider_id))
      .filter(Boolean),
  );
  if (runtimeProfiles.size > 1 || modelProviders.size > 1) reasons.push("single_runtime_model_budget_required");

  for (const node of graph.nodes) {
    if (node.kind === "integration" || node.kind === "approval_checkpoint") continue;
    if (!hasIndependentVerification(node)) reasons.push(`node_${node.key}_not_independently_verifiable`);
    if (!positiveInteger(node.contractJson.max_attempts)) reasons.push(`node_${node.key}_retry_policy_not_declared`);
    if (node.metadataJson.runtime_delegation_allowed !== false) {
      reasons.push(`node_${node.key}_runtime_delegation_policy_not_explicit`);
    }
    if (runtimeDelegationRequested(node)) reasons.push(`node_${node.key}_runtime_delegation_not_allowed`);
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function planNodeContentHash(node: PlanNodeRecord): string {
  return sha256Json({
    key: node.key,
    title: node.title,
    description: node.description,
    depends_on: node.dependsOn,
    input_bindings: node.inputBindings,
    kind: node.kind,
    agent_id: node.agentId,
    runtime_profile_id: node.runtimeProfileId,
    capability_id: node.capabilityId,
    prompt_asset_key: node.promptAssetKey,
    verification_recipe_refs: node.verificationRecipeRefs,
    approval_required: node.approvalRequired,
    approval_proposal_type: node.approvalProposalType,
    action_key: node.actionKey,
    checkpoint_kind: node.checkpointKind,
    contract_json: node.contractJson,
    metadata_json: node.metadataJson,
  });
}

function toPlanNode(node: WorkflowNode): PlanNodeRecord {
  const metadataJson = record(node.metadata_json);
  const contractJson = nodeContract(node);
  const requestedKind = stringValue(metadataJson.node_kind);
  const kind: PlanNodeKind = node.approval_checkpoint.required
    ? "approval_checkpoint"
    : isNodeKind(requestedKind)
      ? requestedKind
      : "leaf";
  return {
    key: node.id,
    title: node.title,
    description: stringValue(metadataJson.description),
    dependsOn: [...node.depends_on],
    inputBindings: [...node.input_bindings],
    kind,
    agentId: node.agent_id ?? null,
    runtimeProfileId: node.runtime_profile_id ?? null,
    capabilityId: node.capability_id ?? null,
    promptAssetKey: node.prompt_asset_key ?? null,
    verificationRecipeRefs: [...node.verification_recipe_refs],
    approvalRequired: node.approval_checkpoint.required,
    approvalProposalType: node.approval_checkpoint.proposal_type ?? null,
    actionKey: stringValue(metadataJson.action_key),
    checkpointKind: stringValue(metadataJson.checkpoint_kind),
    contractJson,
    metadataJson,
  };
}

function nodeContract(node: WorkflowNode): Record<string, unknown> {
  const raw = node as unknown as Record<string, unknown>;
  const declared = record(raw.contract_json);
  const contract: Record<string, unknown> = { ...declared };
  const metadata = record(raw.metadata_json);
  // WorkflowNode keeps passthrough fields for forward-compatible definitions.
  // Accept contract fields at the node level as well, but let the explicit
  // contract_json object win when both forms are present.
  for (const key of [
    "acceptance_criteria_json",
    "definition_of_done",
    "required_outputs_json",
    "risk_level",
    "max_runs",
    "max_attempts",
    "max_cost",
    "max_duration_seconds",
    "budget_precedence",
    "route_hints_json",
    "budget_sources",
  ]) {
    if (contract[key] === undefined && raw[key] !== undefined) contract[key] = raw[key];
  }
  if (contract.route_hints_json === undefined && metadata.route_hints_json !== undefined) {
    contract.route_hints_json = metadata.route_hints_json;
  }
  return contract;
}

function riskForNode(node: PlanNodeRecord): string | null {
  return stringValue(node.contractJson.risk_level) ?? stringValue(node.metadataJson.risk_level);
}

function hasPermissionBypass(node: PlanNodeRecord): boolean {
  return node.metadataJson.permission_bypass === true
    || node.contractJson.permission_bypass === true
    || node.metadataJson.permission_bypass_requested === true;
}

function isNodeKind(value: string | null): value is PlanNodeKind {
  return value === "leaf" || value === "integration" || value === "approval_checkpoint" || value === "exploratory" || value === "action";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumFinite(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) : null;
}

function aggregatePlanCost(graph: MaterializedPlanGraph, inheritedSources: RunBudgetSource[]): number | null {
  const localCosts = graph.nodes.map((node) => {
    const localSources: RunBudgetSource[] = [];
    const directCost = numberFrom(node.contractJson.max_cost);
    if (directCost !== null) {
      localSources.push({ source: { kind: "task", id: node.key }, max_cost: directCost });
    }
    for (const source of budgetSourcesFromNode(node)) {
      if (source.source.kind === "task") localSources.push(source);
    }
    return resolveBudgetSources(localSources).effective.max_cost;
  });
  const globalSources = [
    ...inheritedSources,
    ...graph.nodes.flatMap(budgetSourcesFromNode).filter((source) => source.source.kind !== "task"),
  ];
  const globalCost = resolveBudgetSources(globalSources).effective.max_cost;
  const localTotal = sumFinite(localCosts);
  if (localTotal === null) return globalCost;
  if (globalCost === null) return localTotal;
  return Math.max(localTotal, globalCost);
}

export function budgetSourcesFromNode(node: PlanNodeRecord): RunBudgetSource[] {
  return Array.isArray(node.contractJson.budget_sources)
    ? node.contractJson.budget_sources.filter((value): value is RunBudgetSource => {
        const source = record(record(value).source);
        return ["direct", "task", "automation", "workflow", "delegation", "plan"].includes(String(source.kind));
      })
    : [];
}

function hasIndependentVerification(node: PlanNodeRecord): boolean {
  if (node.verificationRecipeRefs.length > 0) return true;
  const acceptance = record(node.contractJson.acceptance_criteria_json);
  const required = node.contractJson.required_outputs_json;
  return hasChecks(acceptance)
    || (Array.isArray(required) && required.length > 0)
    || Object.keys(record(required)).length > 0
    || hasChecks(record(required));
}

function hasChecks(value: Record<string, unknown>): boolean {
  return Array.isArray(value.checks) ? value.checks.length > 0 : Boolean(value.type || value.verifier_type || value.validation);
}

function runtimeDelegationRequested(node: PlanNodeRecord): boolean {
  const routeHints = record(node.contractJson.route_hints_json);
  return [
    node.metadataJson.runtime_delegation,
    node.metadataJson.allow_runtime_delegation,
    node.metadataJson.delegation_required,
    node.contractJson.runtime_delegation,
    node.contractJson.allow_runtime_delegation,
    node.contractJson.delegation_required,
    routeHints.runtime_delegation,
    routeHints.allow_runtime_delegation,
  ].some((value) => value === true);
}

function hasNonEmptyScope(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(record(value)).length > 0;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export class PlanGraphError extends Error {
  constructor(readonly reason: string, readonly code: string) {
    super(reason);
    this.name = "PlanGraphError";
  }
}
