import type { SourceItem, SourceCapturePolicy, SourceScheduleRule } from '../../types/api'

export type ItemFilter = 'open' | 'new' | 'triaged' | 'selected' | 'ignored'

export const CAPTURE_POLICIES: Array<{ value: SourceCapturePolicy; label: string }> = [
  { value: 'reference_only', label: 'Save reference' },
  { value: 'extract_text', label: 'Extract text' },
  { value: 'archive_original', label: 'Archive original' },
]

export const FREQUENCIES = [
  { value: 'manual', label: 'Manual' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
]

export const WEEKDAY_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
]

export interface ScheduleFormValue {
  minute: string
  hour: string
  weekday: string
}

export function isScheduledFrequency(fetchFrequency: string) {
  return fetchFrequency === 'hourly' || fetchFrequency === 'daily' || fetchFrequency === 'weekly'
}

function isScheduleFormComplete(fetchFrequency: string, value: ScheduleFormValue) {
  if (fetchFrequency === 'manual') return true
  if (fetchFrequency === 'hourly') return validMinute(value.minute)
  if (fetchFrequency === 'daily') return validHour(value.hour) && validMinute(value.minute)
  if (fetchFrequency === 'weekly') return validWeekday(value.weekday) && validHour(value.hour) && validMinute(value.minute)
  return false
}

export function scheduleRuleFromForm(fetchFrequency: string, value: ScheduleFormValue, now = new Date()): SourceScheduleRule | null | undefined {
  if (!isScheduledFrequency(fetchFrequency)) return null
  if (!isScheduleFormComplete(fetchFrequency, value)) return undefined
  if (fetchFrequency === 'hourly') {
    return { frequency: 'hourly', minute: Number(value.minute) }
  }
  if (fetchFrequency === 'daily') {
    return utcRuleFromLocalCandidate('daily', nextDailyLocalOccurrence(Number(value.hour), Number(value.minute), now))
  }
  return utcRuleFromLocalCandidate('weekly', nextWeeklyLocalOccurrence(Number(value.weekday), Number(value.hour), Number(value.minute), now))
}

function nextDailyLocalOccurrence(hour: number, minute: number, now: Date) {
  const candidate = new Date(now)
  candidate.setHours(hour, minute, 0, 0)
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1)
  return candidate
}

function nextWeeklyLocalOccurrence(weekday: number, hour: number, minute: number, now: Date) {
  const candidate = new Date(now)
  let daysToAdd = weekday - isoLocalWeekday(candidate)
  if (daysToAdd < 0) daysToAdd += 7
  candidate.setDate(candidate.getDate() + daysToAdd)
  candidate.setHours(hour, minute, 0, 0)
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 7)
  return candidate
}

function utcRuleFromLocalCandidate(frequency: 'daily' | 'weekly', candidate: Date): SourceScheduleRule {
  const hour = candidate.getUTCHours()
  const minute = candidate.getUTCMinutes()
  if (frequency === 'daily') return { frequency, hour, minute }
  return { frequency, weekday: isoUtcWeekday(candidate), hour, minute }
}

function validMinute(value: string) {
  return validIntegerRange(value, 0, 59)
}

function validHour(value: string) {
  return validIntegerRange(value, 0, 23)
}

function validWeekday(value: string) {
  return validIntegerRange(value, 1, 7)
}

function validIntegerRange(value: string, min: number, max: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
}

function isoLocalWeekday(date: Date) {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

function isoUtcWeekday(date: Date) {
  const day = date.getUTCDay()
  return day === 0 ? 7 : day
}

const TEXT_EXTRACTION_READY_STATES = new Set(['metadata_only', 'excerpt_saved', 'content_saved', 'extraction_failed'])

export function textExtractionDisabledReason(item: Pick<SourceItem, 'content_state' | 'source_uri'>) {
  if (!item.source_uri) return 'This item has no source URL to fetch.'
  if (TEXT_EXTRACTION_READY_STATES.has(item.content_state)) return null
  if (item.content_state === 'content_queued') return 'Text extraction is already queued.'
  if (item.content_state === 'snapshot_queued') return 'Snapshot capture is already queued.'
  if (item.content_state === 'snapshot_saved') return 'A source snapshot is already saved.'
  return `Text extraction is not available for ${item.content_state}.`
}

export function textExtractionActionLabel(item: Pick<SourceItem, 'content_state'>) {
  return item.content_state === 'content_saved' ? 'Re-extract' : 'Extract text'
}

export function fmt(dt: string | null) {
  return dt ? new Date(dt).toLocaleString() : 'never'
}

export function short(id: string | null | undefined) {
  return id ? `${id.slice(0, 8)}...` : ''
}

export function preview(text: string | null | undefined, fallback = 'No excerpt') {
  const raw = (text || '').trim()
  if (!raw) return fallback
  return raw.length > 280 ? `${raw.slice(0, 280)}...` : raw
}
