import { configureMonitoringDigest } from '../../informationDigest/monitoringSchedule.js';
import { configureMonitoringSchedule } from '../../sources/monitoring/schedule.js';
import { monitoringDetailsOnly } from './details.js';
import type { ProposalApplierRegistry } from '../../proposals/applierRegistry.js';
import { HttpError } from '../../routeUtils/common.js';
import { assertProjectWriter, lockActiveProjectForMutation } from '../access.js';
import { getVersion, versionOut, monitoringRelevanceInstruction } from './repository.js';
import { requireMonitoringSource } from './service.js';
import { SourcePostProcessingService } from '../../sources/postProcessing/service.js';
export function registerMonitoringApplier(registry: ProposalApplierRegistry) {
  registry.register('project_information_monitoring_details', async ({
    db,
    proposal,
    userId
  }) => {
    if (!proposal.project_id) throw new HttpError(422, 'Project required');
    const projectId = proposal.project_id;
    const identity = {
      spaceId: proposal.space_id,
      userId
    };
    await assertProjectWriter(db, identity.spaceId, projectId, userId);
    await lockActiveProjectForMutation(db, identity.spaceId, projectId);
    const payload = proposal.payload_json ?? {};
    const next = await getVersion(db, identity.spaceId, projectId, String(payload.version_id));
    const p = await db.query<{
      active_information_monitoring_version_id: string;
    }>(`SELECT active_information_monitoring_version_id FROM projects WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId]);
    if (p.rows[0]?.active_information_monitoring_version_id !== payload.expected_active_version_id || next.proposal_id !== proposal.id || next.config_hash !== payload.config_hash) throw new HttpError(409, 'Monitoring version changed');
    const previous = await getVersion(db, identity.spaceId, projectId, p.rows[0].active_information_monitoring_version_id);
    if (!monitoringDetailsOnly(versionOut(previous).config, versionOut(next).config) || next.backfill_plan_id !== previous.backfill_plan_id || next.rule_id !== previous.rule_id || next.query_fingerprint !== previous.query_fingerprint) throw new HttpError(422, 'Details cannot change execution scope');
    await db.query(`UPDATE projects SET active_information_monitoring_version_id=$3,updated_at=now() WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId, next.id]);
    return {
      result_type: 'project_operation',
      result: {
        version_id: next.id
      }
    };
  });
  registry.register('project_information_monitoring_activation', async ({
    db,
    config,
    proposal,
    userId
  }) => {
    const projectId = proposal.project_id;
    if (!projectId) throw new HttpError(422, 'Project required');
    const identity = {
      spaceId: proposal.space_id,
      userId
    };
    await assertProjectWriter(db, identity.spaceId, projectId, userId);
    await lockActiveProjectForMutation(db, identity.spaceId, projectId);
    const payload = proposal.payload_json ?? {};
    const version = await getVersion(db, identity.spaceId, projectId, String(payload.version_id));
    if (version.proposal_id !== proposal.id || version.config_hash !== payload.config_hash) throw new HttpError(409, 'Monitoring proposal stale');
    const p = await db.query<{
      active_information_monitoring_version_id: string | null;
    }>(`SELECT active_information_monitoring_version_id FROM projects WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId]);
    if (p.rows[0]?.active_information_monitoring_version_id !== payload.expected_active_version_id) throw new HttpError(409, 'Monitoring version changed');
    const source = await requireMonitoringSource(db, identity, projectId, version.source_channel_id, version.query_fingerprint);
    const dependency = await db.query(`SELECT 1 FROM proposals pr JOIN source_backfill_plans plan ON plan.proposal_id=pr.id AND plan.space_id=pr.space_id WHERE pr.id=$1 AND pr.space_id=$2 AND pr.status='accepted' AND plan.id=$3`, [payload.history_proposal_id, identity.spaceId, version.backfill_plan_id]);
    if (!dependency.rows[0]) throw new HttpError(409, 'Backfill approval required before configuration activation');
    const cfg = versionOut(version).config;
    if (source.connector_key === 'arxiv_api' && Date.parse(cfg.to) > Date.now()) throw new HttpError(422, 'History end must not be in the future');
    await configureMonitoringDigest(db, identity, projectId, cfg);
    await configureMonitoringSchedule(db, identity, projectId, version.id, cfg);
    const rule = await new SourcePostProcessingService(db, config).createRule(identity, version.source_channel_id, {
      name: `Bounded Project relevance v${version.version}`,
      agent_id: cfg.agent_id,
      project_id: projectId,
      trigger_type: 'manual',
      actions_json: {
        batch_digest: false,
        per_item_summary: false,
        extract_evidence: false,
        create_proposals: false,
        mark_items: true
      },
      input_config_json: {
        window: 'explicit',
        item_limit: 10,
        include_evidence: false,
        include_excerpts: true,
        content_source: 'excerpt_only',
        timezone: cfg.timezone,
        structured_output_schema_id: 'source_post_processing.result.v1',
        deep_analysis: {
          enabled: false
        },
        candidate_prefilter: {
          enabled: false
        },
        retrieval_context: {
          enabled: false
        },
        relevance_profile: {
          enabled: true,
          objective: cfg.objective,
          include_criteria: cfg.include,
          exclude_criteria: cfg.exclude
        },
        summary_goal: cfg.objective,
        output_instructions: monitoringRelevanceInstruction(cfg)
      }
    });
    await db.query(`UPDATE project_information_monitoring_versions SET rule_id=$3 WHERE id=$1 AND space_id=$2`, [version.id, identity.spaceId, rule.id]);
    await db.query(`UPDATE projects SET active_information_monitoring_version_id=$3,information_monitoring_paused=$4,updated_at=now() WHERE id=$1 AND space_id=$2`, [projectId, identity.spaceId, version.id, cfg.schedule ? 0 : 1]);
    return {
      result_type: 'project_operation',
      result: {
        version_id: version.id,
        paused: !cfg.schedule
      }
    };
  });
}
