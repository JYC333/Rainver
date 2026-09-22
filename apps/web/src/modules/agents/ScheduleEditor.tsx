import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import type { ScheduleEditorMode, ScheduleEditorValue } from './scheduleEditorState'
export {
  isScheduleEditorValueValid,
  scheduleConfigFromEditor,
  scheduleEditorFromConfig,
  type ScheduleEditorValue,
} from './scheduleEditorState'
import { SCHEDULE_CADENCE_OPTIONS } from './scheduleEditorState'

/**
 * The stored config may carry a `timezone` the editor preserves but does not
 * edit; naming UTC regardless would have been wrong for exactly those.
 */
function hourLabel(value: ScheduleEditorValue): string {
  const timezone = value.preserved?.timezone
  return typeof timezone === 'string' && timezone.trim()
    ? `Hour (${timezone.trim()})`
    : 'Hour (UTC)'
}

export function ScheduleEditorFields({
  value,
  onChange,
}: {
  value: ScheduleEditorValue
  onChange: (value: ScheduleEditorValue) => void
}) {
  return (
    <>
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Cadence</label>
        <Select
          ariaLabel="Cadence"
          value={value.mode}
          onChange={mode => onChange({ ...value, mode: mode as ScheduleEditorMode })}
          options={SCHEDULE_CADENCE_OPTIONS}
        />
      </div>
      {value.mode === 'daily' && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{hourLabel(value)}</label>
          <Input
            aria-label={hourLabel(value)}
            type="number"
            min={0}
            max={23}
            required
            value={value.dailyHour}
            onChange={event => onChange({ ...value, dailyHour: event.target.value })}
            className="w-24"
          />
        </div>
      )}
      {value.mode === 'interval' && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Interval (hours)</label>
          <Input
            aria-label="Interval (hours)"
            type="number"
            min={1}
            step={1}
            required
            value={value.intervalHours}
            onChange={event => onChange({ ...value, intervalHours: event.target.value })}
            className="w-24"
          />
        </div>
      )}
      {value.mode === 'cron' && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Cron expression</label>
          <Input
            aria-label="Cron expression"
            required
            value={value.cron}
            onChange={event => onChange({ ...value, cron: event.target.value })}
            className="font-mono"
          />
        </div>
      )}
      {value.mode !== 'manual' && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={event => onChange({ ...value, enabled: event.target.checked })}
          />
          Enabled
        </label>
      )}
    </>
  )
}
