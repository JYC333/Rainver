import type { ProjectMonitoringConfig } from '@rainver/protocol';
import type { Queryable, SpaceUserIdentity } from '../../routeUtils/common.js';
import { PgSchedulerTaskStore } from '../../scheduler/taskStore.js';
import { computeNextRunAt } from '../../automations/schedule.js';
export const MONITORING_TASK = 'project_information_monitoring';
export function monitoringCron(cfg: ProjectMonitoringConfig) {
  const [hour, minute] = cfg.schedule!.collection_time.split(':');
  return {
    cron: `${Number(minute)} ${Number(hour)} * * *`,
    timezone: cfg.timezone
  };
}
/** Sources owns acquisition due state, independent of the manual Channel scan task. */
export async function configureMonitoringSchedule(db: Queryable, identity: SpaceUserIdentity, projectId: string, versionId: string, cfg: ProjectMonitoringConfig) {
  const store = new PgSchedulerTaskStore(db);
  const previous = await store.get(MONITORING_TASK, projectId);
  await store.upsert({
    taskType: MONITORING_TASK,
    taskKey: projectId,
    scopeType: 'space',
    scopeId: identity.spaceId,
    spaceId: identity.spaceId,
    userId: identity.userId,
    status: cfg.schedule ? 'active' : 'paused',
    nextRunAt: cfg.schedule ? computeNextRunAt(monitoringCron(cfg)).toISOString() : null,
    stateJson: previous?.state_json ?? {},
    metadataJson: {
      version_id: versionId,
      blocked_reason: null
    }
  });
}
