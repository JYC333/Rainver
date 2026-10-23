export const TASK_TYPE_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'research', label: 'Research' },
  { value: 'writing', label: 'Writing' },
  { value: 'coding', label: 'Coding' },
  { value: 'review', label: 'Review' },
  { value: 'admin', label: 'Administrative' },
]

export const TASK_PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

export const TASK_RISK_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
]

/** Conservative defaults applied by the server for ordinary user-created Tasks. There is no default time limit. */
export const DEFAULT_TASK_LIMITS = {
  max_runs: 3,
  max_cost: 10,
}

export function taskTypeOptions(current: string | null | undefined) {
  if (!current || TASK_TYPE_OPTIONS.some(option => option.value === current)) return TASK_TYPE_OPTIONS
  return [{ value: current, label: current }, ...TASK_TYPE_OPTIONS]
}
