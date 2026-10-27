import { z } from 'zod';
const id = z.string().uuid();
const bounded = (max: number) => z.number().int().min(1).max(max);
export const MonitoringLimitsSchema = z.object({
  candidates: bounded(200),
  pages: bounded(20),
  source_requests: bounded(40),
  model_runs: bounded(20)
}).strict();
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const MonitoringScheduleSchema = z.object({
  recent_window_candidates: bounded(10000),
  collection_time: localTime,
  stop_time: localTime,
  digest_time: localTime,
}).strict().refine(v => v.collection_time < v.stop_time && v.digest_time < v.collection_time, {message: 'Collection must precede the same-day stop time'});
export const ProjectMonitoringConfigSchema = z.object({
  objective: z.string().trim().min(1).max(2000),
  include: z.array(z.string().trim().min(1).max(200)).max(10),
  exclude: z.array(z.string().trim().min(1).max(200)).max(10),
  source_channel_id: id,
  from: z.string().datetime(),
  to: z.string().datetime(),
  total_candidates: bounded(10000),
  batch: MonitoringLimitsSchema,
  daily: MonitoringLimitsSchema,
  recommendation_count: bounded(20),
  language: z.string().trim().min(1).max(64),
  timezone: z.string().min(1).max(64).refine(value => {
    try {
      new Intl.DateTimeFormat('en', {
        timeZone: value
      });
      return true;
    } catch {
      return false;
    }
  }),
  evidence_depth: z.literal('abstract'),
  incremental_strategy: z.enum(['new_items', 'page_changes']).optional(),
  agent_id: id,
  schedule: MonitoringScheduleSchema.nullable().optional()
}).strict().refine(value => value.from < value.to, {
  message: 'from must precede to'
});
export type ProjectMonitoringConfig = z.infer<typeof ProjectMonitoringConfigSchema>;
export const ProposeProjectMonitoringSchema = z.object({
  expected_active_version_id: id.nullable(),
  idempotency_key: z.string().min(1).max(128),
  config: ProjectMonitoringConfigSchema
}).strict();
export const MonitoringDetailsSchema = z.object({
  expected_version_id: id,
  recommendation_count: bounded(20).optional(),
  language: z.string().trim().min(1).max(64).optional(),
  batch: MonitoringLimitsSchema.optional(),
  daily: MonitoringLimitsSchema.optional()
}).strict();
export const MonitoringRunRequestSchema = z.object({
  version_id: id,
  config_hash: z.string().length(64),
  idempotency_key: z.string().min(1).max(128),
  kind: z.enum(['initial', 'check'])
}).strict();
export const MonitoringSourceSetupSchema = z.object({
  provider_key: z.enum(['arxiv', 'rss', 'atom', 'web_page']).optional(),
  query: z.string().trim().min(1).max(2000),
  idempotency_key: z.string().min(1).max(128)
}).strict();
export const MonitoringFeedbackSchema = z.object({
  feedback: z.enum(['relevant', 'not_relevant', 'read'])
}).strict();
export interface MonitoringCandidate {
  id: string;
  title: string;
  source_uri: string | null;
  occurred_at: string | null;
  summary: string | null;
  relevance: string | null;
  reason: string | null;
  recommended: boolean;
  evidence_depth: 'title' | 'abstract';
  feedback: string | null;
  change?: { page_item_id: string; before_snapshot_id: string; after_snapshot_id: string };
  read_status: 'unread' | 'skimmed' | 'read' | 'discussed';
}
export interface MonitoringVersion {
  id: string;
  version: number;
  config: ProjectMonitoringConfig;
  config_hash: string;
  proposal_id: string | null;
  backfill_plan_id: string | null;
  rule_id: string | null;
}
export interface MonitoringOperation {
  id: string;
  status: string;
  progress: Record<string, unknown>;
}
export interface ProjectMonitoringState {
  schedule?: { next_run_at: string | null; blocked_reason: string | null; confirmed: boolean };
  available_sources: Array<{
    id: string;
    name: string;
    query: Record<string, unknown>;
    connector_key?: string;
    history_supported?: boolean;
  }>;
  active: MonitoringVersion | null;
  draft: MonitoringVersion | null;
  can_write: boolean;
  can_reconcile?: boolean;
  paused: boolean;
  dependencies: Array<{
    id: string;
    type: string;
    status: string;
  }>;
  latest_run: MonitoringOperation | null;
  candidates: MonitoringCandidate[];
  candidates_next_offset?: number | null;
}
