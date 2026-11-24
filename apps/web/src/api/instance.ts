import type {
  DeploymentJob,
  DeploymentJobDetail,
  DeploymentJobType,
  DeploymentStatus,
  InstanceOperationsSettings,
  InstanceOperationsSettingsUpdate,
} from '../types/api'
import { systemCommand } from './jobReads'
import { operationAt } from './operations'
import type { RequestOptions } from './transport'
import { get } from './transport'
import type { OfficialPluginEffectiveResponse } from '@rainver/protocol'

export const instanceOperationsApi = {
  get: () => get<InstanceOperationsSettings>('/system/instance-settings'),
  update: (body: InstanceOperationsSettingsUpdate, key: string = crypto.randomUUID()) =>
    operationAt<InstanceOperationsSettings>('PUT', '/system/instance-settings', body, key),
}

// ── Instance update (ADR 0020; instance admin only) ───────────────────────
export const deploymentApi = {
  status: () => get<DeploymentStatus>('/deployments/status'),
  /** Creating the job is the administrator's approval; it takes no arguments. */
  createJob: (jobType: DeploymentJobType, key: string = crypto.randomUUID()) =>
    operationAt<DeploymentJob>('POST', '/deployments/jobs', { job_type: jobType }, key),
  job: (jobId: string) => get<DeploymentJobDetail>(`/deployments/jobs/${jobId}`),
  /** Only from `queued`: once the deployer has it, the job runs to its end. */
  cancelJob: (jobId: string, key: string = crypto.randomUUID()) => operationAt<DeploymentJob>('POST', `/deployments/jobs/${encodeURIComponent(jobId)}/cancel`, {}, key),
}

// ── Official Optional Modules (plugins) ───────────────────────────────────
// GET /api/v1/plugins       — list all descriptors + effective state
// GET /api/v1/plugins/effective — effective map for frontend overlay
// GET /api/v1/plugins/:id   — single plugin
// POST /api/v1/plugins/:id/install  — install package + migrations
// POST /api/v1/plugins/:id/enable   — enable
// POST /api/v1/plugins/:id/disable  — disable
// PATCH /api/v1/plugins/:id/settings — patch settings
export const pluginsApi = {
  list: (options:RequestOptions={}) => get<{ items: import('@rainver/protocol').OfficialPluginListItem[] }>('/plugins',options),
  effective: (options:RequestOptions={}) => get<OfficialPluginEffectiveResponse>('/plugins/effective',options),
  get: (pluginId: string) => get<unknown>(`/plugins/${encodeURIComponent(pluginId)}`),
  /** Installation runs the plugin's migrations after commit; `{ install, item }` comes from the command status. */
  install: (pluginId: string, key?: string, options: RequestOptions = {}) =>
    systemCommand<{ install: unknown; item: unknown }>('POST', `/plugins/${encodeURIComponent(pluginId)}/install`, {}, 'Plugin installation', key, 5 * 60 * 1000, options),
  enable: (pluginId: string, body: { settings?: Record<string, unknown> } = {}, key: string = crypto.randomUUID(), options: RequestOptions = {}) =>
    operationAt<unknown>('POST', `/plugins/${encodeURIComponent(pluginId)}/enable`, body, key, options),
  disable: (pluginId: string, body: Record<string, never> = {}, key: string = crypto.randomUUID(), options: RequestOptions = {}) =>
    operationAt<unknown>('POST', `/plugins/${encodeURIComponent(pluginId)}/disable`, body, key, options),
  patchSettings: (pluginId: string, settings: Record<string, unknown>, key: string = crypto.randomUUID()) =>
    operationAt<unknown>('PATCH', `/plugins/${encodeURIComponent(pluginId)}/settings`, { settings }, key),
}
