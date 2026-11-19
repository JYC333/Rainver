import { z } from 'zod';
import { IdSchema } from './common.js';

/** Human commands and reads over a Room task collaboration (`modules/rooms.md`). */
const collaborationParticipants = z.array(IdSchema.max(36)).min(1)
  .refine(ids => new Set(ids).size === ids.length, 'Participants must be distinct');
export const CollaborationParticipantsInputSchema = z.object({
  group_id: IdSchema.max(36),
  expected_participant_agent_ids: collaborationParticipants,
  participant_agent_ids: collaborationParticipants,
  reason: z.string().trim().min(1).max(2000),
}).strict();
/**
 * Server-owned reminder thresholds for the work a person's Room turn
 * authorized (a task collaboration or temporary delegation): notices at these
 * cumulative handoff counts, then at every doubling of the last one. They
 * inform; they never stop admission. There is no total handoff or turn limit.
 */
export const COLLABORATION_REMINDER_THRESHOLDS = [25, 50, 100, 200] as const;
/** The highest reminder threshold reached by `count`, or null before the first. */
export function collaborationReminderThreshold(count: number): number | null {
  let reached: number | null = null;
  for (const value of COLLABORATION_REMINDER_THRESHOLDS) { if (value > count) return reached; reached = value; }
  for (let next = COLLABORATION_REMINDER_THRESHOLDS[COLLABORATION_REMINDER_THRESHOLDS.length - 1] * 2; next <= count; next *= 2) reached = next;
  return reached;
}
/** The first reminder threshold above `count`. */
export function collaborationNextReminder(count: number): number {
  for (const value of COLLABORATION_REMINDER_THRESHOLDS) if (value > count) return value;
  let next = COLLABORATION_REMINDER_THRESHOLDS[COLLABORATION_REMINDER_THRESHOLDS.length - 1] * 2;
  while (next <= count) next *= 2;
  return next;
}
/** Every threshold in (after, through], in order — one notice summarises a jump. */
export function collaborationReminderThresholdsBetween(after: number, through: number): number[] {
  const crossed: number[] = [];
  for (const value of COLLABORATION_REMINDER_THRESHOLDS) if (value > after && value <= through) crossed.push(value);
  for (let next = COLLABORATION_REMINDER_THRESHOLDS[COLLABORATION_REMINDER_THRESHOLDS.length - 1] * 2; next <= through; next *= 2) if (next > after) crossed.push(next);
  return crossed;
}
/**
 * Why a collaboration admits no further handoff — the same projection the
 * server's admission uses. Null while it admits. No reason is a count.
 */
export const CollaborationStopReasonSchema = z.enum([
  'paused', 'stopped', 'repeated_failures',
  'project_access_lost', 'task_unavailable', 'task_closed', 'coordinator_cancelled',
]);
export const CollaborationParticipantsOutputSchema = z.object({
  group_id: IdSchema.max(36), task_id: IdSchema.max(36), participant_agent_ids: collaborationParticipants,
}).strict();
export const CollaborationGetInputSchema = z.object({
  room_id: IdSchema.max(36),
  session_id: IdSchema.max(36),
}).strict();
/** The newest task collaboration declared in one Room conversation, as its human manager sees it. */
export const CollaborationViewSchema = z.object({
  group_id: IdSchema.max(36),
  group_status: z.string(),
  task_id: IdSchema.max(36),
  task_title: z.string().nullable(),
  task_status: z.string().nullable(),
  delegations_used: z.number().int().nonnegative(),
  turns_used: z.number().int().nonnegative(),
  /** The next reminder threshold; informational, never a limit. */
  next_reminder_at: z.number().int().positive(),
  participant_agent_ids: z.array(IdSchema.max(36)),
  active: z.boolean(),
  stop_reason: CollaborationStopReasonSchema.nullable(),
  can_manage: z.boolean(),
}).strict();
export const CollaborationGetOutputSchema = z.object({
  collaboration: CollaborationViewSchema.nullable(),
  /** Stored collaboration JSON that does not parse: admission is closed, never silently ad hoc. */
  invalid: z.boolean(),
}).strict();
export const COLLABORATION_OPERATION_SCHEMAS = {
  'room.collaboration.update_participants': {input: CollaborationParticipantsInputSchema, output: CollaborationParticipantsOutputSchema},
  'room.collaboration.get': {input: CollaborationGetInputSchema, output: CollaborationGetOutputSchema},
} as const;
