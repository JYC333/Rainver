import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import { RetrievalObjectTypeSchema } from "./knowledgeRetrieval.js";

/** The complete, explicit exception list for the personal aggregated-read API. */
export const PERSONAL_AGGREGATED_RESOURCE_TYPES = [
  "knowledge_item",
  "note",
  "source",
  "claim",
  "memory_entry",
  "project_public_summary",
  "source_item",
  "extracted_evidence",
  "inquiry_thread",
] as const;

export const CrossSpacePointerSchema = z.object({
  pointer_id: IdSchema,
  space_id: IdSchema,
  resource_type: RetrievalObjectTypeSchema,
  id: IdSchema,
}).strict();
export type CrossSpacePointer = z.infer<typeof CrossSpacePointerSchema>;

export const CrossSpaceResolvedItemSchema = z.object({
  pointer: CrossSpacePointerSchema,
  space_name: z.string().min(1),
  title: z.string(),
  snippet: z.string().nullable(),
  score: z.number(),
}).strict();
export type CrossSpaceResolvedItem = z.infer<typeof CrossSpaceResolvedItemSchema>;

export const CrossSpaceRetrievalRequestSchema = z.object({
  query: z.string().trim().min(1).max(1024),
  resource_types: z.array(RetrievalObjectTypeSchema).min(1).max(PERSONAL_AGGREGATED_RESOURCE_TYPES.length).optional(),
  max_results: z.number().int().positive().max(50).optional(),
}).strict().superRefine((value, context) => {
  if (value.resource_types && new Set(value.resource_types).size !== value.resource_types.length) {
    context.addIssue({
      code: "custom",
      path: ["resource_types"],
      message: "resource_types must be unique",
    });
  }
});
export type CrossSpaceRetrievalRequest = z.infer<typeof CrossSpaceRetrievalRequestSchema>;

export const CrossSpaceRetrievalResponseSchema = z.object({
  session_id: IdSchema,
  items: z.array(CrossSpaceResolvedItemSchema),
  source_space_ids: z.array(IdSchema),
  fused_conclusion: z.null(),
  canonical_write_performed: z.literal(false),
  ...SecretResponseGuards,
}).strict();
export type CrossSpaceRetrievalResponse = z.infer<typeof CrossSpaceRetrievalResponseSchema>;

export const CrossSpaceResolveRequestSchema = z.object({
  pointer_ids: z.array(IdSchema).min(1).max(100),
}).strict().superRefine(uniquePointerIds);
export const CrossSpaceResolveResponseSchema = z.object({
  items: z.array(CrossSpaceResolvedItemSchema),
  unresolved_pointer_ids: z.array(IdSchema),
  ...SecretResponseGuards,
}).strict();

export const CrossSpaceSummaryStoreRequestSchema = z.object({
  pointer_ids: z.array(IdSchema).min(1).max(100),
  summary: z.string().trim().min(1).max(100_000),
}).strict().superRefine(uniquePointerIds);
export const CrossSpaceSummaryStoreResponseSchema = z.object({
  artifact_id: IdSchema,
  source_space_id: IdSchema,
}).strict();

export const CrossSpaceEgressDisclosureRequestSchema = z.object({
  pointer_ids: z.array(IdSchema).min(2).max(100),
}).strict().superRefine(uniquePointerIds);
export const CrossSpaceEgressDisclosureResponseSchema = z.object({
  disclosure_id: IdSchema,
  expires_at: ISODateTimeSchema,
  source_spaces: z.array(z.object({
    space_id: IdSchema,
    space_name: z.string(),
    egress_notifications_enabled: z.boolean(),
    pointers: z.array(z.object({
      resource_type: RetrievalObjectTypeSchema,
      id: IdSchema,
    }).strict()).min(1),
  }).strict()).min(2),
}).strict();

export const CrossSpaceFusedConclusionStoreRequestSchema = z.object({
  disclosure_id: IdSchema,
  pointer_ids: z.array(IdSchema).min(2).max(100),
  conclusion: z.string().trim().min(1).max(100_000),
}).strict().superRefine(uniquePointerIds);
export const CrossSpaceFusedConclusionStoreResponseSchema = z.object({
  artifact_id: IdSchema,
  egress_record_ids: z.array(IdSchema).min(2),
}).strict();

export const SpaceEgressNotificationSettingSchema = z.object({
  space_id: IdSchema,
  egress_notifications_enabled: z.boolean(),
  updated_at: ISODateTimeSchema,
}).strict();
export const SpaceEgressNotificationSettingUpdateSchema = z.object({
  egress_notifications_enabled: z.boolean(),
}).strict();

export const SpaceMemberNotificationSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  event_type: z.enum(["egress_notification_setting_changed", "content_egress"]),
  pointer_metadata: z.record(z.unknown()),
  created_at: ISODateTimeSchema,
  read_at: ISODateTimeSchema.nullable(),
}).strict();
export const SpaceMemberNotificationsResponseSchema = z.object({
  items: z.array(SpaceMemberNotificationSchema),
}).strict();

function uniquePointerIds(
  value: { pointer_ids: string[] },
  context: z.RefinementCtx,
): void {
  if (new Set(value.pointer_ids).size !== value.pointer_ids.length) {
    context.addIssue({
      code: "custom",
      path: ["pointer_ids"],
      message: "pointer_ids must be unique",
    });
  }
}
