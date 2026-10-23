import { HttpError } from "../routeUtils/common.js";
import { isDeepStrictEqual } from "node:util";
import type { AgentAttentionReadState, AgentAttentionRevision, AgentAttentionReason, AgentWorkItem, AgentAttentionRun } from "@rainver/protocol";
import { responsibleActorOf, PERSON_ONLY_STATUSES } from "../projectWork/index.js";
import { AgentAttentionReasonSchema, AgentAttentionRunSchema } from "@rainver/protocol";
import { runTurnState, attentionWorkspaceWait, attentionResourceWait } from "../runs/index.js";
import { attentionGroup, initiallyUnread, isMine, createAgentWorkResolver, runResultRevision, supersededAgentRuns } from "./semantics.js";
import { subjectId, type RunFact, type TaskFact, type StoredRead, type ExtraSubject, type OwnActivity } from "./repository.js";
export function readState(subject: AgentAttentionRevision, stored: StoredRead | undefined, defaults: boolean): AgentAttentionReadState {
  return {
    subject,
    unread: stored ? stored.manual_unread || !isDeepStrictEqual(subject, stored.last_read_revision_json) : defaults,
    manual_unread: stored?.manual_unread ?? false,
    read_at: stored?.read_at ? new Date(stored.read_at).toISOString() : null,
    state_version: stored?.state_version ?? 0
  };
}
export const workKey = (space: string, identity: AgentWorkItem["identity"]) => `${space}:${identity.kind}:${identity.source_id}`;

/**
 * Which member Run each reason and reading subject of a projected work belongs
 * to (`null` = the work itself: Task and merge state). Paging metadata of this
 * projection, not part of the wire DTO; `boundWork` reads it to page reasons and
 * subjects with their Runs. A work that did not come from `projectWorks` pages
 * everything as work-level, ahead of its Runs.
 */
const membership = new WeakMap<AgentWorkItem, { reasons: Map<AgentAttentionReason, string | null>; reads: Map<AgentAttentionReadState, string | null> }>();
const iso = (value: string) => new Date(value).toISOString();
const actor = (id: string | null) => ({
  kind: id ? "user" as const : null,
  id,
  display_name: null
});
const terminal = new Set(["succeeded", "degraded", "failed", "cancelled", "orphaned"]);
/** The Session a Run speaks in, directly or through its group. */
const sessionOf = (run: RunFact) => run.session_id ?? run.group?.session_id ?? null;
/**
 * A Session-bound Run whose Session the viewer can no longer read (archived,
 * left Room): its reply was a `message` subject while the Session was readable,
 * and its fallback `run_result` is that same, already-delivered reply under
 * another identity. It is history — read by default and never a new notice.
 */
export const sessionDetached = (run: RunFact) => sessionOf(run) !== null && !run.session_readable;

/** Complete authorized facts only. Never loads Turn bodies or guesses meaning from prose. */
export function projectWorks(input: {
  userId: string;
  baseline: string;
  runs: RunFact[];
  tasks: TaskFact[];
  reads: StoredRead[];
  extras: ExtraSubject[];
  activity?: OwnActivity[];
}): AgentWorkItem[] {
  const uniqueRuns = [...new Map(input.runs.map(run => [run.id, run])).values()];
  const resolve = createAgentWorkResolver(uniqueRuns);
  const replaced = supersededAgentRuns(uniqueRuns, resolve);
  const visibleRunIds = new Set(uniqueRuns.map(r => r.id));
  const visibleRunId = (id: string | null | undefined) => id && visibleRunIds.has(id) ? id : null;
  const readableSessions = new Set(uniqueRuns.flatMap(run => {
    const id = run.group?.session_id ?? run.session_id;
    return id && run.session_readable ? [`${run.space_id}:${id}`] : [];
  }));
  const tasks = new Map(input.tasks.map(t => [t.id, t]));
  const groups = new Map<string, {
    identity: AgentWorkItem["identity"];
    runs: RunFact[];
  }>();
  for (const run of uniqueRuns) {
    if (run.execution_kind !== "agent" || !run.agent_id) continue;
    let identity = resolve(run.id);
    if (!identity) continue;
    if (identity.kind === "session" && !readableSessions.has(`${run.space_id}:${identity.source_id}`) || identity.kind === "task" && (!tasks.has(identity.source_id) || tasks.get(identity.source_id)!.space_id !== run.space_id)) {
      identity = {
        kind: "run",
        source_id: run.id
      };
    }
    const key = workKey(run.space_id, identity);
    const group = groups.get(key) ?? {
      identity,
      runs: []
    };
    group.runs.push(run);
    groups.set(key, group);
  }
  const states = new Map(input.reads.map(s => [`${s.space_id}:${s.work_kind}:${s.work_source_id}:${s.read_subject_kind}:${s.read_subject_id}`, s]));
  const ownActivity = new Map((input.activity ?? []).map(entry => [`${entry.space_id}:${entry.session_id}`, Date.parse(entry.at)]));
  const delegated = (run: RunFact) => Boolean(run.delegation_id && run.parent_run_id);
  const extrasByRun = new Map<string, ExtraSubject[]>();
  const extrasByTask = new Map<string, ExtraSubject[]>();
  for (const extra of input.extras) {
    const index = extra.run_id ? extrasByRun : extrasByTask;
    const id = extra.run_id ?? extra.task_id;
    if (id) {
      const key = `${extra.space_id}:${id}`;
      const batch = index.get(key) ?? [];
      batch.push(extra);
      index.set(key, batch);
    }
  }
  return [...groups.entries()].map(([key, {
    identity,
    runs
  }]) => {
    const current = runs.filter(run => !replaced.has(run.id));
    const first = runs.find(run => identity.kind === "session" && run.session_id === identity.source_id && run.session_readable) ?? runs[0]!;
    const task = identity.kind === "task" ? tasks.get(identity.source_id) : undefined;
    const responsible = task ? responsibleActorOf(task) : actor(null);
    const reasons: AgentAttentionReason[] = [];
    const reads: AgentAttentionReadState[] = [];
    const owners = { reasons: new Map<AgentAttentionReason, string | null>(), reads: new Map<AgentAttentionReadState, string | null>() };
    const times = runs.map(r => r.ended_at ?? r.started_at ?? r.created_at);
    if (task) times.push(task.updated_at);
    const readAt = new Map<AgentAttentionReadState, number>();
    const decidedAt = new Map<AgentAttentionReadState, number>();
    /** Chat-ordered subjects and the Session (`space:session`) whose transcript orders them. */
    const chat = new Map<AgentAttentionReadState, string>();
    const reason = (value: AgentAttentionReason, runId: string | null) => { reasons.push(value); owners.reasons.set(value, runId); };
    const add = (subject: AgentAttentionRevision, at: string, active: boolean, open: boolean, run: RunFact | null, unreadByDefault = true) => {
      const stored = states.get(`${key}:${subject.kind}:${subjectId(subject)}`);
      const state = readState(subject, stored, unreadByDefault && initiallyUnread({
        result_at: at,
        baseline_at: input.baseline,
        active,
        open_reason: open
      }));
      reads.push(state);
      owners.reads.set(state, run?.id ?? null);
      readAt.set(state, Date.parse(at));
      if (stored) decidedAt.set(state, Date.parse(stored.updated_at));
      times.push(at);
      // A delegated child's own result is not a reply in its parent's transcript.
      const session = run && run.session_readable ? sessionOf(run) : null;
      if (session && (subject.kind === "message" || subject.kind === "run_result" && !delegated(run!))) chat.set(state, `${run!.space_id}:${session}`);
    };
    if (task && PERSON_ONLY_STATUSES.includes(task.status as typeof PERSON_ONLY_STATUSES[number])) {
      reason({
        kind: "task",
        task_id: task.id,
        status: task.status!,
        responsible
      }, null);
      add({
        kind: "task",
        schema_version: 1,
        task_id: task.id,
        revision: `${task.status}:${iso(task.updated_at)}`
      }, task.updated_at, false, true, null);
    }
    const runById = new Map(current.map(run => [run.id, run]));
    const extras = current.flatMap(run => extrasByRun.get(`${run.space_id}:${run.id}`) ?? []);
    if (task) extras.push(...(extrasByTask.get(`${task.space_id}:${task.id}`) ?? []));
    for (const extra of extras) {
      const parsed = AgentAttentionReasonSchema.safeParse(extra.reason);
      if (!parsed.success) continue;
      reason(parsed.data, extra.run_id);
      add(extra.subject, extra.at, false, true, extra.run_id ? runById.get(extra.run_id) ?? null : null);
    }
    const waits = new Map(current.map(run => [run.id, attentionResourceWait({
      status: run.status,
      workspace: run.status === 'running' && attentionWorkspaceWait(run.id),
      quota: run.wait_quota,
      turn: run.wait_turn,
      scope: run.wait_scope
    })]));
    for (const run of current) {
      const full = run.access_level === "full";
      if (full && run.question_open && run.message_id && run.session_id && run.agent_id) {
        reason({
          kind: "awaiting_answer",
          message_id: run.message_id,
          session_id: run.session_id,
          agent_id: run.agent_id,
          responsible: actor(run.question_user_id)
        }, run.id);
      }
      if (full && run.status === "waiting_for_review") {
        if (run.supervisor_review) {
          reason({
            kind: "run_decision",
            run_id: run.id,
            responsible: actor(run.instructed_by_user_id ?? run.owner_user_id)
          }, run.id);
          add({
            kind: "run_decision",
            schema_version: 1,
            run_id: run.id,
            revision: `${run.attempt_id ?? run.id}:waiting_for_review`
          }, run.ended_at ?? run.created_at, false, true, run);
        } else if (run.authorization_pending) {
          reason({
            kind: "authorization",
            run_id: run.id,
            authorization_request_id: run.authorization_request_id,
            responsible: actor(run.instructed_by_user_id ?? run.owner_user_id)
          }, run.id);
          if (run.authorization_request_id) add({
            kind: "authorization",
            schema_version: 1,
            authorization_request_id: run.authorization_request_id,
            revision: "pending"
          }, run.ended_at ?? run.created_at, false, true, run);
        }
      }
      const wait = waits.get(run.id);
      if (wait) reason({
        kind: "resource",
        run_id: run.id,
        code: wait,
        dependency_run_ids: run.dependency_run_ids.slice(0, 100)
      }, run.id);
      if (full && run.message_id && run.message_revision && run.message_at) {
        add({
          kind: "message",
          schema_version: 1,
          message_id: run.message_id,
          revision: run.message_revision
        }, run.message_at, false, run.question_open, run);
      } else if (terminal.has(run.status) && run.attempt_id && run.result_at) {
        add(runResultRevision({
          run_id: run.id,
          attempt_id: run.attempt_id,
          revision: `${run.status}:${iso(run.result_at)}`
        }), run.result_at, false, false, run, !sessionDetached(run));
      }
    }
    // Chat reading: each readable Session of the work has a read cursor, the
    // latest of (a) the newest reply/result in that Session the person confirmed
    // on any surface and (b) the person's own latest message there — replying is
    // reading everything before it in that transcript. Its older replies and
    // results are read; nothing is written for them. A subject at the same
    // instant, anything newer, other Sessions' replies and delegated children's
    // own results keep their own state. A manual unread holds until the next
    // view or an own reply in its Session made after that decision; the other
    // subject kinds (task, merge, proposal, authorization, decision) are closed
    // by their own actions.
    const confirmedAt = new Map<string, number>();
    for (const [state, session] of chat) {
      if (!state.unread && state.read_at) confirmedAt.set(session, Math.max(confirmedAt.get(session) ?? -Infinity, readAt.get(state)!));
    }
    for (const [state, session] of chat) {
      const ownAt = ownActivity.get(session) ?? -Infinity;
      if (!state.unread || readAt.get(state)! >= Math.max(confirmedAt.get(session) ?? -Infinity, ownAt)) continue;
      if (state.manual_unread && !((decidedAt.get(state) ?? Infinity) < ownAt)) continue;
      state.unread = false;
      state.manual_unread = false;
    }
    reads.sort((a, b) => `${a.subject.kind}:${subjectId(a.subject)}`.localeCompare(`${b.subject.kind}:${subjectId(b.subject)}`));
    reasons.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const unread = reads.some(s => s.unread);
    const active = current.some(r => runTurnState(r.status, r.chat_completed, r.is_chat_turn) === 'working' && r.status !== 'queued' && r.status !== 'waiting_for_dependency' && !waits.get(r.id));
    const queued = current.some(r => r.status === "queued" || r.status === "waiting_for_dependency");
    const mine = isMine({
      viewer_user_id: input.userId,
      owner_user_ids: runs.flatMap(r => r.owner_user_id ? [r.owner_user_id] : []),
      instructed_by_user_ids: runs.flatMap(r => r.instructed_by_user_id ? [r.instructed_by_user_id] : []),
      responsible,
      reasons
    });
    const dtoRuns: AgentAttentionRun[] = runs.sort((a, b) => a.id.localeCompare(b.id)).map(r => {
      const linksVisible = r.session_readable || !r.session_id && !r.group?.session_id;
      const parsedSource = AgentAttentionRunSchema.shape.contract_source.safeParse(r.contract_source);
      const source = parsedSource.success ? parsedSource.data : null;
      const sourceVisible = source?.kind === "delegation" ? linksVisible && Boolean(visibleRunId(r.parent_run_id)) : source?.kind === "task" ? source.id !== null && tasks.has(source.id) : linksVisible;
      return {
        run_id: r.id,
        agent_id: r.agent_id!,
        agent_name: r.agent_name ?? null,
        runtime_key: r.runtime_key ?? null,
        started_at: r.started_at ? iso(r.started_at) : null,
        status: r.status,
        turn_state: r.access_level === 'full' ? waits.get(r.id) === 'workspace' ? 'blocked' : runTurnState(r.status, r.chat_completed, r.is_chat_turn) : null,
        blocked_on: waits.get(r.id) === 'workspace' ? 'workspace' : r.access_level === 'full' && r.status === 'waiting_for_review' ? r.supervisor_review ? 'run_decision' : 'authorization' : null,
        trigger_origin: r.trigger_origin as AgentAttentionRun["trigger_origin"],
        parent_run_id: visibleRunId(r.parent_run_id),
        root_run_id: visibleRunId(r.root_run_id),
        cause_run_id: visibleRunId(r.cause_run_id),
        run_group_id: r.session_readable || !r.session_id && !r.group?.session_id ? r.group?.id ?? null : null,
        delegation_id: visibleRunId(r.parent_run_id) && linksVisible ? r.delegation_id ?? null : null,
        session_id: r.session_readable ? r.session_id ?? null : null,
        room_id: r.session_readable ? r.room_id : null,
        task_role: r.task_role,
        task_run_role: r.task_run_role,
        run_role: r.run_role,
        plan_id: r.plan_id,
        plan_node_id: r.plan_node_id,
        workflow_execution_id: r.workflow_execution_id,
        contract_source: source && !sourceVisible ? {
          ...source,
          id: null
        } : source,
        automation_id: r.automation_id,
        autonomy_tick_id: r.autonomy_tick_id,
        autonomy_candidate_id: r.autonomy_candidate_id,
        owner_user_id: r.owner_user_id,
        instructed_by_user_id: r.instructed_by_user_id,
        ended_at: r.ended_at ? iso(r.ended_at) : null,
        retry_of_run_id: visibleRunId(r.retry_of_run_id),
        retry_superseded: replaced.has(r.id)
      };
    });
    const item = {
      identity,
      work_key: key,
      space_id: first.space_id,
      project_id: task?.project_id ?? first.project_id,
      title: task?.title ?? first.session_title ?? first.group_title ?? "Agent work",
      source_run_id: visibleRunId(task?.source_run_id),
      access_level: runs.every(r => r.access_level === 'full') ? 'full' : 'summary',
      group: attentionGroup({
        viewer_user_id: input.userId,
        reasons,
        active,
        queued,
        resource_wait: [...waits.values()].some(Boolean),
        blocked: current.some(r => r.status === 'waiting_for_review'),
        terminal: !active && !queued,
        unread
      }),
      mine,
      responsible,
      task_status: task?.status ?? null,
      loop_stage: task?.loop_stage ?? null,
      task_completed_at: task?.completed_at ? iso(task.completed_at) : null,
      runs: dtoRuns,
      reasons,
      read_states: reads,
      unread,
      last_activity_at: iso(times.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b)),
      visible_run_count: runs.length,
      runs_next_cursor: null,
      operations: identity.kind === 'task' ? [{
        kind: 'open_task',
        space_id: first.space_id,
        task_id: identity.source_id
      }] : identity.kind === 'session' && first.agent_id ? [{
        kind: 'open_session',
        space_id: first.space_id,
        session_id: identity.source_id,
        room_id: first.room_id,
        agent_id: first.agent_id
      }] : []
    } satisfies AgentWorkItem;
    membership.set(item, owners);
    return item;
  });
}

/** Wire caps of one work's child arrays (`AgentWorkItemSchema`). */
export const CHILD_PAGE_LIMIT = 100;
type ChildEntry = { run: AgentAttentionRun } | { reason: AgentAttentionReason } | { read: AgentAttentionReadState };

/**
 * One child page: the work's own (Task/merge) reasons and reading subjects, then
 * each member Run immediately followed by exactly the reasons and subjects that
 * belong to it, cut so no array exceeds the wire cap of 100. A Run and its
 * subjects stay on one page unless they alone exceed a cap; then the remainder
 * continues on the next page, which a client appends. A subject therefore never
 * precedes its Run, a client only ever holds subjects whose Runs it can show,
 * and it acknowledges nothing it has not loaded. The cursor is the entry offset.
 */
export function boundWork(item: AgentWorkItem, cursor?: string): AgentWorkItem {
  let offset = 0;
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.key !== item.work_key) throw new Error();
      offset = value.offset;
    } catch {
      throw new HttpError(422, "Invalid child cursor");
    }
  }
  const owners = membership.get(item);
  const units = new Map<string | null, ChildEntry[]>([[null, []]]);
  for (const run of item.runs) units.set(run.run_id, [{ run }]);
  const unitOf = (runId: string | null | undefined) => units.get(runId ?? null) ?? units.get(null)!;
  for (const reason of item.reasons) unitOf(owners?.reasons.get(reason)).push({ reason });
  for (const read of item.read_states) unitOf(owners?.reads.get(read)).push({ read });
  const entries: ChildEntry[] = [];
  const starts = new Set<number>();
  for (const unit of units.values()) { starts.add(entries.length); entries.push(...unit); }
  const page = { runs: [] as AgentAttentionRun[], reasons: [] as AgentAttentionReason[], read_states: [] as AgentAttentionReadState[] };
  const target = (entry: ChildEntry): unknown[] => "run" in entry ? page.runs : "reason" in entry ? page.reasons : page.read_states;
  let next = offset;
  for (; next < entries.length; next++) {
    if (starts.has(next) && next > offset) {
      // Start a unit only when all of it fits; an oversized unit starts a fresh page.
      let end = next + 1;
      while (end < entries.length && !starts.has(end)) end++;
      const need = { runs: 0, reasons: 0, read_states: 0 };
      for (const entry of entries.slice(next, end)) need["run" in entry ? "runs" : "reason" in entry ? "reasons" : "read_states"]++;
      if ((Object.keys(need) as (keyof typeof need)[]).some(name => need[name] && page[name].length + need[name] > CHILD_PAGE_LIMIT)) break;
    }
    const entry = entries[next]!, list = target(entry);
    if (list.length >= CHILD_PAGE_LIMIT) break;
    list.push("run" in entry ? entry.run : "reason" in entry ? entry.reason : entry.read);
  }
  return {
    ...item,
    ...page,
    runs_next_cursor: next < entries.length ? Buffer.from(JSON.stringify({
      offset: next,
      key: item.work_key
    })).toString("base64url") : null
  };
}
