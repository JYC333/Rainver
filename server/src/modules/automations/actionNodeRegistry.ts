import type { ServerConfig } from "../../config.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import type { ResolvedNodeInputs } from "../execution/nodeInputResolver.js";

/** The execution graph an `action` node runs in: a Workflow execution or a Plan version. */
export type ActionNodeContainerKind = "workflow_execution" | "plan_version";
export interface ActionNodeContainer {
  kind: ActionNodeContainerKind;
  /** The workflow execution's id, or the Plan version's. */
  id: string;
}

export interface ActionNodeContext {
  db: Queryable;
  identity: SpaceUserIdentity;
  config: ServerConfig;
  /** Only ever a kind the handler registered for. */
  container: ActionNodeContainer;
  nodeId: string;
  nodeKey: string;
  projectId: string | null;
  projectFolderId: string | null;
  /** Resolved upstream input-binding values, keyed by binding name (see `resolveNodeInputs`). */
  inputs: Record<string, unknown>;
  /** Full resolved-binding detail (source_run_id, artifact_id, truncation, ...), for handlers that need more than the plain value. */
  bindings: ResolvedNodeInputs["bindings"];
  /** The node's raw `metadata_json`, for handler-specific configuration beyond `action_key`. */
  metadata: Record<string, unknown>;
}

export interface ActionNodeResult {
  output: Record<string, unknown>;
  /**
   * Optional durable Run spawned by the action. The Action node remains
   * in-progress until this Run reaches a terminal evaluated outcome; the
   * delegated Run becomes the node's authoritative output for downstream
   * bindings.
   */
  delegatedRunId?: string;
}

/** Thrown by a handler to fail the node with a specific, queryable reason. */
export class ActionNodeHandlerError extends Error {
  constructor(message: string, readonly outputJson: Record<string, unknown> = {}) {
    super(message);
    this.name = "ActionNodeHandlerError";
  }
}

export type ActionNodeHandler = (context: ActionNodeContext) => Promise<ActionNodeResult>;

/**
 * Deterministic-handler dispatch for `node_kind: "action"` nodes of both
 * execution graphs — Workflow executions and Plans — through the one executor
 * (`execution/actionNodeExecution.ts`): system operations that do not spawn an
 * LLM run. A handler names the graphs it can run in, since what it does may
 * read its container (a research pass reads its workflow execution); a Plan
 * naming an action no Plan-capable handler serves is refused when the Plan is
 * proposed. Mirrors `ProposalApplierRegistry`'s upsert-by-key registration so
 * modules can register at init time regardless of load order. Do not guard
 * with "registered once". A test reset would leave the registry empty.
 */
class ActionNodeHandlerRegistry {
  private readonly handlers = new Map<string, { handler: ActionNodeHandler; owner: string; containers: ReadonlySet<ActionNodeContainerKind> }>();

  register(
    actionKey: string,
    handler: ActionNodeHandler,
    owner: string,
    containers: readonly ActionNodeContainerKind[] = ["workflow_execution"],
  ): void {
    if (!actionKey) throw new Error("actionKey must be non-empty");
    if (!owner.trim()) throw new Error("owner must be non-empty");
    if (containers.length === 0) throw new Error("containers must name at least one execution graph");
    const existing = this.handlers.get(actionKey);
    if (existing && existing.owner !== owner) {
      throw new Error(`${actionKey} is already registered by ${existing.owner}`);
    }
    this.handlers.set(actionKey, { handler, owner, containers: new Set(containers) });
  }

  /** The handler for `actionKey`, only when it runs in `container` (any container when omitted). */
  get(actionKey: string, container?: ActionNodeContainerKind): ActionNodeHandler | null {
    const entry = this.handlers.get(actionKey);
    if (!entry || (container && !entry.containers.has(container))) return null;
    return entry.handler;
  }

  registeredKeys(): ReadonlySet<string> {
    return new Set(this.handlers.keys());
  }

  /** Test-only: reset registrations between test files. */
  __resetForTests(): void {
    this.handlers.clear();
  }
}

export const actionNodeHandlerRegistry = new ActionNodeHandlerRegistry();
