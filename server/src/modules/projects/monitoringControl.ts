/** Sources admission seam. Projects owns version/config reads and ProjectOperation budget writes. */
export { assertMonitoringProcessingContract, monitoringChannelControlClause, monitoringChannel, monitoringPlan, consumeMonitoringBudget, consumeMonitoringBudgets, localMonitoringDate } from './monitoring/budget.js';
export type { MonitoringDimension } from './monitoring/budget.js';
export { MonitoringAdmissionError, MONITORING_ADMISSION_DENIED, monitoringAdmissionReason, monitoringAdmissionRunReason } from './monitoring/admission.js';

export { reconcileMonitoringCoordinator } from './monitoring/lifecycle.js';
