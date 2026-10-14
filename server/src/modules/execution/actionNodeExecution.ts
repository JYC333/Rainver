import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import type { ResolvedNodeInputs } from "./nodeInputResolver.js";
import {
  actionNodeHandlerRegistry,
  ActionNodeHandlerError,
  type ActionNodeContainer,
} from "../automations/actionNodeRegistry.js";

/**
 * Where one kind of execution graph keeps an `action` node's state: its node
 * table, its attempt table and the link to a Run the action delegates to.
 * The two graphs — a Workflow execution and a Plan version — share the
 * executor below, so the handler contract (dispatch by `action_key`, attempts,
 * idempotent retry, success and failure) is the same in both.
 */
interface ActionNodeStore {
  readonly nodeTable: string;
  readonly attemptTable: string;
  readonly attemptNodeColumn: string;
  readonly runLinkTable: string;
  readonly runLinkNodeColumn: string;
}

const WORKFLOW_STORE: ActionNodeStore = {
  nodeTable: "workflow_execution_nodes",
  attemptTable: "workflow_execution_action_attempts",
  attemptNodeColumn: "node_id",
  runLinkTable: "workflow_execution_node_runs",
  runLinkNodeColumn: "node_id",
};

const PLAN_STORE: ActionNodeStore = {
  nodeTable: "plan_nodes",
  attemptTable: "plan_node_action_attempts",
  attemptNodeColumn: "plan_node_id",
  runLinkTable: "plan_node_runs",
  runLinkNodeColumn: "plan_node_id",
};

function storeFor(container: ActionNodeContainer): ActionNodeStore {
  return container.kind === "workflow_execution" ? WORKFLOW_STORE : PLAN_STORE;
}

export interface ActionNodeExecutionInput {
  db: Queryable;
  config: ServerConfig;
  identity: SpaceUserIdentity;
  container: ActionNodeContainer;
  node: {
    id: string;
    node_key: string;
    metadata_json: Record<string, unknown>;
    /** Attempts allowed before the node fails for good. */
    max_attempts: number;
  };
  projectId: string | null;
  projectFolderId: string | null;
  resolvedInputs: ResolvedNodeInputs;
}

/** Earlier attempts of a node: its Runs plus its action attempts. */
export async function actionNodeAttemptCount(db: Queryable, container: ActionNodeContainer, spaceId: string, nodeId: string): Promise<number> {
  const store = storeFor(container);
  const result = await db.query<{ count: number }>(
    `SELECT (
       (SELECT count(*) FROM ${store.runLinkTable}
         WHERE space_id=$1 AND ${store.runLinkNodeColumn}=$2 AND role='primary')
       +
       (SELECT count(*) FROM ${store.attemptTable}
         WHERE space_id=$1 AND ${store.attemptNodeColumn}=$2)
     )::int AS count`,
    [spaceId, nodeId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Runs one `action` node: the deterministic handler its `action_key` names,
 * for the kind of graph it is in. The action owns its attempts and outputs and
 * spawns no Agent Run of its own; a Run it delegates to is linked with role
 * `delegated` and the node stays in progress until that Run settles it. A
 * failure retries up to the node's attempts, then fails the node with the
 * handler's reason. A key with no handler for this kind of graph fails the
 * node at once: an action is never run as an Agent turn instead.
 */
export async function executeActionNode(input: ActionNodeExecutionInput): Promise<void> {
  const store = storeFor(input.container);
  const spaceId = input.identity.spaceId;
  const now = new Date().toISOString();
  const actionKey = typeof input.node.metadata_json.action_key === "string" ? input.node.metadata_json.action_key : null;
  const handler = actionKey ? actionNodeHandlerRegistry.get(actionKey, input.container.kind) : null;
  await input.db.query(
    `UPDATE ${store.nodeTable} SET status='in_progress', updated_at=$3 WHERE id=$1 AND space_id=$2`,
    [input.node.id, spaceId, now],
  );
  const attemptNumber = await actionNodeAttemptCount(input.db, input.container, spaceId, input.node.id) + 1;
  const attemptId = randomUUID();
  await input.db.query(
    `INSERT INTO ${store.attemptTable} (
       id, space_id, ${store.attemptNodeColumn}, attempt_number, action_key, status,
       resolved_inputs_json, started_at
     ) VALUES ($1, $2, $3, $4, $5, 'running', $6::jsonb, $7)`,
    [attemptId, spaceId, input.node.id, attemptNumber, actionKey, JSON.stringify(input.resolvedInputs), now],
  );
  if (!handler) {
    const failedAt = new Date().toISOString();
    const reason = !actionKey
      ? "action_key_missing"
      : actionNodeHandlerRegistry.get(actionKey)
        ? `action_handler_unsupported_container:${actionKey}:${input.container.kind}`
        : `action_handler_not_registered:${actionKey}`;
    await input.db.query(
      `UPDATE ${store.attemptTable} SET status='failed', error_json=$3::jsonb, ended_at=$4
        WHERE id=$1 AND space_id=$2 AND status='running'`,
      [attemptId, spaceId, JSON.stringify({ error_code: reason, error_text: reason }), failedAt],
    );
    await input.db.query(
      `UPDATE ${store.nodeTable} SET status='failed', blocked_reason=$3, updated_at=$4 WHERE id=$1 AND space_id=$2`,
      [input.node.id, spaceId, reason, failedAt],
    );
    return;
  }
  // Handlers execute inside the graph's transaction. A PostgreSQL statement
  // error aborts that transaction until rollback; the failure recorder below
  // must therefore have a savepoint to roll back to, otherwise it masks the
  // actionable error with 25P02 and records nothing.
  const transactional = typeof (input.db as Queryable & { release?: unknown }).release === "function";
  const savepoint = "action_node_handler";
  if (transactional) await input.db.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await handler({
      db: input.db,
      identity: input.identity,
      config: input.config,
      container: input.container,
      nodeId: input.node.id,
      nodeKey: input.node.node_key,
      projectId: input.projectId,
      projectFolderId: input.projectFolderId,
      inputs: input.resolvedInputs.values,
      bindings: input.resolvedInputs.bindings,
      metadata: input.node.metadata_json,
    });
    const completedAt = new Date().toISOString();
    if (result.delegatedRunId) {
      const delegated = await input.db.query<{ id: string }>(
        `SELECT id FROM runs WHERE id=$1 AND space_id=$2 AND ($3::varchar IS NULL OR project_id=$3)`,
        [result.delegatedRunId, spaceId, input.projectId],
      );
      if (!delegated.rows[0]) throw new ActionNodeHandlerError("Action handler returned an invalid delegated Run");
      await input.db.query(
        `INSERT INTO ${store.runLinkTable} (id, space_id, ${store.runLinkNodeColumn}, run_id, role, resolved_inputs_json, created_at)
         VALUES ($1,$2,$3,$4,'delegated',$5::jsonb,$6)`,
        [randomUUID(), spaceId, input.node.id, result.delegatedRunId, JSON.stringify(input.resolvedInputs), completedAt],
      );
    }
    await input.db.query(
      `UPDATE ${store.attemptTable} SET status='succeeded', output_text=$3, output_json=$4::jsonb, ended_at=$5
        WHERE id=$1 AND space_id=$2 AND status='running'`,
      [attemptId, spaceId, input.container.kind === "workflow_execution" ? "Workflow action completed." : "Plan action completed.", JSON.stringify(result.output), completedAt],
    );
    await input.db.query(
      `UPDATE ${store.nodeTable} SET status=$3, blocked_reason=NULL, updated_at=$4 WHERE id=$1 AND space_id=$2`,
      [input.node.id, spaceId, result.delegatedRunId ? "in_progress" : "done", completedAt],
    );
    if (transactional) await input.db.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    if (transactional) {
      await input.db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await input.db.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const outputJson = error instanceof ActionNodeHandlerError ? error.outputJson : {};
    await input.db.query(
      `UPDATE ${store.attemptTable} SET status='failed', error_json=$3::jsonb, ended_at=$4
        WHERE id=$1 AND space_id=$2 AND status='running'`,
      [attemptId, spaceId, JSON.stringify({
        error_code: error instanceof ActionNodeHandlerError ? "action_handler_failed" : "action_node_failed",
        error_text: message,
        ...(Object.keys(outputJson).length > 0 ? { partial_output: outputJson } : {}),
      }), failedAt],
    );
    const attempts = await actionNodeAttemptCount(input.db, input.container, spaceId, input.node.id);
    const nextStatus = attempts < input.node.max_attempts ? "ready" : "failed";
    await input.db.query(
      `UPDATE ${store.nodeTable} SET status=$3, blocked_reason=$4, updated_at=$5 WHERE id=$1 AND space_id=$2`,
      [input.node.id, spaceId, nextStatus, `action_handler_error:${message}`, failedAt],
    );
  }
}
