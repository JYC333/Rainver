import { z } from "zod";

/**
 * Test oracle only: the stored task-collaboration union of the earlier release
 * (commit 4c6e23c0, `collaborationBudgetRepository.ts` and protocol
 * `CollaborationReminderThresholdsSchema`), copied verbatim so migration 0024
 * can be checked against what that release actually accepted from
 * `JSON.parse` of the stored JSON. Not used by any runtime code.
 */
const declaration = {
  task_id: z.string().min(1),
  participant_agent_ids: z.array(z.string().min(1)).min(1)
    .refine((ids) => new Set(ids).size === ids.length, "Participants must be distinct"),
};
const stored = {
  ...declaration,
  coordinator_agent_id: z.string().min(1),
  delegations_offset: z.number().int().min(0).optional(),
  turns_offset: z.number().int().min(0).optional(),
  declared_at: z.string().datetime({ offset: true }).optional(),
};
const thresholds = z.array(z.number().int().positive()).min(1).max(8)
  .refine(values => values.every((value, index) => index === 0 || value > values[index - 1]!), "Thresholds must increase");
export const LegacyStoredCollaborationSchema = z.union([
  z.object({ ...stored, max_delegations: z.number().int().min(1).max(128), reminder_requested: z.literal(true).optional() }).strict(),
  z.object({ ...stored, mode: z.literal("reminder"), reminder_thresholds: thresholds,
    reminder_notified_through: z.number().int().min(0).optional(),
    converted_from_max_delegations: z.number().int().min(1).max(128).optional() }).strict(),
]);
