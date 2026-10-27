import { SourceBackfillExecutionService } from '../../sources/sourceBackfillExecutionService.js';
import { localMonitoringDate } from './budget.js';
import { computeNextRunAt } from '../../automations/schedule.js';
import { PgSchedulerTaskStore } from '../../scheduler/taskStore.js';
import { MONITORING_TASK } from '../../sources/monitoring/schedule.js';
import { prepareMonitoringRecent } from '../../sources/monitoring/recent.js';
import { reconcileStoppedMonitoring, stoppedMonitoringJob } from './lifecycle.js';
import { contentDecisionFromDb } from '../../access/contentAccessQuery.js';
import { inheritContentAccessGrants } from '../../access/contentAccessInheritance.js';
import { monitoringDetailsOnly } from './details.js';
import { SourceChannelService } from '../../sources/channels/sourceChannelService.js';
import { randomUUID } from 'node:crypto';
import { ProposeProjectMonitoringSchema, MonitoringDetailsSchema, MonitoringRunRequestSchema, MonitoringSourceSetupSchema, type ProjectMonitoringState } from '@rainver/protocol';
import type { ServerConfig } from '../../../config.js';
import { HttpError, parseBody, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from '../../routeUtils/common.js';
import { assertProjectWriter, assertProjectReadable, lockActiveProjectForMutation, canWriteProject } from '../access.js';
import { ProjectSourceProposalService } from '../projectSourceProposalService.js';
import { SourceBackfillPlanningService } from '../../sources/sourceBackfillService.js';
import { assertSourceConnectionManageable } from '../../sources/sourceConnectionAccess.js';
import { insertProposalRow } from '../../proposals/reviewPackets.js';
import { advisoryLock, findIdempotentOperation, fingerprintOf } from '../projectOperationIdempotency.js';
import { PgJobQueueRepository } from '../../jobs/repository.js';
import { appendVersion, getVersion, versionOut, type VersionRow } from './repository.js';
import { monitoringCandidates, monitoringFeedback } from '../../sources/monitoring/candidates.js';
export class ProjectMonitoringService {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {}
  async setup(identity: SpaceUserIdentity, projectId: string, input: unknown) {
    const body = parseBody(MonitoringSourceSetupSchema, input);
    return new ProjectSourceProposalService(this.db, this.config).proposeSourceSetup(identity, projectId, {
      idempotency_key: `monitoring:${body.idempotency_key}`,
      source: {
        provider_key: ({rss:'generic_rss',atom:'generic_atom',web_page:'generic_web_page'} as Record<string,string>)[body.provider_key ?? ''] ?? 'arxiv',
        project_id: projectId,
        visibility: 'space_shared',
        name: `Monitoring ${body.idempotency_key}`,
        source_name: `Monitoring ${body.idempotency_key}`,
        query: {
          ...(!body.provider_key || body.provider_key === 'arxiv' ? {search_query: body.query} : {endpoint_url: body.query})
        },
        fetch_frequency: 'manual',
        capture_policy: 'reference_only',
        config: {
          daily_inbox_briefing: false
        },
        ...(body.provider_key === 'web_page' ? {policy:{retention_policy:'full_text'}} : {}),
        _force_create: true
      },
      binding: {
        project_id: projectId,
        standing_comparison_enabled: false,
        extraction_policy: {
          profile_key: 'generic_document_v1'
        }
      }
    });
  }
  async propose(identity: SpaceUserIdentity, projectId: string, input: unknown, actor: {
    agentId?: string | null;
    runId?: string | null;
    proposalKind?: 'scope' | 'details';
    visibility?: 'private' | 'selected_users' | 'space_shared';
  } = {}) {
    const body = parseBody(ProposeProjectMonitoringSchema, input);
    return withQueryableTransaction(this.db, async tx => {
      await assertProjectWriter(tx, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(tx, identity.spaceId, projectId);
      await advisoryLock(tx, identity.spaceId, 'monitoring-config', `${projectId}:${body.idempotency_key}`);
      const previous = await tx.query<{
        id: string;
        payload_json: Record<string, unknown>;
      }>(`SELECT id,payload_json FROM proposals WHERE space_id=$1 AND project_id=$2 AND proposal_type IN ('project_information_monitoring_activation','project_information_monitoring_details') AND action_idempotency_key=$3`, [identity.spaceId, projectId, body.idempotency_key]);
      if (previous.rows[0]) {
        if (previous.rows[0].payload_json.request_hash !== fingerprintOf(body)) throw new HttpError(409, 'Idempotency key has different parameters');
        return {
          proposal: previous.rows[0]
        };
      }
      const project = await tx.query<{
        active_information_monitoring_version_id: string | null;
      }>(`SELECT active_information_monitoring_version_id FROM projects WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId]);
      if (project.rows[0]?.active_information_monitoring_version_id !== body.expected_active_version_id) throw new HttpError(409, 'Monitoring version changed');
      if (actor.proposalKind === 'details' && !body.expected_active_version_id) throw new HttpError(422, "An active version is required for details");
      if (body.expected_active_version_id && actor.proposalKind !== 'scope') {
        const current = await getVersion(tx, identity.spaceId, projectId, body.expected_active_version_id);
        if (monitoringDetailsOnly(versionOut(current).config, body.config)) {
          const version = await appendVersion(tx, identity.spaceId, projectId, identity.userId, body.config, current);
          const proposal = await insertProposalRow(tx, {
            spaceId: identity.spaceId,
            projectId,
            proposalType: 'project_information_monitoring_details',
            title: 'Update monitoring details within approved scope',
            rationale: 'Presentation changes and lower limits retain the approved source and history scope.',
            payload: {
              proposal_type: 'project_information_monitoring_details',
              version_id: version.id,
              config_hash: version.config_hash,
              expected_active_version_id: body.expected_active_version_id,
              request_hash: fingerprintOf(body)
            },
            createdByUserId: identity.userId,
            createdByAgentId: actor.agentId ?? null,
            createdByRunId: actor.runId ?? null,
            visibility: actor.visibility ?? 'space_shared',
            ownerUserId: identity.userId,
            requiredApproverRole: 'reviewer',
            riskLevel: 'low',
            actionIdempotencyKey: body.idempotency_key
          });
          if (actor.visibility === 'selected_users' && actor.runId) await inheritContentAccessGrants(tx, {
            spaceId: identity.spaceId,
            sourceResourceType: 'run',
            sourceResourceId: actor.runId,
            targetResourceType: 'proposal',
            targetResourceId: proposal.id,
            inheritedAt: new Date().toISOString()
          });
          await tx.query(`UPDATE project_information_monitoring_versions SET proposal_id=$3 WHERE id=$1 AND space_id=$2`, [version.id, identity.spaceId, proposal.id]);
          await tx.query(`UPDATE proposals SET status='superseded',updated_at=now() WHERE space_id=$1 AND project_id=$2 AND proposal_type IN ('project_information_monitoring_activation','project_information_monitoring_details') AND status='pending' AND id<>$3`, [identity.spaceId, projectId, proposal.id]);
          return {
            version: versionOut({
              ...version,
              proposal_id: String(proposal.id)
            }),
            proposal,
            dependencies: []
          };
        }
        if (actor.proposalKind === 'details') throw new HttpError(422, 'Details cannot change execution scope');
      }
      const source = await requireMonitoringSource(tx, identity, projectId, body.config.source_channel_id);
      if ((source.connector_key === 'web_page') !== (body.config.incremental_strategy === 'page_changes')) throw new HttpError(422, 'Fixed pages require page_changes; feeds and searches require new_items');
      if (source.connector_key === 'arxiv_api' && Date.parse(body.config.to) > Date.now()) throw new HttpError(422, 'History end must not be in the future');
      const version = await appendVersion(tx, identity.spaceId, projectId, identity.userId, body.config);
      const priorVersion = body.expected_active_version_id ? await getVersion(tx, identity.spaceId, projectId, body.expected_active_version_id) : null;
      const previousConfig = priorVersion ? versionOut(priorVersion).config : null;
      const reusePlan = priorVersion && previousConfig && priorVersion.source_channel_id === body.config.source_channel_id && priorVersion.query_fingerprint === version.query_fingerprint && previousConfig.from === body.config.from && previousConfig.to === body.config.to && previousConfig.total_candidates === body.config.total_candidates;
      let plan: {
        id: string;
      };
      let history: {
        proposal: {
          id: string;
        };
      };
      let dependencies: Record<string, unknown>[] = [];
      if (reusePlan) {
        const approved = await tx.query<{
          id: string;
          proposal_id: string;
        }>(`SELECT p.id,p.proposal_id FROM source_backfill_plans p JOIN proposals pr ON pr.id=p.proposal_id AND pr.space_id=p.space_id WHERE p.id=$1 AND p.space_id=$2 AND pr.status='accepted'`, [priorVersion.backfill_plan_id, identity.spaceId]);
        if (!approved.rows[0]) throw new HttpError(409, 'Existing history approval is unavailable');
        plan = {
          id: approved.rows[0].id
        };
        history = {
          proposal: {
            id: approved.rows[0].proposal_id
          }
        };
        await tx.query(`UPDATE project_information_monitoring_versions SET backfill_plan_id=$3 WHERE id=$1 AND space_id=$2`, [version.id, identity.spaceId, plan.id]);
      } else {
        const planner = new SourceBackfillPlanningService(tx, this.config);
        const planned = await planner.create(identity, body.config.source_channel_id, {
          idempotency_key: `monitoring:${version.id}`,
          project_source_binding_id: source.binding_id,
          strategy: {
            window_unit: source.connector_key === 'arxiv_api' ? 'date_window' : 'page_cursor',
            history_mode: source.connector_key === 'arxiv_api' ? 'bounded_range' : 'current_snapshot',
            from: body.config.from,
            to: body.config.to,
            max_items: body.config.total_candidates,
            window_size: 365
          },
          quota_policy: {
            window: 'minute',
            limit_count: 10
          }
        });
        plan = {
          id: String(planned.id)
        };
        await tx.query(`UPDATE project_information_monitoring_versions SET backfill_plan_id=$3 WHERE id=$1 AND space_id=$2`, [version.id, identity.spaceId, plan.id]);
        await tx.query(`UPDATE source_backfill_plans SET strategy_json=strategy_json||jsonb_build_object('information_monitoring_version_id',$3::text) WHERE id=$1 AND space_id=$2`, [plan.id, identity.spaceId, version.id]);
        // The version now owns the plan before start is proposed: its ordinary applier must defer execution.
        const proposedHistory = await planner.proposeStart(identity, body.config.source_channel_id, String(plan.id), {
          projectId
        });
        history = {
          proposal: {
            id: String(proposedHistory.proposal.id)
          }
        };
        dependencies = [proposedHistory.proposal];
      }
      const proposal = await insertProposalRow(tx, {
        spaceId: identity.spaceId,
        projectId,
        proposalType: 'project_information_monitoring_activation',
        rationale: 'Confirm the frozen scope and bounded manual execution; source approvals remain independent.',
        title: 'Confirm bounded Project information monitoring',
        payload: {
          proposal_type: 'project_information_monitoring_activation',
          action_id: 'project.monitoring.propose',
          version_id: version.id,
          config_hash: version.config_hash,
          expected_active_version_id: body.expected_active_version_id,
          request_hash: fingerprintOf(body),
          history_proposal_id: history.proposal.id
        },
        createdByUserId: identity.userId,
        createdByAgentId: actor.agentId ?? null,
        createdByRunId: actor.runId ?? null,
        visibility: actor.visibility ?? 'space_shared',
        ownerUserId: identity.userId,
        requiredApproverRole: 'owner',
        riskLevel: 'medium',
        actionIdempotencyKey: body.idempotency_key
      });
      if (actor.visibility === 'selected_users' && actor.runId) await inheritContentAccessGrants(tx, {
        spaceId: identity.spaceId,
        sourceResourceType: 'run',
        sourceResourceId: actor.runId,
        targetResourceType: 'proposal',
        targetResourceId: proposal.id,
        inheritedAt: new Date().toISOString()
      });
      await tx.query(`UPDATE project_information_monitoring_versions SET proposal_id=$3 WHERE id=$1 AND space_id=$2`, [version.id, identity.spaceId, proposal.id]);
      await tx.query(`UPDATE proposals SET status='superseded',updated_at=now() WHERE space_id=$1 AND project_id=$2 AND proposal_type IN ('project_information_monitoring_activation','project_information_monitoring_details') AND status='pending' AND id<>$3`, [identity.spaceId, projectId, proposal.id]);
      return {
        version: versionOut({
          ...version,
          backfill_plan_id: String(plan.id),
          proposal_id: String(proposal.id)
        }),
        proposal,
        dependencies
      };
    });
  }
  async details(identity: SpaceUserIdentity, projectId: string, input: unknown) {
    const body = parseBody(MonitoringDetailsSchema, input);
    return withQueryableTransaction(this.db, async tx => {
      await assertProjectWriter(tx, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(tx, identity.spaceId, projectId);
      const p = await tx.query<{
        active_information_monitoring_version_id: string;
      }>(`SELECT active_information_monitoring_version_id FROM projects WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId]);
      if (p.rows[0]?.active_information_monitoring_version_id !== body.expected_version_id) throw new HttpError(409, 'Monitoring version changed');
      const row = await getVersion(tx, identity.spaceId, projectId, body.expected_version_id);
      const cfg = versionOut(row).config;
      for (const dimension of ['batch', 'daily'] as const) if (body[dimension]) for (const key of ['candidates', 'pages', 'source_requests', 'model_runs'] as const) if (body[dimension]![key] > cfg[dimension][key]) throw new HttpError(422, 'Details cannot increase execution limits');
      const {
        expected_version_id: _,
        ...changes
      } = body;
      const next = await appendVersion(tx, identity.spaceId, projectId, identity.userId, {
        ...cfg,
        ...changes
      }, row);
      await tx.query(`UPDATE projects SET active_information_monitoring_version_id=$3,updated_at=now() WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId, next.id]);
      return versionOut(next);
    });
  }
  /** Agent tool output is deliberately content-free: reader ACL is not model egress consent. */
  async agentStatus(identity: SpaceUserIdentity, projectId: string) {
    const state = await this.state(identity, projectId);
    const version = (v: ProjectMonitoringState['active']) => v ? {
      id: v.id,
      version: v.version,
      config_hash: v.config_hash
    } : null;
    return {
      active: version(state.active),
      draft: version(state.draft),
      paused: state.paused,
      can_write: state.can_write,
      can_reconcile: state.can_reconcile,
      dependencies: state.dependencies,
      latest_run: state.latest_run
    };
  }
  async state(identity: SpaceUserIdentity, projectId: string, operationId?: string, offset = 0): Promise<ProjectMonitoringState> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const p = await this.db.query<{
      active_information_monitoring_version_id: string | null;
      information_monitoring_paused: number;
    }>(`SELECT active_information_monitoring_version_id,information_monitoring_paused FROM projects WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId]);
    const rows = await this.db.query<VersionRow>(`SELECT * FROM project_information_monitoring_versions WHERE space_id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 1`, [identity.spaceId, projectId]);
    let draft: VersionRow | null = rows.rows[0] ?? null;
    if (draft?.proposal_id && (await contentDecisionFromDb(this.db, identity, 'proposal', draft.proposal_id, {
      includeOversight: false
    })) === 'deny') draft = null;
    const active = p.rows[0]?.active_information_monitoring_version_id ? await getVersion(this.db, identity.spaceId, projectId, p.rows[0].active_information_monitoring_version_id) : null;
    const depRows = await this.db.query<{
      id: string;
      type: string;
      status: string;
    }>(`SELECT p.id,p.proposal_type AS type,p.status FROM proposals p WHERE p.space_id=$1 AND p.project_id=$4 AND (p.id=$2::varchar OR p.payload_json->>'source_backfill_plan_id'=$3::varchar OR (p.status='pending' AND p.proposal_type IN ('source_channel_activation','project_source_bind') AND (p.action_idempotency_key LIKE 'monitoring:%' OR EXISTS(SELECT 1 FROM proposals activation WHERE activation.id=p.payload_json->>'depends_on_proposal_id' AND activation.space_id=p.space_id AND activation.project_id=p.project_id AND activation.proposal_type='source_channel_activation' AND activation.action_idempotency_key LIKE 'monitoring:%')))) ORDER BY p.created_at LIMIT 50`, [identity.spaceId, draft?.proposal_id ?? null, draft?.backfill_plan_id ?? null, projectId]);
    const dependencies = [];
    for (const dep of depRows.rows) if ((await contentDecisionFromDb(this.db, identity, 'proposal', dep.id, {
      includeOversight: false
    })) !== 'deny') dependencies.push(dep);
    const ops = await this.db.query<{
      id: string;
      status: string;
      progress_json: Record<string, unknown>;
    }>(`SELECT id,status,progress_json FROM project_operations WHERE space_id=$1 AND project_id=$2 AND progress_json->>'purpose'='information_monitoring' AND ($3::varchar IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 1`, [identity.spaceId, projectId, operationId ?? null]);
    const ownChannels = await new SourceChannelService(this.db, this.config).list(identity, {
      status: 'active'
    });
    const bindings = await this.db.query<{
      source_channel_id: string;
    }>(`SELECT source_channel_id FROM project_source_bindings WHERE project_id=$1 AND space_id=$2 AND status='active'`, [projectId, identity.spaceId]);
    const bound = new Set(bindings.rows.map(r => r.source_channel_id));
    const available_sources = ownChannels.filter(c => bound.has(c.id) && c.fetch_frequency === 'manual' && ['arxiv_api','rss','atom','web_page'].includes(c.connector_key ?? '')).map(c => ({
      id: c.id,
      name: c.name,
      query: c.query,
      connector_key: c.connector_key,
      history_supported: c.connector_key === 'arxiv_api'
    }));
    const latest = ops.rows[0];
    if (operationId && !latest) throw new HttpError(404, "Monitoring run not found");
    const candidateVersion = latest ? await getVersion(this.db, identity.spaceId, projectId, String(latest.progress_json.version_id)) : active;
    // Never expose unfiltered candidate ids or source failures through a shared operation projection.
    const progress = latest ? {
      phase: latest.progress_json.phase,
      coverage: latest.progress_json.coverage,
      page_observation: latest.progress_json.page_observation,
      coverage_scope: latest.progress_json.coverage_scope,
      run_kind: latest.progress_json.run_kind,
      reason: latest.progress_json.reason,
      used: latest.progress_json.used,
      as_of: latest.progress_json.as_of
    } : {};
    const candidates = candidateVersion ? await monitoringCandidates(this.db, identity, projectId, candidateVersion, latest?.progress_json, {
      offset
    }) : [];
    const schedule = await new PgSchedulerTaskStore(this.db).get(MONITORING_TASK, projectId);
    return {
      schedule: {
        confirmed: !!active && !!versionOut(active).config.schedule,
        next_run_at: schedule?.next_run_at ? new Date(String(schedule.next_run_at)).toISOString() : null,
        blocked_reason: typeof schedule?.metadata_json.blocked_reason === 'string' ? schedule.metadata_json.blocked_reason : null
      },
      can_reconcile: latest?.status === 'active' ? await stoppedMonitoringJob(this.db, identity.spaceId, latest.id) : false,
      candidates_next_offset: candidates.length === 200 ? offset + 200 : null,
      available_sources,
      active: active ? versionOut(active) : null,
      draft: draft ? versionOut(draft) : null,
      paused: !!p.rows[0]?.information_monitoring_paused,
      can_write: await canWriteProject(this.db, identity.spaceId, projectId, identity.userId),
      dependencies,
      latest_run: latest ? {
        id: latest.id,
        status: latest.status,
        progress
      } : null,
      candidates
    };
  }
  async reconcile(identity: SpaceUserIdentity, projectId: string) {
    await withQueryableTransaction(this.db, async tx => {
      await assertProjectWriter(tx, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(tx, identity.spaceId, projectId);
      await reconcileStoppedMonitoring(tx, identity.spaceId, projectId);
    });
    const state = await this.state(identity, projectId);
    if (state.latest_run?.status === 'active' && state.can_reconcile) throw new HttpError(409, 'Coordinator or child Run is still active; wait or cancel the child Run before retrying');
    return state;
  }
  async setPaused(identity: SpaceUserIdentity, projectId: string, expected: string, paused: boolean) {
    return withQueryableTransaction(this.db, async tx => {
      await assertProjectWriter(tx, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(tx, identity.spaceId, projectId);
      const r = await tx.query(`UPDATE projects SET information_monitoring_paused=$4,updated_at=now() WHERE id=$1 AND space_id=$2 AND active_information_monitoring_version_id=$3 RETURNING id`, [projectId, identity.spaceId, expected, paused ? 1 : 0]);
      if (!r.rows[0]) throw new HttpError(409, 'Monitoring version changed');
      const version = await getVersion(tx, identity.spaceId, projectId, expected);
      await tx.query(`UPDATE scheduler_tasks SET status=$4,metadata_json=(metadata_json-'retry_after')||'{"blocked_reason":null}'::jsonb,updated_at=now() WHERE task_type=$1 AND task_key=$2 AND space_id=$3`, [MONITORING_TASK, projectId, identity.spaceId, paused || !versionOut(version).config.schedule ? 'paused' : 'active']);
      return {
        paused
      };
    });
  }
  async start(identity: SpaceUserIdentity, projectId: string, input: unknown, scheduledAt?: string) {
    const body = parseBody(MonitoringRunRequestSchema, input);
    return withQueryableTransaction(this.db, async tx => {
      await assertProjectWriter(tx, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(tx, identity.spaceId, projectId);
      await advisoryLock(tx, identity.spaceId, 'monitoring-run', `${projectId}:${body.idempotency_key}`);
      const goalOwner=await tx.query(`SELECT 1 FROM projects p JOIN project_information_monitoring_versions v ON v.id=p.active_information_monitoring_version_id JOIN source_goal_bindings b ON b.spec_json->>'source_channel_id'=v.config_json->>'source_channel_id' JOIN source_goals g ON g.id=b.goal_id AND g.space_id=p.space_id WHERE p.id=$1 AND p.space_id=$2 AND g.active_version_id IS NOT NULL AND g.status<>'deleted'`,[projectId,identity.spaceId]);if(goalOwner.rows.length)throw new HttpError(409,'Collection goal owns this source schedule');
      const key = `information_monitoring:${body.idempotency_key}`;
      await reconcileStoppedMonitoring(tx, identity.spaceId, projectId);
      const reused = await findIdempotentOperation(tx, identity.spaceId, projectId, 'custom', key);
      if (reused) {
        if (reused.fingerprint !== fingerprintOf(body)) throw new HttpError(409, 'Idempotency key has different parameters');
        if (scheduledAt) {
          const recoverable = await tx.query<{
            progress_json: Record<string, unknown>;
          }>(`SELECT o.progress_json FROM project_operations o JOIN projects p ON p.id=o.project_id AND p.space_id=o.space_id WHERE o.id=$1 AND o.space_id=$2 AND o.status='completed' AND o.progress_json->>'recovery_required'='true' AND p.information_monitoring_paused=0 AND p.active_information_monitoring_version_id=$3 AND (o.progress_json->>'dispatch_until')::timestamptz>now() AND NOT EXISTS(SELECT 1 FROM project_operations other WHERE other.space_id=o.space_id AND other.project_id=o.project_id AND other.status='active' AND other.progress_json->>'purpose'='information_monitoring')`, [reused.id, identity.spaceId, body.version_id]);
          if (recoverable.rows.length) {
            const version = await getVersion(tx, identity.spaceId, projectId, body.version_id);
            await requireMonitoringSource(tx, identity, projectId, version.source_channel_id, version.query_fingerprint);
            await tx.query(`UPDATE project_operations SET status='active',progress_json=progress_json||'{"recovery_required":false,"phase":"queued","reason":null}'::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2`, [reused.id, identity.spaceId]);
            await new PgJobQueueRepository(tx).enqueue({
              job_type: 'project_information_monitoring',
              space_id: identity.spaceId,
              user_id: identity.userId,
              payload: {
                operation_id: reused.id
              },
              max_attempts: 1
            });
          }
        }
        return {
          id: reused.id
        };
      }
      const p = await tx.query<{
        active_information_monitoring_version_id: string;
        information_monitoring_paused: number;
      }>(`SELECT active_information_monitoring_version_id,information_monitoring_paused FROM projects WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId]);
      if (p.rows[0]?.active_information_monitoring_version_id !== body.version_id || p.rows[0].information_monitoring_paused) throw new HttpError(409, 'Monitoring not confirmed or paused');
      const version = await getVersion(tx, identity.spaceId, projectId, body.version_id);
      if (version.config_hash !== body.config_hash) throw new HttpError(409, 'Monitoring hash changed');
      const source = await requireMonitoringSource(tx, identity, projectId, version.source_channel_id, version.query_fingerprint);
      const plan = await tx.query(`SELECT 1 FROM source_backfill_plans p JOIN proposals pr ON pr.id=p.proposal_id AND pr.space_id=p.space_id WHERE p.id=$1 AND p.space_id=$2 AND pr.status='accepted' AND p.status IN ('approved','running','paused','completed','failed')`, [version.backfill_plan_id, identity.spaceId]);
      if (!plan.rows[0]) throw new HttpError(409, 'Backfill approval required');
      await reconcileStoppedMonitoring(tx, identity.spaceId, projectId);
      const inflight = await tx.query(`SELECT id FROM project_operations WHERE space_id=$1 AND project_id=$2 AND status='active' AND progress_json->>'purpose'='information_monitoring'`, [identity.spaceId, projectId]);
      if (inflight.rows[0]) throw new HttpError(409, 'Monitoring run already active');
      const runKind = scheduledAt ? 'daily' : body.kind;
      if (scheduledAt && !versionOut(version).config.schedule) throw new HttpError(409, 'Monitoring schedule is not confirmed');
      const acquisitionCutoff = scheduledAt ?? new Date().toISOString();
      if (!scheduledAt) await new SourceBackfillExecutionService(tx).retryMonitoringRanges(identity.spaceId, version.source_channel_id, version.backfill_plan_id!);
      if (runKind !== 'initial' || source.connector_key !== 'arxiv_api' && (await tx.query(`SELECT 1 FROM source_backfill_plans WHERE id=$1 AND space_id=$2 AND status='completed'`,[version.backfill_plan_id, identity.spaceId])).rows.length) await prepareMonitoringRecent(tx, this.config, identity, projectId, version.id, versionOut(version).config, acquisitionCutoff, !!scheduledAt);
      const id = randomUUID();
      const progress = {
        run_kind: runKind,
        local_date: scheduledAt ? localMonitoringDate(versionOut(version).config.timezone, new Date(scheduledAt)) : null,
        slot: scheduledAt ?? null,
        acquisition_cutoff: runKind === 'initial' ? null : acquisitionCutoff,
        dispatch_until: scheduledAt && versionOut(version).config.schedule ? computeNextRunAt({
          cron: `${Number(versionOut(version).config.schedule!.stop_time.split(':')[1])} ${Number(versionOut(version).config.schedule!.stop_time.split(':')[0])} * * *`,
          timezone: versionOut(version).config.timezone
        }, new Date(new Date(scheduledAt).getTime() - 1)).toISOString() : null,
        projection_mode: 'managed',
        purpose: 'information_monitoring',
        phase: 'queued',
        version_id: version.id,
        config: versionOut(version).config,
        plan_id: version.backfill_plan_id,
        rule_id: version.rule_id,
        used: {},
        idempotency: {
          key,
          fingerprint: fingerprintOf(body)
        }
      };
      await tx.query(`INSERT INTO project_operations(id,space_id,project_id,kind,title,status,created_by_user_id,progress_json,created_at,updated_at) VALUES($1,$2,$3,'custom','Bounded initial recommendations','active',$4,$5::jsonb,now(),now())`, [id, identity.spaceId, projectId, identity.userId, JSON.stringify(progress)]);
      await new PgJobQueueRepository(tx).enqueue({
        job_type: 'project_information_monitoring',
        space_id: identity.spaceId,
        user_id: identity.userId,
        payload: {
          operation_id: id
        },
        max_attempts: 1
      });
      return {
        id
      };
    });
  }
  async feedback(identity: SpaceUserIdentity, projectId: string, itemId: string, feedback: 'read' | 'relevant' | 'not_relevant') {
    return monitoringFeedback(this.db, identity, projectId, itemId, feedback);
  }
}
export async function requireMonitoringSource(db: Queryable, identity: SpaceUserIdentity, projectId: string, channelId: string, expectedFingerprint?: string) {
  const r = await db.query<{
    source_connection_id: string;
    binding_id: string;
    query_fingerprint: string;
    connector_key: string;
    retention_policy: string | null;
  }>(`SELECT ch.source_connection_id,b.id AS binding_id,COALESCE(ss.query_fingerprint,ch.query_fingerprint) AS query_fingerprint,connector.connector_key,sc.policy_json->>'retention_policy' AS retention_policy FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id LEFT JOIN source_search_specs ss ON ss.source_channel_id=ch.id AND ss.space_id=ch.space_id JOIN source_provider_connectors mapping ON mapping.id=sc.provider_connector_id JOIN source_connectors connector ON connector.id=mapping.connector_id JOIN project_source_bindings b ON b.source_channel_id=ch.id AND b.space_id=ch.space_id AND b.project_id=$3 AND b.status='active' WHERE ch.id=$1 AND ch.space_id=$2 AND sc.project_id=$3 AND ch.status='active' AND sc.status='active' AND sc.capture_policy='reference_only' AND ch.fetch_frequency='manual' AND connector.connector_key IN ('arxiv_api','rss','atom','web_page') AND ss.research_query_attempt_id IS NULL AND b.standing_comparison_enabled=false AND NOT EXISTS(SELECT 1 FROM project_research_workflows workflow WHERE workflow.space_id=ch.space_id AND workflow.status='active' AND ((workflow.state_json->'channel_ids') ? ch.id OR (workflow.state_json->'source_channel_ids') ? ch.id)) AND NOT EXISTS(SELECT 1 FROM source_post_processing_rules rule WHERE rule.source_channel_id=ch.id AND rule.space_id=ch.space_id AND rule.status='active' AND NOT EXISTS(SELECT 1 FROM project_information_monitoring_versions mv WHERE mv.space_id=rule.space_id AND mv.rule_id=rule.id))`, [channelId, identity.spaceId, projectId]);
  if (!r.rows[0]) throw new HttpError(409, 'A bound, active, manual supported source without automatic processing is required');
  if (r.rows[0].connector_key === 'web_page' && !['full_text','full_snapshot'].includes(r.rows[0].retention_policy ?? '')) throw new HttpError(409,'Fixed page versions require owner-approved full-text retention');
  if (expectedFingerprint && r.rows[0].query_fingerprint !== expectedFingerprint) throw new HttpError(409, "Confirmed source query changed");
  await assertSourceConnectionManageable(db, identity, r.rows[0].source_connection_id);
  return r.rows[0];
}
