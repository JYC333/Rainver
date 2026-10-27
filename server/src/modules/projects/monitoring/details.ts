import type { ProjectMonitoringConfig } from '@rainver/protocol';
import { fingerprintOf } from '../projectOperationIdempotency.js';
/** The server computes the diff; a client cannot classify a scope expansion as presentation. */
export function monitoringDetailsOnly(current: ProjectMonitoringConfig, next: ProjectMonitoringConfig): boolean {
  const {
    language: _a,
    recommendation_count: _b,
    batch: _c,
    daily: _d,
    ...before
  } = current;
  const {
    language: _e,
    recommendation_count: _f,
    batch: _g,
    daily: _h,
    ...after
  } = next;
  if (fingerprintOf(before) !== fingerprintOf(after)) return false;
  for (const group of ['batch', 'daily'] as const) for (const key of ['candidates', 'pages', 'source_requests', 'model_runs'] as const) if (next[group][key] > current[group][key]) return false;
  return true;
}
