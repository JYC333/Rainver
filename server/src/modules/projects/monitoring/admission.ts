import { HttpError } from '../../routeUtils/common.js';
export const MONITORING_ADMISSION_DENIED = 'monitoring_admission_denied';
const messages = {
  window_closed: 'Monitoring dispatch window has ended',
  budget: 'monitoring_budget_exhausted',
  paused: 'Monitoring is paused',
  permission_changed: 'Monitoring permission changed',
  source_changed: 'Confirmed source changed',
  operation_inactive: 'Monitoring operation is not active',
  operation_missing: 'Monitoring operation not found',
  project_inactive: 'Monitoring Project is not active'
} as const;
export type MonitoringAdmissionReason = keyof typeof messages;
/** Only an explicit pre-send domain refusal, never an upstream/network/SQL failure. */
export class MonitoringAdmissionError extends HttpError {
  readonly code = MONITORING_ADMISSION_DENIED;
  constructor(readonly reason: MonitoringAdmissionReason) {
    super(reason === 'budget' ? 429 : 409, messages[reason], {
      code: MONITORING_ADMISSION_DENIED,
      reason
    });
    this.name = 'MonitoringAdmissionError';
  }
}
export function monitoringAdmissionReason(code: unknown, reason: unknown): MonitoringAdmissionReason | null {
  return code === MONITORING_ADMISSION_DENIED && typeof reason === 'string' && Object.hasOwn(messages, reason) ? reason as MonitoringAdmissionReason : null;
}
export function monitoringAdmissionRunReason(reason: MonitoringAdmissionReason): string {
  return reason === 'budget' ? 'quota_paused' : reason === 'paused' ? 'paused' : reason === 'window_closed' ? 'window_closed' : 'admission_blocked';
}
/** Preserve unexpected infrastructure failures; only known authorization failures are refusals. */
export async function checkMonitoringPermission(check: () => Promise<unknown>, conflictReason: 'permission_changed' | 'source_changed' = 'permission_changed'): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (error instanceof HttpError && [403, 404, 409].includes(error.statusCode)) throw new MonitoringAdmissionError(error.statusCode === 409 ? conflictReason : 'permission_changed');
    throw error;
  }
}
