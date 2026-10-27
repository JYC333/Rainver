import { describe, it, expect } from 'vitest';
import { MonitoringSourceSetupSchema, ProjectMonitoringConfigSchema, MonitoringDetailsSchema } from '../src/projectInformationMonitoring.js';
const id = '00000000-0000-4000-8000-000000000001';
const limits = {
  candidates: 10,
  pages: 2,
  source_requests: 4,
  model_runs: 4
};
const config = {
  objective: 'Release changes',
  include: [],
  exclude: [],
  source_channel_id: id,
  agent_id: id,
  from: '2026-01-01T00:00:00Z',
  to: '2026-02-01T00:00:00Z',
  total_candidates: 10,
  batch: limits,
  daily: limits,
  recommendation_count: 3,
  language: 'en',
  timezone: 'UTC',
  evidence_depth: 'abstract'
};
describe('Generic monitoring contracts', () => {
  it('keeps legacy configs valid and confirms the page strategy as execution scope', () => {
    expect(ProjectMonitoringConfigSchema.parse(config)).not.toHaveProperty('incremental_strategy');
    expect(ProjectMonitoringConfigSchema.parse({
      ...config,
      incremental_strategy: 'page_changes'
    }).incremental_strategy).toBe('page_changes');
    expect(ProjectMonitoringConfigSchema.safeParse({
      ...config,
      incremental_strategy: 'search_ranking'
    }).success).toBe(false);
    expect(MonitoringDetailsSchema.safeParse({
      expected_version_id: id,
      incremental_strategy: 'page_changes'
    }).success).toBe(false);
  });
  it('accepts bounded built-in source choices and rejects arbitrary connector substitution', () => {
    for (const provider_key of ['arxiv', 'rss', 'atom', 'web_page']) expect(MonitoringSourceSetupSchema.parse({
      provider_key,
      query: 'https://example.com/updates',
      idempotency_key: 'setup'
    }).provider_key).toBe(provider_key);
    expect(MonitoringSourceSetupSchema.safeParse({
      provider_key: 'custom_script',
      query: 'x',
      idempotency_key: 'x'
    }).success).toBe(false);
  });
});
