import { STOPPED_MERGE_STATUSES } from "../hosts/index.js";
import { createHash, randomUUID } from "node:crypto";
import type { AgentAttentionQuery, AgentAttentionPage, AgentAttentionRevision, AgentAttentionReadRequest, AgentWorkItem } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import { contentReadSql, contentAccessLevelSql, runReadSql, proposalReadSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { responsibleUserSql, responsibleAgentSql } from "../projectWork/index.js";
import { visibleRoomTranscriptSql, openHumanQuestionSql, attentionSessionReadSql } from "../sessions/index.js";
import type { WorkRunFacts } from "./semantics.js";
export interface WorkTarget {
  space_id: string;
  identity: AgentWorkItem["identity"];
}
export interface RunFact extends WorkRunFacts {
  agent_name?: string | null;
  runtime_key?: string | null;
  automation_id: string | null;
  workflow_execution_id: string | null;
  autonomy_tick_id: string | null;
  autonomy_candidate_id: string | null;
  contract_source: AgentWorkItem["runs"][number]["contract_source"];
  agent_id: string | null;
  status: AgentWorkItem["runs"][number]["status"];
  owner_user_id: string | null;
  instructed_by_user_id: string | null;
  project_id: string | null;
  room_id: string | null;
  group_title: string | null;
  session_readable: boolean;
  session_title: string | null;
  access_level: "full" | "summary";
  created_at: string;
  ended_at: string | null;
  started_at: string | null;
  attempt_id: string | null;
  result_at: string | null;
  retry_superseded: boolean;
  retry_of_run_id: string | null;
  run_role: "execution" | "coordinator";
  task_run_role: string | null;
  task_role: AgentWorkItem["runs"][number]["task_role"];
  plan_id: string | null;
  plan_node_id: string | null;
  authorization_request_id: string | null;
  authorization_pending: boolean;
  supervisor_review: boolean;
  message_id: string | null;
  message_revision: string | null;
  message_at: string | null;
  question_open: boolean;
  question_user_id: string | null;
  wait_quota: boolean;
  wait_turn: boolean;
  wait_scope: string | null;
  dependency_run_ids: string[];
  chat_completed: "succeeded" | "failed" | null;
  is_chat_turn: boolean;
}
export interface TaskFact {
  id: string;
  space_id: string;
  project_id: string | null;
  title: string;
  status: AgentWorkItem["task_status"];
  completed_at: string | null;
  updated_at: string;
  source_run_id: string | null;
  responsible_user_id: string | null;
  responsible_agent_id: string | null;
  access_level: "full" | "summary";
  loop_stage: AgentWorkItem["loop_stage"];
}
export interface ExtraSubject {
  run_id: string | null;
  task_id: string | null;
  space_id: string;
  subject: AgentAttentionRevision;
  reason: AgentWorkItem["reasons"][number];
  at: string;
}
export interface StoredRead {
  space_id: string;
  work_kind: string;
  work_source_id: string;
  read_subject_kind: string;
  read_subject_id: string;
  last_read_revision_json: AgentAttentionRevision | null;
  read_at: string | null;
  manual_unread: boolean;
  state_version: number;
  /** When this reading decision was last made; a later reply of the user's own outranks a manual unread. */
  updated_at: string;
}
/** The viewer's own latest message in a Session: replying is reading everything before it. */
export interface OwnActivity {
  space_id: string;
  session_id: string;
  at: string;
}
export function subjectId(subject: AgentAttentionRevision): string {
  switch (subject.kind) {
    case "message":
      return subject.message_id;
    case "run_result":
    case "run_decision":
      return subject.run_id;
    case "authorization":
      return subject.authorization_request_id;
    case "proposal":
      return subject.proposal_id;
    case "task":
      return subject.task_id;
    case "task_merge":
      return subject.merge_id;
  }
}
const level = (kind: string, alias: string) => contentAccessLevelSql({
  definition: contentResourceDefinition(kind)!,
  alias,
  userExpr: "$1"
});

/** Batched source queries and one neighbor query per frontier; no trace/event bodies. */
export class AgentAttentionRepository {
  constructor(readonly db: Queryable) {}
  async baseline(userId: string): Promise<string> {
    await this.db.query(`INSERT INTO agent_attention_baselines(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    const result = await this.db.query<{
      enabled_at: string;
    }>(`SELECT enabled_at::text FROM agent_attention_baselines WHERE user_id=$1`, [userId]);
    return new Date(result.rows[0]!.enabled_at).toISOString();
  }

  /** Only the authorized connected spectrum for item/PATCH; no user-wide facts. */
  async targetRunIds(userId: string, target: WorkTarget): Promise<string[]> {
    type Neighbor = {
      id: string;
      session_id: string | null;
      run_group_id: string | null;
      parent_run_id: string | null;
      root_run_id: string | null;
      cause_run_id: string | null;
      trigger_origin: string;
      model_override_json: { chat_turn?: { retry_of_run_id?: string } } | null;
    };
    const seedSql = target.identity.kind === "run" ? "SELECT id FROM runs WHERE space_id=$2 AND id=$3"
      : target.identity.kind === "agent_group" ? "SELECT id FROM runs WHERE space_id=$2 AND run_group_id=$3"
      : target.identity.kind === "session" ? `
        SELECT id FROM runs WHERE space_id=$2 AND session_id=$3
        UNION SELECT member.id FROM agent_run_groups g JOIN runs member
          ON member.run_group_id=g.id AND member.space_id=g.space_id
          WHERE g.space_id=$2 AND g.session_id=$3`
      : `
        SELECT run_id AS id FROM task_runs WHERE space_id=$2 AND task_id=$3
        UNION SELECT root_run_id FROM plans WHERE space_id=$2 AND source_task_id=$3
        UNION SELECT nr.run_id FROM plans p JOIN plan_versions v ON v.plan_id=p.id AND v.space_id=p.space_id
          JOIN plan_nodes n ON n.plan_version_id=v.id AND n.space_id=v.space_id
          JOIN plan_node_runs nr ON nr.plan_node_id=n.id AND nr.space_id=n.space_id
          WHERE p.space_id=$2 AND p.source_task_id=$3`;
    const seed = await this.db.query<Neighbor>(`SELECT r.id,r.session_id,r.run_group_id,
      r.parent_run_id,r.root_run_id,r.cause_run_id,r.trigger_origin,
      jsonb_build_object('chat_turn',jsonb_build_object('retry_of_run_id',
        r.model_override_json->'chat_turn'->>'retry_of_run_id')) AS model_override_json
      FROM (${seedSql}) candidate CROSS JOIN LATERAL (
        SELECT * FROM runs WHERE space_id=$2 AND id=candidate.id OFFSET 0
      ) r WHERE ${runReadSql("$1")}`,
      [userId, target.space_id, target.identity.source_id]);
    const visited = new Set<string>();
    const sessions = new Set<string>();
    const groups = new Set<string>();
    let frontier = seed.rows;
    while (frontier.length) {
      const ids: string[] = [], ancestors: string[] = [], sessionIds: string[] = [], groupIds: string[] = [];
      for (const run of frontier) {
        if (visited.has(run.id)) continue;
        visited.add(run.id);
        ids.push(run.id);
        for (const id of [run.parent_run_id, run.root_run_id,
          run.trigger_origin === "continuation" ? run.cause_run_id : null,
          run.model_override_json?.chat_turn?.retry_of_run_id]) {
          if (id && !visited.has(id)) ancestors.push(id);
        }
        if (run.session_id && !sessions.has(run.session_id)) {
          sessions.add(run.session_id);
          sessionIds.push(run.session_id);
        }
        if (run.run_group_id && !groups.has(run.run_group_id)) {
          groups.add(run.run_group_id);
          groupIds.push(run.run_group_id);
        }
      }
      if (!ids.length) break;
      // Each Session/group key is expanded once per traversal. OFFSET 0 keeps the
      // key lookup below the batch join: large arrays must not become Space scans.
      const neighbors = await this.db.query<Neighbor>(`WITH candidates AS MATERIALIZED (
        SELECT neighbor.id FROM unnest($3::varchar[]) key(id) CROSS JOIN LATERAL (
          SELECT id FROM runs WHERE space_id=$2 AND id=key.id OFFSET 0
        ) neighbor
        UNION SELECT neighbor.id FROM unnest($4::varchar[]) key(id) CROSS JOIN LATERAL (
          SELECT id FROM runs WHERE space_id=$2 AND parent_run_id=key.id OFFSET 0
        ) neighbor
        UNION SELECT neighbor.id FROM unnest($4::varchar[]) key(id) CROSS JOIN LATERAL (
          SELECT id FROM runs WHERE space_id=$2 AND root_run_id=key.id OFFSET 0
        ) neighbor
        UNION SELECT neighbor.id FROM unnest($4::varchar[]) key(id) CROSS JOIN LATERAL (
          SELECT id FROM runs WHERE space_id=$2 AND cause_run_id=key.id AND trigger_origin='continuation' OFFSET 0
        ) neighbor
        UNION SELECT neighbor.id FROM unnest($4::text[]) key(id) CROSS JOIN LATERAL (
          SELECT id FROM runs WHERE space_id=$2 AND model_override_json->'chat_turn'->>'retry_of_run_id'=key.id OFFSET 0
        ) neighbor
        UNION SELECT neighbor.id FROM unnest($5::varchar[]) key(id) CROSS JOIN LATERAL (
          SELECT id FROM runs WHERE space_id=$2 AND session_id=key.id OFFSET 0
        ) neighbor
        UNION SELECT neighbor.id FROM unnest($6::varchar[]) key(id) CROSS JOIN LATERAL (
          SELECT id FROM runs WHERE space_id=$2 AND run_group_id=key.id OFFSET 0
        ) neighbor
      ) SELECT r.id,r.session_id,r.run_group_id,r.parent_run_id,r.root_run_id,r.cause_run_id,r.trigger_origin,
        jsonb_build_object('chat_turn',jsonb_build_object('retry_of_run_id',r.model_override_json->'chat_turn'->>'retry_of_run_id')) AS model_override_json FROM candidates c CROSS JOIN LATERAL (
          SELECT * FROM runs WHERE space_id=$2 AND id=c.id OFFSET 0
        ) r WHERE ${runReadSql("$1")} ORDER BY r.id`,
        [userId, target.space_id, [...new Set(ancestors)], ids, sessionIds, groupIds]);
      frontier = neighbors.rows.filter(run => !visited.has(run.id));
    }
    return [...visited];
  }
  async facts(userId: string, target?: WorkTarget): Promise<{
    runs: RunFact[];
    tasks: TaskFact[];
    reads: StoredRead[];
    extras: ExtraSubject[];
    activity: OwnActivity[];
  }> {
    const selectedIds = target ? await this.targetRunIds(userId, target) : null;
    const runs = await this.db.query<RunFact>(`WITH readable AS MATERIALIZED (
      SELECT r.id,r.space_id,r.execution_kind,r.agent_id,r.status,r.owner_user_id,r.instructed_by_user_id,
        r.project_id,r.session_id,r.parent_run_id,r.root_run_id,r.cause_run_id,r.delegation_id,
        r.trigger_origin,r.run_role,r.run_group_id,r.created_at,r.started_at,r.ended_at,r.runtime_key,
        jsonb_build_object('waiting_for_quota',r.output_json->'waiting_for_quota' IS NOT NULL,
          'waiting_for_turn',r.output_json->'waiting_for_turn' IS NOT NULL) AS wait_flags,
        r.output_json->'waiting_for_results'->>'scope' AS wait_scope,
        r.output_json->'waiting_for_results'->'depends_on_run_ids' AS dependencies,
        CASE WHEN r.contract_snapshot_json->'source'->>'kind' IS NOT NULL THEN jsonb_build_object('kind',r.contract_snapshot_json->'source'->>'kind','id',r.contract_snapshot_json->'source'->>'id') END AS contract_source,
        r.model_override_json->'chat_turn'->>'retry_of_run_id' AS retry_of_run_id,
        r.model_override_json->'chat_turn'->>'schema_version'='chat_turn.v1' AS is_chat_turn,
        r.error_json->>'authorization_request_id' AS authorization_request_id,
        r.error_json->>'supervisor_review'='true' AS supervisor_review,
        ${level("run", "r")} AS effective_level
      FROM runs r WHERE ${runReadSql("$1")} AND ($2::varchar[] IS NULL OR r.id=ANY($2))
    )
    SELECT r.id,r.space_id,r.execution_kind,r.agent_id,r.status,r.owner_user_id,r.instructed_by_user_id,
      CASE WHEN r.effective_level='full' THEN left(agent.name,500) END AS agent_name,r.runtime_key,
      COALESCE(r.project_id,g.project_id,s.project_id) AS project_id,r.session_id,r.parent_run_id,r.root_run_id,r.cause_run_id,r.delegation_id,
      r.trigger_origin,r.run_role,r.run_group_id,r.contract_source,
      COALESCE(origin.automation_id,workflow_origin.automation_id) AS automation_id,COALESCE(origin.workflow_execution_id,workflow_origin.id) AS workflow_execution_id,ac.id AS autonomy_candidate_id,ac.launch_tick_id AS autonomy_tick_id,
      COALESCE((r.wait_flags->>'waiting_for_quota')::boolean,false) AS wait_quota,COALESCE((r.wait_flags->>'waiting_for_turn')::boolean,false) AS wait_turn,
      r.wait_scope,
      CASE WHEN jsonb_typeof(r.dependencies)='array' THEN r.dependencies ELSE '[]'::jsonb END AS dependency_run_ids,
      r.effective_level AS access_level,r.created_at::text,r.started_at::text,r.ended_at::text,
      CASE WHEN g.id IS NOT NULL THEN jsonb_build_object('id',g.id,'session_id',g.session_id) END AS "group",
      COALESCE(g.room_id,s.room_id) AS room_id,
      CASE WHEN r.effective_level='full'
        AND (COALESCE(g.session_id,r.session_id) IS NULL OR ${attentionSessionReadSql('s', '$1')})
        THEN left(g.title,500) END AS group_title,
      CASE WHEN r.effective_level='full' AND ${attentionSessionReadSql('s', '$1')} THEN left(s.title,500) END AS session_title,
      COALESCE(${attentionSessionReadSql('s', '$1')},false) AS session_readable,
      COALESCE(links.task_ids,'{}') AS task_ids, links.role AS task_run_role,
      CASE WHEN r.contract_source->>'kind'='task' THEN r.contract_source->>'id' END AS contract_task_id,
      plan_link.source_task_id AS plan_task_id,plan_link.plan_id,plan_link.plan_node_id,
      gm.role AS task_role,a.id AS attempt_id,a.ended_at::text AS result_at,
      r.retry_of_run_id,
      EXISTS (SELECT 1 FROM messages superseded WHERE superseded.space_id=r.space_id AND superseded.run_id=r.id AND superseded.role='assistant' AND superseded.metadata_json->>'retry_superseded'='true') AS retry_superseded,
      pending_authorization.id AS authorization_request_id,
      (r.authorization_request_id IS NULL OR pending_authorization.id IS NOT NULL) AS authorization_pending,
      COALESCE(r.supervisor_review,false) AS supervisor_review,
      m.id AS message_id,m.created_at::text AS message_at,
      CASE WHEN m.id IS NOT NULL THEN md5(COALESCE(a.id,'') || m.content || COALESCE(m.metadata_json->>'awaiting_answer','false')) END AS message_revision,
      ${openHumanQuestionSql("m", "r")} AS question_open,
      COALESCE(r.instructed_by_user_id,r.owner_user_id) AS question_user_id,
      completion.status AS chat_completed,
      COALESCE(r.is_chat_turn,false) AS is_chat_turn
    FROM readable r
    LEFT JOIN agents agent ON agent.id=r.agent_id AND agent.space_id=r.space_id
    LEFT JOIN agent_run_groups g ON g.id=r.run_group_id AND g.space_id=r.space_id
    LEFT JOIN sessions s ON s.id=COALESCE(g.session_id,r.session_id) AND s.space_id=r.space_id
    LEFT JOIN LATERAL (
      SELECT ar.automation_id,ar.workflow_execution_id FROM automation_runs ar
      JOIN automations auto ON auto.id=ar.automation_id AND auto.space_id=r.space_id
      WHERE ar.run_id=r.id ORDER BY ar.created_at DESC,ar.id LIMIT 1
    ) origin ON true
    LEFT JOIN LATERAL (
      SELECT execution.id,execution.automation_id FROM workflow_executions execution
      WHERE execution.space_id=r.space_id AND (execution.root_run_id=r.id OR EXISTS (
        SELECT 1 FROM workflow_execution_node_runs node_run JOIN workflow_execution_nodes node
          ON node.id=node_run.node_id AND node.space_id=node_run.space_id
        WHERE node_run.run_id=r.id AND node_run.space_id=r.space_id AND node.execution_id=execution.id
      )) ORDER BY execution.id LIMIT 1
    ) workflow_origin ON true
    LEFT JOIN LATERAL (SELECT candidate.id,candidate.launch_tick_id FROM autonomy_candidates candidate
      WHERE candidate.run_id=r.id AND candidate.space_id=r.space_id ORDER BY candidate.id LIMIT 1) ac ON true
    LEFT JOIN authorization_requests pending_authorization ON pending_authorization.id=r.authorization_request_id
      AND pending_authorization.space_id=r.space_id AND pending_authorization.run_id=r.id AND pending_authorization.status='pending'
    LEFT JOIN agent_run_group_members gm ON gm.group_id=r.run_group_id AND gm.agent_id=r.agent_id AND gm.space_id=r.space_id
    LEFT JOIN LATERAL (SELECT array_agg(DISTINCT tr.task_id) AS task_ids,min(tr.role) AS role
      FROM task_runs tr WHERE tr.run_id=r.id AND tr.space_id=r.space_id) links ON true
    LEFT JOIN LATERAL (
      SELECT linked.source_task_id,linked.plan_id,linked.plan_node_id FROM (
        SELECT p.source_task_id,p.id AS plan_id,pnr.plan_node_id,0 AS priority
        FROM plan_node_runs pnr JOIN plan_nodes pn ON pn.id=pnr.plan_node_id AND pn.space_id=pnr.space_id
        JOIN plan_versions pv ON pv.id=pn.plan_version_id AND pv.space_id=pn.space_id
        JOIN plans p ON p.id=pv.plan_id AND p.space_id=pv.space_id
        WHERE pnr.run_id=r.id AND pnr.space_id=r.space_id
        UNION ALL
        SELECT p.source_task_id,p.id,NULL::varchar,1 FROM plans p
        WHERE p.root_run_id=r.id AND p.space_id=r.space_id
      ) linked ORDER BY linked.priority,linked.plan_id,linked.plan_node_id LIMIT 1
    ) plan_link ON true
    LEFT JOIN LATERAL (SELECT ra.id,ra.ended_at FROM run_attempts ra
      WHERE ra.space_id=r.space_id AND ra.run_id=r.id ORDER BY ra.attempt_number DESC LIMIT 1) a ON true
    LEFT JOIN messages m ON m.run_id=r.id AND m.space_id=r.space_id AND m.role='assistant'
      AND r.effective_level='full'
      AND EXISTS (SELECT 1 FROM sessions message_session WHERE message_session.id=m.session_id AND message_session.space_id=m.space_id AND ${attentionSessionReadSql('message_session', '$1')})
      AND ${visibleRoomTranscriptSql({
      alias: "m",
      spaceParam: "r.space_id",
      sessionParam: "r.session_id"
    })}
    LEFT JOIN LATERAL (SELECT e.status FROM run_events e WHERE e.space_id=r.space_id AND e.run_id=r.id
      AND e.event_type='chat_completed' ORDER BY e.event_index DESC LIMIT 1) completion ON true ORDER BY r.id`, [userId, selectedIds]);
    // Authorize referenced dependencies in one batch, independently of target membership.
    const dependencyIds = [...new Set(runs.rows.flatMap(run => run.dependency_run_ids))];
    if (dependencyIds.length) {
      const dependencies = await this.db.query<{ id: string; space_id: string }>(
        `SELECT r.id,r.space_id FROM runs r WHERE r.id=ANY($2::varchar[]) AND ${runReadSql("$1")}`,
        [userId, dependencyIds]);
      const readableDependencies = new Map(dependencies.rows.map(run => [run.id, run.space_id]));
      for (const run of runs.rows) {
        run.dependency_run_ids = run.dependency_run_ids.filter(id => readableDependencies.get(id) === run.space_id);
      }
    }
    const runIds = runs.rows.map(run => run.id);
    const taskIds = [...new Set(runs.rows.flatMap(run => [...(run.task_ids ?? []), ...(run.plan_task_id ? [run.plan_task_id] : [])]))];
    const tasks = await this.db.query<TaskFact>(`SELECT t.id,t.space_id,t.project_id,left(t.title,500) AS title,t.status,
      t.completed_at::text,t.updated_at::text,t.source_run_id,
      ${responsibleUserSql("t", "p")} AS responsible_user_id,
      ${responsibleAgentSql("t")} AS responsible_agent_id,
      ${level("task", "t")} AS access_level,ls.current_stage_key AS loop_stage
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id AND p.space_id=t.space_id
      LEFT JOIN task_loop_states ls ON ls.task_id=t.id AND ls.space_id=t.space_id
      WHERE t.deleted_at IS NULL AND t.id=ANY($2::varchar[]) AND ${contentReadSql("task", "t", "$1")}`, [userId, taskIds]);
    // A Session-targeted view may resolve to a Task-owned work. Include those
    // authorized messages' stored decisions so their CAS versions are not lost.
    const messageIds = runs.rows.flatMap(run => run.message_id ? [run.message_id] : []);
    const reads = await this.db.query<StoredRead>(`SELECT space_id,work_kind,work_source_id,read_subject_kind,read_subject_id,
      last_read_revision_json,read_at::text,manual_unread,state_version,updated_at::text FROM agent_attention_read_states WHERE user_id=$1
      AND ($2::text IS NULL OR (space_id=$2 AND ((work_kind=$3 AND work_source_id=$4)
        OR (read_subject_kind='message' AND read_subject_id=ANY($5::varchar[])))))`, [userId, target?.space_id ?? null, target?.identity.kind ?? null, target?.identity.source_id ?? null, messageIds]);
    const extras = await this.db.query<ExtraSubject>(`SELECT p.created_by_run_id AS run_id,NULL::text AS task_id,p.space_id,
      jsonb_build_object('kind','proposal','schema_version',1,'proposal_id',p.id,'revision',p.updated_at::text) AS subject,
      jsonb_build_object('kind','proposal','proposal_id',p.id,'responsible',
        jsonb_build_object('kind',CASE WHEN COALESCE(r.instructed_by_user_id,r.owner_user_id) IS NOT NULL THEN 'user' END,
          'id',COALESCE(r.instructed_by_user_id,r.owner_user_id),'display_name',NULL)) AS reason,p.updated_at::text AS at
      FROM proposals p JOIN runs r ON r.id=p.created_by_run_id AND r.space_id=p.space_id
      WHERE p.created_by_run_id=ANY($3::varchar[]) AND p.status='pending' AND (p.expires_at IS NULL OR p.expires_at>now())
        AND ${proposalReadSql("$1")} AND ${runReadSql("$1")}
        AND ${level("proposal", "p")}='full' AND ${level("run", "r")}='full'
      UNION ALL
      SELECT NULL,m.task_id,m.space_id,
        jsonb_build_object('kind','task_merge','schema_version',1,'merge_id',m.id,'revision',m.updated_at::text),
        jsonb_build_object('kind','task_merge','task_id',m.task_id,'merge_id',m.id,'code',e.data_json->>'reason',
          'responsible',jsonb_build_object('kind','user','id',m.requested_by_user_id,'display_name',NULL)),m.updated_at::text
      FROM task_merges m JOIN tasks t ON t.id=m.task_id AND t.space_id=m.space_id
      JOIN LATERAL (SELECT data_json FROM project_work_events e
        WHERE e.space_id=m.space_id AND e.subject_id=m.task_id AND e.event_kind='task.merge_blocked'
          AND e.data_json->>'merge_id'=m.id ORDER BY e.created_at DESC LIMIT 1) e ON true
      WHERE m.task_id=ANY($4::varchar[]) AND m.status=ANY($2::text[]) AND t.deleted_at IS NULL
        AND ${contentReadSql("task", "t", "$1")} AND ${level("task", "t")}='full'`, [userId, STOPPED_MERGE_STATUSES, runIds, taskIds]);
    const sessionKeys = [...new Map(runs.rows.flatMap(run => [run.session_id, run.group?.session_id]
      .flatMap(id => id ? [[`${run.space_id}:${id}`, [run.space_id, id]] as const] : []))).values()];
    // Keyed by (space_id, session_id) so each Session probes ix_messages_space_session_created.
    const activity = sessionKeys.length ? await this.db.query<OwnActivity>(`SELECT k.space_id,k.session_id,max(m.created_at)::text AS at
      FROM unnest($2::varchar[],$3::varchar[]) k(space_id,session_id)
      JOIN messages m ON m.space_id=k.space_id AND m.session_id=k.session_id AND m.user_id=$1 AND m.role='user'
      GROUP BY k.space_id,k.session_id`, [userId, sessionKeys.map(([space]) => space), sessionKeys.map(([, session]) => session)]) : { rows: [] as OwnActivity[] };
    return {
      runs: runs.rows,
      tasks: tasks.rows,
      reads: reads.rows,
      extras: extras.rows,
      activity: activity.rows
    };
  }

  /** Sort/count/page over application-projected summaries; source eligibility is not pushed down. */
  async page(candidates: AgentWorkItem[], query: AgentAttentionQuery, now: string): Promise<AgentAttentionPage> {
    return (await this.pageWithSignals(candidates, query, now)).page;
  }

  async pageWithSignals(candidates: AgentWorkItem[], query: AgentAttentionQuery, now: string) {
    const filter = createHash("sha256").update(JSON.stringify({
      scope: query.scope,
      space: query.space_id ?? null,
      project: query.project_id ?? null,
      group: query.group ?? null,
      view: query.view,
      since: query.since ?? null,
      until: query.until ?? null
    })).digest("hex");
    let cursor: {
      rank: number;
      at: string;
      key: string;
      filter: string;
    } | null = null;
    if (query.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (!cursor || cursor.filter !== filter || !Number.isInteger(cursor.rank) || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.key !== "string") throw new Error();
      } catch {
        throw new HttpError(422, "Invalid attention cursor");
      }
    }
    const result = await this.db.query<{
      items: AgentWorkItem[];
      counts: AgentAttentionPage["counts"];
      next_cursor: string | null;
      unread_count: number;
      eligible_keys: string[];
    }>(`
      WITH candidates AS (SELECT value AS item FROM jsonb_array_elements($1::jsonb)),
      eligible AS MATERIALIZED (
        SELECT item, array_position(ARRAY['needs_you','recently_finished','working','waiting','idle'],item->>'group') AS rank,
          (item->>'last_activity_at')::timestamptz AS at,item->>'work_key' AS key
        FROM candidates WHERE ($2::text='all_visible' OR (item->>'mine')::boolean)
          AND ($3::text IS NULL OR item->>'space_id'=$3)
          AND ($4::text IS NULL OR item->>'project_id'=$4)
          AND ($5::text='history' OR item->>'group' IN ('needs_you','working','waiting') OR (item->>'unread')::boolean
            OR (item->>'last_activity_at')::timestamptz >= $6::timestamptz - interval '24 hours')
          AND ($7::timestamptz IS NULL OR (item->>'last_activity_at')::timestamptz >= $7)
          AND ($8::timestamptz IS NULL OR (item->>'last_activity_at')::timestamptz < $8)
      ), numbered AS (
        SELECT * FROM eligible WHERE ($9::text IS NULL OR item->>'group'=$9)
          AND ($10::int IS NULL OR rank>$10 OR (rank=$10 AND at<$11::timestamptz)
            OR (rank=$10 AND at=$11::timestamptz AND key>$12))
        ORDER BY rank,at DESC,key LIMIT $13
      )
      SELECT COALESCE((SELECT jsonb_agg(item ORDER BY rank,at DESC,key) FROM numbered),'[]') AS items,
        (SELECT jsonb_build_object('needs_you',count(*) FILTER(WHERE item->>'group'='needs_you'),
          'recently_finished',count(*) FILTER(WHERE item->>'group'='recently_finished'),
          'working',count(*) FILTER(WHERE item->>'group'='working'),
          'waiting',count(*) FILTER(WHERE item->>'group'='waiting'),
          'idle',count(*) FILTER(WHERE item->>'group'='idle')) FROM eligible) AS counts,
        (SELECT count(*)::int FROM eligible WHERE (item->>'unread')::boolean) AS unread_count,
        COALESCE((SELECT jsonb_agg(key ORDER BY key) FROM eligible),'[]') AS eligible_keys`, [JSON.stringify(candidates), query.scope, query.space_id ?? null, query.project_id ?? null, query.view, now, query.since ?? null, query.until ?? null, query.group ?? null, cursor?.rank ?? null, cursor?.at ?? null, cursor?.key ?? null, query.limit + 1]);
    const {
      items,
      counts
    } = result.rows[0]!;
    const hasMore = items.length > query.limit;
    items.length = Math.min(items.length, query.limit);
    const last = items.at(-1);
    const next = hasMore && last ? Buffer.from(JSON.stringify({
      rank: ["needs_you", "recently_finished", "working", "waiting", "idle"].indexOf(last.group) + 1,
      at: last.last_activity_at,
      key: last.work_key,
      filter
    })).toString("base64url") : null;
    return { page: { items, counts, next_cursor: next, as_of: now } satisfies AgentAttentionPage,
      unread_count: result.rows[0]!.unread_count, eligible_keys: result.rows[0]!.eligible_keys };
  }
  /**
   * Insert a first reading decision or compare-and-swap an existing one, in one
   * statement: version 0 may only create an absent row, a later version may only
   * update the row at exactly that version. Anything else is a stale decision
   * and returns null. Callers serialize per subject with the advisory lock.
   */
  async writeRead(userId: string, input: AgentAttentionReadRequest): Promise<StoredRead | null> {
    const result = await this.db.query<StoredRead>(`INSERT INTO agent_attention_read_states
      (id,user_id,space_id,work_kind,work_source_id,read_subject_kind,read_subject_id,last_read_revision_json,read_at,manual_unread,state_version)
      SELECT $1,$2,$3,$4,$5,$6,$7,CASE WHEN $9='read' THEN $8::jsonb END,CASE WHEN $9='read' THEN now() END,$9='unread',1
      WHERE $10::int=0 OR EXISTS (SELECT 1 FROM agent_attention_read_states
        WHERE user_id=$2::varchar AND space_id=$3::varchar AND work_kind=$4::varchar AND work_source_id=$5::varchar AND read_subject_kind=$6::varchar AND read_subject_id=$7::varchar)
      ON CONFLICT (user_id,space_id,work_kind,work_source_id,read_subject_kind,read_subject_id) DO UPDATE SET
        last_read_revision_json=CASE WHEN $9='read' THEN $8::jsonb ELSE agent_attention_read_states.last_read_revision_json END,
        read_at=CASE WHEN $9='read' THEN now() ELSE agent_attention_read_states.read_at END,
        manual_unread=$9='unread',state_version=agent_attention_read_states.state_version+1,updated_at=now()
      WHERE agent_attention_read_states.state_version=$10
      RETURNING *,read_at::text,updated_at::text`, [randomUUID(), userId, input.space_id, input.identity.kind, input.identity.source_id, input.subject.kind, subjectId(input.subject), JSON.stringify(input.subject), input.action, input.state_version]);
    return result.rows[0] ?? null;
  }
}
