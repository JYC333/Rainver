import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import type { ResolvedNodeInputs } from "../execution/nodeInputResolver";

export interface ActionNodeContext {
  db: Queryable;
  identity: SpaceUserIdentity;
  executionId: string;
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
 * Deterministic-handler dispatch for `node_kind: "action"` Workflow Execution
 * nodes (plan section 17.1-17.2): system operations that do not spawn an LLM
 * run. Mirrors `ProposalApplierRegistry`'s upsert-by-key registration so
 * modules can register at init time regardless of load order, and so a test
 * reset never leaves the registry silently empty (see the equivalent fix to
 * `registerBuiltInAttentionAdapters` for why a "registered once" guard is the
 * wrong pattern here).
 */
class ActionNodeHandlerRegistry {
  private readonly handlers = new Map<string, ActionNodeHandler>();

  register(actionKey: string, handler: ActionNodeHandler): void {
    if (!actionKey) throw new Error("actionKey must be non-empty");
    this.handlers.set(actionKey, handler);
  }

  get(actionKey: string): ActionNodeHandler | null {
    return this.handlers.get(actionKey) ?? null;
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
