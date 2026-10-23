import type { AgentAttentionPage, AgentAttentionRun, AgentWorkItem } from '@rainver/protocol'
import type { Run, RunTurn } from '../../types/api'

export function workRun(overrides: Partial<AgentAttentionRun> = {}): AgentAttentionRun {
  return { run_id: 'run-b', agent_id: 'agent-b', status: 'succeeded', turn_state: 'done', blocked_on: null,
    trigger_origin: 'manual', parent_run_id: null, root_run_id: null, cause_run_id: null, run_group_id: null,
    delegation_id: null, session_id: null, room_id: null, task_role: null, task_run_role: null, run_role: 'execution',
    plan_id: null, plan_node_id: null, workflow_execution_id: null, contract_source: null, automation_id: null,
    autonomy_tick_id: null, autonomy_candidate_id: null, owner_user_id: 'user', instructed_by_user_id: 'user',
    ended_at: '2026-10-20T12:00:00Z', retry_of_run_id: null, retry_superseded: false, ...overrides }
}
export function work(overrides: Partial<AgentWorkItem> = {}): AgentWorkItem {
  return { identity: { kind: 'run', source_id: 'run-b' }, work_key: 'opaque-b', space_id: 'space-b', project_id: 'project-b',
    title: 'Build the report', source_run_id: null, access_level: 'full', group: 'recently_finished', mine: true,
    responsible: { kind: 'user', id: 'user', display_name: 'Reader' }, task_status: null, loop_stage: null, task_completed_at: null,
    runs: [workRun()], reasons: [], read_states: [{ subject: { kind: 'run_result', schema_version: 1, run_id: 'run-b', attempt_id: 'attempt-b', revision: 'rev-1' },
      unread: true, manual_unread: false, read_at: null, state_version: 0 }], unread: true,
    last_activity_at: '2026-10-20T12:00:00Z', visible_run_count: 1, runs_next_cursor: null, operations: [], ...overrides }
}
export function page(items: AgentWorkItem[] = [work()], overrides: Partial<AgentAttentionPage> = {}): AgentAttentionPage {
  return { items, counts: { needs_you: 0, recently_finished: 1, working: 0, waiting: 0, idle: 0 },
    next_cursor: null, as_of: '2026-10-20T12:00:00Z', ...overrides }
}
export function run(overrides: Partial<Run> = {}): Run {
  return { id: 'run-b', space_id: 'space-b', agent_id: 'agent-b', agent_version_id: 'v-b', execution_kind: 'agent', run_role: 'execution',
    project_folder_id: null, session_id: null, parent_run_id: null, instructed_by_user_id: 'user', owner_user_id: 'user',
    run_type: 'task', trigger_origin: 'manual', status: 'succeeded', mode: 'live', prompt: null, instruction: null,
    scheduled_at: null, started_at: '2026-10-20T11:59:00Z', ended_at: '2026-10-20T12:00:00Z',
    created_at: '2026-10-20T11:59:00Z', updated_at: '2026-10-20T12:00:00Z', error_message: null, error_json: null,
    output_json: null, usage: null, ...overrides }
}
export function turn(overrides: Partial<RunTurn> = {}): RunTurn {
  return { schema_version: 'run_turn.v1', source: 'run_events', cursor: 1, updated_at: null, run_id: 'run-b', state: 'done', blocked_on: null, parts: [{ type: 'text', index: 0, text: 'The report is ready.' }],
    ...overrides }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
