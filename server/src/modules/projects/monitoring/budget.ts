import { monitoringRelevanceInstruction } from './repository.js';
import { MonitoringAdmissionError, checkMonitoringPermission } from './admission.js';
import { assertSourceConnectionManageable } from '../../sources/sourceConnectionAccess.js';
import { fingerprintOf } from '../projectOperationIdempotency.js';
import { assertProjectWriter } from '../access.js';
import { randomUUID } from 'node:crypto';
import { ProjectMonitoringConfigSchema } from '@rainver/protocol';
import { withQueryableTransaction, type Queryable } from '../../routeUtils/common.js';
import { digestPeriod } from '../../informationDigest/digestPeriod.js';
export type MonitoringDimension = 'candidates' | 'pages' | 'source_requests' | 'model_runs';
/** A pending/declined draft must not take control of an existing manual Source. */
export function monitoringChannelControlClause(spaceExpr: string, channelExpr: string): string {
  return `EXISTS(SELECT 1 FROM project_information_monitoring_versions mv JOIN projects mp ON mp.id=mv.project_id AND mp.space_id=mv.space_id LEFT JOIN proposals approval ON approval.id=mv.proposal_id AND approval.space_id=mv.space_id WHERE mv.space_id=${spaceExpr} AND mv.source_channel_id=${channelExpr} AND (approval.status='accepted' OR mp.active_information_monitoring_version_id=mv.id))`;
}
export async function monitoringChannel(db: Queryable, spaceId: string, channelId: string): Promise<boolean> {
  const rows = await db.query(`SELECT 1 WHERE ${monitoringChannelControlClause('$1', '$2')}`, [spaceId, channelId]);
  return rows.rows.length > 0;
}
export async function monitoringPlan(db: Queryable, spaceId: string, planId: string) {
  const r = await db.query<{
    id: string;
    project_id: string;
    config_json: unknown;
  }>(`SELECT id,project_id,config_json FROM project_information_monitoring_versions WHERE space_id=$1 AND (backfill_plan_id=$2 OR id=(SELECT strategy_json->>'information_monitoring_version_id' FROM source_backfill_plans WHERE id=$2 AND space_id=$1)) ORDER BY version DESC LIMIT 1`, [spaceId, planId]);
  return r.rows[0] ?? null;
}
export function localMonitoringDate(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = (type: string) => parts.find(p => p.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
/** Short atomic admission; the ordinary operation and work rows remain the audit. Unknown sends stay charged. */
export async function consumeMonitoringBudget(db: Queryable, spaceId: string, operationId: string, dimension: MonitoringDimension, amount: number): Promise<void> {
  return consumeMonitoringBudgets(db, spaceId, operationId, {
    [dimension]: amount
  });
}
/** Admit a first physical request and its page/slots together, or charge none of them. */
export async function consumeMonitoringBudgets(db: Queryable, spaceId: string, operationId: string, amounts: Partial<Record<MonitoringDimension, number>>): Promise<void> {
  await withQueryableTransaction(db, async tx => {
    // Every monitoring admission takes Project first, then the operations. No IO under locks.
    const found = await tx.query<{
      project_id: string;
    }>(`SELECT project_id FROM project_operations WHERE id=$1 AND space_id=$2 AND progress_json->>'purpose'='information_monitoring'`, [operationId, spaceId]);
    const projectId = found.rows[0]?.project_id;
    if (!projectId) throw new MonitoringAdmissionError('operation_missing');
    const p = await tx.query<{
      information_monitoring_paused: number;
      active_information_monitoring_version_id: string;
    }>(`SELECT information_monitoring_paused,active_information_monitoring_version_id FROM projects WHERE id=$1 AND space_id=$2 AND status='active' FOR UPDATE`, [projectId, spaceId]);
    if (!p.rows[0]) throw new MonitoringAdmissionError('project_inactive');
    if (p.rows[0].information_monitoring_paused) throw new MonitoringAdmissionError('paused');
    const r = await tx.query<{
      progress_json: Record<string, unknown>;
      status: string;
      created_by_user_id: string;
    }>(`SELECT progress_json,status,created_by_user_id FROM project_operations WHERE id=$1 AND space_id=$2 FOR UPDATE`, [operationId, spaceId]);
    const op = r.rows[0];
    if (!op || op.status !== 'active') throw new MonitoringAdmissionError('operation_inactive');
    if (op.progress_json.dispatch_until && Date.now() >= Date.parse(String(op.progress_json.dispatch_until))) throw new MonitoringAdmissionError('window_closed');
    if (op.progress_json.budget_period_end && Date.now() >= Date.parse(String(op.progress_json.budget_period_end))) throw new MonitoringAdmissionError('window_closed');
    await checkMonitoringPermission(() => assertProjectWriter(tx, spaceId, projectId, op.created_by_user_id));
    const frozen = await tx.query<{
      source_connection_id: string;
    }>(`SELECT sc.id AS source_connection_id FROM project_information_monitoring_versions v LEFT JOIN source_search_specs ss ON ss.source_channel_id=v.source_channel_id AND ss.space_id=v.space_id JOIN source_channels ch ON ch.id=v.source_channel_id AND ch.space_id=v.space_id JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id WHERE v.id=$1 AND v.space_id=$2 AND COALESCE(ss.query_fingerprint,ch.query_fingerprint)=v.query_fingerprint AND ss.research_query_attempt_id IS NULL AND ch.status='active' AND ch.fetch_frequency='manual' AND sc.status='active' AND sc.capture_policy='reference_only' AND (COALESCE(v.config_json->>'incremental_strategy','new_items')<>'page_changes' OR sc.policy_json->>'retention_policy' IN ('full_text','full_snapshot')) AND EXISTS(SELECT 1 FROM project_source_bindings b WHERE b.project_id=v.project_id AND b.space_id=v.space_id AND b.source_channel_id=v.source_channel_id AND b.status='active' AND b.standing_comparison_enabled=false)`, [op.progress_json.version_id, spaceId]);
    if (!frozen.rows[0]) throw new MonitoringAdmissionError('source_changed');
    await checkMonitoringPermission(() => assertSourceConnectionManageable(tx, {
      spaceId,
      userId: op.created_by_user_id
    }, frozen.rows[0]!.source_connection_id));
    const cfg = ProjectMonitoringConfigSchema.parse(op.progress_json.config);
    const latest = await tx.query<{
      config_json: unknown;
    }>(`SELECT config_json FROM project_information_monitoring_versions WHERE id=$1 AND space_id=$2`, [p.rows[0].active_information_monitoring_version_id, spaceId]);
    const current = latest.rows[0] ? ProjectMonitoringConfigSchema.parse(latest.rows[0].config_json) : cfg;
    const day = localMonitoringDate(cfg.timezone);
    const period = digestPeriod(day, cfg.timezone);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`monitoring-budget:${spaceId}:${projectId}`]);
    const gate = await tx.query<{
      id: string;
      progress_json: Record<string, unknown>;
    }>(`SELECT id,progress_json FROM project_operations WHERE space_id=$1 AND project_id=$2 AND progress_json->>'purpose'='information_monitoring_budget' AND ((progress_json->>'period_start')::timestamptz<=now() AND (progress_json->>'period_end')::timestamptz>now()) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [spaceId, projectId]);
    let row = gate.rows[0];
    if (!row) {
      const previous = await tx.query<{
        period_end: string;
      }>(`SELECT progress_json->>'period_end' AS period_end FROM project_operations WHERE space_id=$1 AND project_id=$2 AND progress_json->>'purpose'='information_monitoring_budget' ORDER BY (progress_json->>'period_end')::timestamptz DESC LIMIT 1`, [spaceId, projectId]);
      // A timezone change cannot create an overlapping second allowance after the old window ends.
      if (previous.rows[0] && Date.parse(previous.rows[0].period_end) > Date.parse(period.startUtc)) throw new MonitoringAdmissionError('budget');
      const id = randomUUID();
      const progress = {
        projection_mode: 'managed',
        purpose: 'information_monitoring_budget',
        date: day,
        period_start: period.startUtc,
        period_end: period.endUtc,
        used: {}
      };
      await tx.query(`INSERT INTO project_operations(id,space_id,project_id,kind,title,status,progress_json,created_at,updated_at) VALUES($1,$2,$3,'custom','Monitoring daily budget','completed',$4::jsonb,now(),now())`, [id, spaceId, projectId, JSON.stringify(progress)]);
      row = {
        id,
        progress_json: progress
      };
    }
    const daily = (row.progress_json.used ?? {}) as Record<string, number>;
    if (!op.progress_json.budget_period_end) await tx.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('budget_period_end',$3::text) WHERE id=$1 AND space_id=$2`, [operationId, spaceId, row.progress_json.period_end]);
    const used = (op.progress_json.used ?? {}) as Record<string, number>;
    for (const [key, amount] of Object.entries(amounts)) {
      const dimension = key as MonitoringDimension;
      if (!Number.isInteger(amount) || amount < 1 || (daily[dimension] ?? 0) + amount > Math.min(cfg.daily[dimension], current.daily[dimension]) || (used[dimension] ?? 0) + amount > Math.min(cfg.batch[dimension], current.batch[dimension])) throw new MonitoringAdmissionError('budget');
    }
    for (const [key, amount] of Object.entries(amounts)) {
      const dimension = key as MonitoringDimension;
      daily[dimension] = (daily[dimension] ?? 0) + amount;
      used[dimension] = (used[dimension] ?? 0) + amount;
    }
    await tx.query(`UPDATE project_operations SET progress_json=jsonb_set(progress_json,'{used}',$3::jsonb),updated_at=now() WHERE id=ANY($1::varchar[]) AND space_id=$2`, [[row.id], spaceId, JSON.stringify(daily)]);
    await tx.query(`UPDATE project_operations SET progress_json=jsonb_set(progress_json,'{used}',$3::jsonb),updated_at=now() WHERE id=$1 AND space_id=$2`, [operationId, spaceId, JSON.stringify(used)]);
  });
}

/** Sources supplies the actual rule; the Project compares it to the frozen execution contract. */
export async function assertMonitoringProcessingContract(db: Queryable, spaceId: string, operationId: string, input: {
  channelId: string;
  ruleId: string | null;
  agentId: string;
  profile: unknown;
  summaryGoal: string | null;
  outputInstructions: string | null;
}): Promise<void> {
  const r = await db.query<{
    config_json: unknown;
    rule_config_json: unknown;
    rule_id: string;
    source_channel_id: string;
  }>(`SELECT v.config_json,(SELECT origin.config_json FROM project_information_monitoring_versions origin WHERE origin.rule_id=v.rule_id AND origin.space_id=v.space_id ORDER BY origin.version LIMIT 1) AS rule_config_json,v.rule_id,v.source_channel_id FROM project_operations o JOIN project_information_monitoring_versions v ON v.id=o.progress_json->>'version_id' AND v.space_id=o.space_id WHERE o.id=$1 AND o.space_id=$2 AND o.status='active' AND o.progress_json->>'purpose'='information_monitoring'`, [operationId, spaceId]);
  const row = r.rows[0];
  if (!row) throw new MonitoringAdmissionError('operation_inactive');
  const cfg = ProjectMonitoringConfigSchema.parse(row.config_json);
  const profile = {
    enabled: true,
    objective: cfg.objective,
    include_criteria: cfg.include,
    exclude_criteria: cfg.exclude,
    must_have: [],
    nice_to_have: []
  };
  if (row.rule_id !== input.ruleId || row.source_channel_id !== input.channelId || cfg.agent_id !== input.agentId || input.summaryGoal !== cfg.objective || input.outputInstructions !== monitoringRelevanceInstruction(ProjectMonitoringConfigSchema.parse(row.rule_config_json)) || fingerprintOf(input.profile) !== fingerprintOf(profile)) throw new MonitoringAdmissionError('source_changed');
}
