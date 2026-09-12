import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";

export const PUBLICATION_RESOURCE_TYPES = [
  "artifact",
  "memory",
  "space_object",
  "task",
] as const;

export const PublicationResourceTypeSchema = z.enum(PUBLICATION_RESOURCE_TYPES);
export type PublicationResourceType = z.infer<typeof PublicationResourceTypeSchema>;

export const PublicationSnapshotSchema = z.object({
  schema_version: z.number().int().positive(),
  resource_type: PublicationResourceTypeSchema,
  title: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type PublicationSnapshot = z.infer<typeof PublicationSnapshotSchema>;

export const CreatePublicationRequestSchema = z.object({
  resource_type: PublicationResourceTypeSchema,
  resource_id: IdSchema,
  target_space_ids: z.array(IdSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  if (new Set(value.target_space_ids).size !== value.target_space_ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_space_ids"],
      message: "target_space_ids must be unique",
    });
  }
});
export type CreatePublicationRequest = z.infer<typeof CreatePublicationRequestSchema>;

export const PublicationImportSummarySchema = z.object({
  id: IdSchema,
  imported_resource_type: PublicationResourceTypeSchema,
  /**
   * The row the importer made in their own Space. Null for anyone but them: a
   * colleague who learns the id of someone's private copy can ask for it by id
   * on every surface that takes one.
   */
  imported_resource_id: IdSchema.nullable(),
  imported_by_user_id: IdSchema,
  created_at: ISODateTimeSchema,
}).strict();
export type PublicationImportSummary = z.infer<typeof PublicationImportSummarySchema>;

export const PublicationImportSchema = PublicationImportSummarySchema.extend({
  /** The importer's own response about their own copy: always named. */
  imported_resource_id: IdSchema,
  publication_id: IdSchema,
  target_space_id: IdSchema,
  publication_version: z.number().int().positive(),
  snapshot_hash: z.string().length(64),
}).strict();
export type PublicationImport = z.infer<typeof PublicationImportSchema>;

export const ContentPublicationSchema = z.object({
  id: IdSchema,
  source_space_id: IdSchema,
  source_resource_type: PublicationResourceTypeSchema,
  source_resource_id: IdSchema,
  version: z.number().int().positive(),
  snapshot_schema_version: z.number().int().positive(),
  /**
   * Withheld with the body it hashes: once a publication is revoked, a hash of
   * content the reader may no longer see still answers "is this the text?" for
   * every guess they can make. The publisher keeps seeing it.
   */
  snapshot_hash: z.string().length(64).nullable(),
  title: z.string(),
  snapshot: PublicationSnapshotSchema,
  published_by_user_id: IdSchema,
  target_space_ids: z.array(IdSchema),
  status: z.enum(["active", "revoked"]),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  revoked_at: ISODateTimeSchema.nullable(),
  revoked_by_user_id: IdSchema.nullable(),
  import: PublicationImportSummarySchema.nullable(),
}).strict();
export type ContentPublication = z.infer<typeof ContentPublicationSchema>;

export const ContentPublicationListSchema = z.object({
  items: z.array(ContentPublicationSchema),
}).strict();
export type ContentPublicationList = z.infer<typeof ContentPublicationListSchema>;
