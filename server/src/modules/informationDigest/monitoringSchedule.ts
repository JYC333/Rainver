import type { ProjectMonitoringConfig } from '@rainver/protocol';
import type { Queryable, SpaceUserIdentity } from '../routeUtils/common.js';
import { HttpError } from '../routeUtils/common.js';
import { PgAutomationRepository } from '../automations/repository.js';

/** Caller holds the Project mutation lock. Never change another owner's Automation. */
export async function configureMonitoringDigest(db: Queryable, identity: SpaceUserIdentity, projectId: string, cfg: ProjectMonitoringConfig) {
  if (!cfg.schedule) return;
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`information-digest-automation:${identity.spaceId}:project:${projectId}:daily`]);
  const rows = await db.query<{
    id: string;
    owner_user_id: string;
  }>(`SELECT id,owner_user_id FROM automations WHERE space_id=$1 AND project_id=$2 AND status<>'archived' AND config_json->>'target_type'='information_digest' AND config_json->>'scope'='project' AND COALESCE(config_json->>'operation','daily')='daily' FOR UPDATE`, [identity.spaceId, projectId]);
  if (rows.rows.length > 1 || rows.rows.some(r => r.owner_user_id !== identity.userId)) throw new HttpError(409, 'monitoring_digest_owner_conflict', {
    detail: 'The existing Project Digest belongs to another owner or has conflicting daily schedules. Ask its owner to coordinate the existing schedule.',
    code: 'monitoring_digest_owner_conflict'
  });
  const [hour, minute] = cfg.schedule.digest_time.split(':');
  const configJson = {
    target_type: 'information_digest',
    scope: 'project',
    operation: 'daily',
    project_id: projectId,
    cron: `${Number(minute)} ${Number(hour)} * * *`,
    timezone: cfg.timezone
  };
  const repo = new PgAutomationRepository(db);
  if (rows.rows[0]) await repo.update(identity.spaceId, rows.rows[0].id, {
    status: 'active',
    config_json: configJson
  });else await repo.create({
    spaceId: identity.spaceId,
    ownerUserId: identity.userId,
    agentId: cfg.agent_id,
    projectId,
    name: 'Project daily digest',
    triggerType: 'schedule',
    configJson,
    preflightSnapshot: {
      executable: true,
      target_type: 'information_digest'
    }
  });
}
