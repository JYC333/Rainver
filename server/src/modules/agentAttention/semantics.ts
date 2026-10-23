import type { AgentAttentionReason, AgentAttentionRevision, AgentWorkIdentity, AgentWorkItem } from "@rainver/protocol";

/** Facts loaded in batches by an owning reader, not raw user input.
 * task_ids are task_runs links; plan_task_id comes from plan_node_runs → plans.
 * source_run_id is deliberately absent: Task creation provenance is not execution.
 * Resolve against authorized resources; this function grants no access.
 */
export interface WorkRunFacts {
  id: string;
  space_id: string;
  execution_kind: "agent" | "provider_task";
  task_ids?: readonly string[];
  contract_task_id?: string | null;
  plan_task_id?: string | null;
  session_id?: string | null;
  group?: {
    id: string;
    session_id: string | null;
  } | null;
  parent_run_id?: string | null;
  root_run_id?: string | null;
  cause_run_id?: string | null;
  delegation_id?: string | null;
  retry_of_run_id?: string | null;
  trigger_origin?: string;
}

/** One indexed, memoized resolver per batch. It keeps visible work when an
 * ancestor is absent/hidden: ambiguous, missing, cyclic or cross-Space lineage
 * falls back to the Run's own `run` identity (a cycle to its least member id).
 */
export function createAgentWorkResolver(rows: readonly WorkRunFacts[]) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const cache = new Map<string, AgentWorkIdentity>();
  return (runId: string): AgentWorkIdentity | null => {
    const start = byId.get(runId);
    if (!start) throw new Error("Missing work Run");
    if (start.execution_kind !== "agent") return null;
    const path: WorkRunFacts[] = [];
    const seen = new Set<string>();
    let row = start;
    let identity: AgentWorkIdentity | undefined;
    while (!identity) {
      identity = cache.get(row.id);
      if (identity) break;
      const own: AgentWorkIdentity = {
        kind: "run",
        source_id: row.id
      };
      if (seen.has(row.id)) {
        identity = {
          kind: "run",
          source_id: [...seen].sort()[0]!
        };
        break;
      }
      seen.add(row.id);
      path.push(row);
      const tasks = new Set(row.task_ids ?? []);
      if (row.plan_task_id) tasks.add(row.plan_task_id);
      if (row.contract_task_id) {
        if (!tasks.has(row.contract_task_id)) identity = own;
        else identity = {
          kind: "task",
          source_id: row.contract_task_id
        };
        break;
      }
      if (tasks.size > 1) {
        identity = own;
        break;
      }
      if (tasks.size === 1) {
        identity = {
          kind: "task",
          source_id: [...tasks][0]!
        };
        break;
      }
      const delegated = row.delegation_id && row.parent_run_id;
      if (!delegated) {
        if (row.group?.session_id) identity = {
          kind: "session",
          source_id: row.group.session_id
        };else if (row.group) identity = {
          kind: "agent_group",
          source_id: row.group.id
        };else if (row.session_id) identity = {
          kind: "session",
          source_id: row.session_id
        };
        if (identity) break;
      }
      const relatedId = delegated ? row.parent_run_id : row.parent_run_id ?? (row.root_run_id !== row.id ? row.root_run_id : null) ?? (row.trigger_origin === "continuation" ? row.cause_run_id : null) ?? row.retry_of_run_id;
      if (!relatedId) {
        identity = own;
        break;
      }
      const parent = byId.get(relatedId);
      if (!parent || parent.space_id !== start.space_id) {
        identity = own;
        break;
      }
      row = parent;
    }
    for (const member of path) cache.set(member.id, identity!);
    return identity!;
  };
}

/**
 * Explicit Room supersession and direct-chat retry links: the Runs whose results
 * a later member of the same work replaced. Missing, cyclic, cross-Space or
 * identity-changing chains replace nothing. Every predecessor edge is examined
 * once, not once per descendant.
 */
export function supersededAgentRuns(rows: readonly (WorkRunFacts & {
  retry_superseded: boolean;
})[], resolve: (id: string) => AgentWorkIdentity | null): Set<string> {
  const byId = new Map(rows.map(row => [row.id, row]));
  const replaced = new Set(rows.filter(row => row.retry_superseded).map(row => row.id));
  const complete = new Set<string>();
  const cyclic = new Set<string>();
  for (const start of rows) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: typeof start | undefined = start;
    while (current && !complete.has(current.id)) {
      const position = positions.get(current.id);
      if (position !== undefined) {
        for (const id of path.slice(position)) cyclic.add(id);
        break;
      }
      positions.set(current.id, path.length);
      path.push(current.id);
      current = current.retry_of_run_id ? byId.get(current.retry_of_run_id) : undefined;
    }
    for (const id of path) complete.add(id);
  }
  for (const row of rows) {
    if (cyclic.has(row.id)) continue;
    if (!row.retry_of_run_id) continue;
    const previous = byId.get(row.retry_of_run_id);
    if (!previous || previous.space_id !== row.space_id) continue;
    const currentIdentity = resolve(row.id);
    const previousIdentity = resolve(previous.id);
    if (!currentIdentity || !previousIdentity || currentIdentity.kind !== previousIdentity.kind || currentIdentity.source_id !== previousIdentity.source_id) continue;
    replaced.add(previous.id);
  }
  return replaced;
}
export function reasonNeedsUser(reason: AgentAttentionReason, userId: string): boolean {
  return reason.kind !== "resource" && reason.responsible.kind === "user" && reason.responsible.id === userId;
}

/** Existing ACLs must have admitted the work first. Approval capability and
 * Agent ownership are deliberately not personal-association facts.
 */
export function isMine(input: {
  viewer_user_id: string;
  owner_user_ids: readonly string[];
  instructed_by_user_ids: readonly string[];
  responsible: {
    kind: "user" | "agent" | null;
    id: string | null;
  };
  reasons: readonly AgentAttentionReason[];
}): boolean {
  return input.owner_user_ids.includes(input.viewer_user_id) || input.instructed_by_user_ids.includes(input.viewer_user_id) || input.responsible.kind === "user" && input.responsible.id === input.viewer_user_id || input.reasons.some(reason => reasonNeedsUser(reason, input.viewer_user_id));
}

/** Presentation only: Run/Turn/Task axes supplied by their owning readers. */
export function attentionGroup(input: {
  viewer_user_id: string;
  reasons: readonly AgentAttentionReason[];
  active: boolean;
  /** Owning status says admitted/queued, but no member has begun executing. */
  queued: boolean;
  resource_wait: boolean;
  /** Readable blocked status, including a summary-only member with withheld reason. */
  blocked?: boolean;
  terminal: boolean;
  unread: boolean;
}): AgentWorkItem["group"] {
  if (input.reasons.some(reason => reasonNeedsUser(reason, input.viewer_user_id))) return "needs_you";
  if (input.active) return "working";
  if (input.queued || input.resource_wait || input.blocked || input.reasons.length > 0) return "waiting";
  if (input.terminal && input.unread) return "recently_finished";
  return "idle";
}
/** Attempt identity is part of the displayed result, not an orderable global cursor. */
export function runResultRevision(input: {
  run_id: string;
  attempt_id: string;
  revision: string;
}): Extract<AgentAttentionRevision, {
  kind: "run_result";
}> {
  return {
    kind: "run_result",
    schema_version: 1,
    ...input
  };
}

/** Baseline is a user's immutable enablement time; late results from an old
 * Run use their own result time.
 */
export function initiallyUnread(input: {
  result_at: string;
  baseline_at: string;
  active: boolean;
  open_reason: boolean;
}): boolean {
  return input.active || input.open_reason || Date.parse(input.result_at) >= Date.parse(input.baseline_at) - 86_400_000;
}
