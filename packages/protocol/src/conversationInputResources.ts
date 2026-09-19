/**
 * Contracts for server-owned recovery drafts and immutable message resources.
 *
 * These are shapes only. The Project Folder service owns draft authority, the
 * sessions service owns message-resource freezing, and the Run System Action
 * dispatcher owns lazy reads. No schema here grants access or carries a body
 * in the current-file request.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";

export const PROJECT_FILE_DRAFT_MAX_BYTES = 1 * 1024 * 1024;
export const INPUT_RESOURCE_MAX_BYTES = 512 * 1024;
export const INPUT_RESOURCE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const INPUT_RESOURCE_MAX_REFERENCES = 8;
export const INPUT_RESOURCE_MAX_READ_LINES = 400;
export const INPUT_RESOURCE_MAX_READ_BYTES = 64 * 1024;
export const INPUT_RESOURCE_MAX_SEARCH_RESULTS = 20;
export const INPUT_RESOURCE_MAX_QUERY_LENGTH = 512;

export const INPUT_RESOURCE_READ_ACTION_ID = "input_resource.read" as const;
export const INPUT_RESOURCE_SEARCH_ACTION_ID = "input_resource.search" as const;

export const ProjectFileDraftTargetKindSchema = z.enum(["existing", "new"]);
export type ProjectFileDraftTargetKind = z.infer<typeof ProjectFileDraftTargetKindSchema>;

export const ProjectFileDraftEncodingSchema = z.enum(["utf8", "utf16le", "utf16be"]);
export type ProjectFileDraftEncoding = z.infer<typeof ProjectFileDraftEncodingSchema>;

export const TextLineEndingModeSchema = z.enum(["lf", "crlf", "mixed", "none"]);
export type TextLineEndingMode = z.infer<typeof TextLineEndingModeSchema>;

export const TextFileAdmissionEncodingSchema = z.enum([
  "utf8",
  "utf16le",
  "utf16be",
  "binary",
  "unknown",
]);
export type TextFileAdmissionEncoding = z.infer<typeof TextFileAdmissionEncodingSchema>;

export const StrictTextFileMetadataSchema = z.object({
  encoding: TextFileAdmissionEncodingSchema,
  byte_size: z.number().int().nonnegative().max(PROJECT_FILE_DRAFT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  line_count: z.number().int().nonnegative(),
  has_bom: z.boolean(),
  line_ending_mode: TextLineEndingModeSchema,
  writable: z.boolean(),
  conversion_available: z.boolean(),
}).strict();
export type StrictTextFileMetadata = z.infer<typeof StrictTextFileMetadataSchema>;

export const ProjectFileDraftSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  project_id: IdSchema,
  project_folder_id: IdSchema,
  workspace_location_id: IdSchema,
  owner_user_id: IdSchema,
  target_kind: ProjectFileDraftTargetKindSchema,
  relative_path: z.string().trim().min(1).max(4096),
  base_exists: z.boolean(),
  base_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  content: z.string().max(PROJECT_FILE_DRAFT_MAX_BYTES),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byte_size: z.number().int().nonnegative().max(PROJECT_FILE_DRAFT_MAX_BYTES),
  version: z.number().int().positive(),
  source_encoding: ProjectFileDraftEncodingSchema,
  preserve_bom: z.boolean(),
  line_ending_mode: TextLineEndingModeSchema,
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  expires_at: ISODateTimeSchema,
}).strict();
export type ProjectFileDraft = z.infer<typeof ProjectFileDraftSchema>;

export const ProjectFileDraftMutationSchema = z.object({
  expected_version: z.number().int().positive().nullable().optional(),
  target_kind: ProjectFileDraftTargetKindSchema,
  relative_path: z.string().trim().min(1).max(4096),
  base_exists: z.boolean(),
  base_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  content: z.string().max(PROJECT_FILE_DRAFT_MAX_BYTES),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byte_size: z.number().int().nonnegative().max(PROJECT_FILE_DRAFT_MAX_BYTES),
  source_encoding: ProjectFileDraftEncodingSchema,
  preserve_bom: z.boolean(),
  line_ending_mode: TextLineEndingModeSchema,
}).strict();
export type ProjectFileDraftMutation = z.infer<typeof ProjectFileDraftMutationSchema>;

export const InputResourceSelectionSchema = z.object({
  start_line: z.number().int().min(1),
  start_column: z.number().int().min(1),
  end_line: z.number().int().min(1),
  end_column: z.number().int().min(1),
}).strict().superRefine((selection, context) => {
  if (
    selection.end_line < selection.start_line
    || (selection.end_line === selection.start_line && selection.end_column < selection.start_column)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_line"], message: "end_line must not precede start_line" });
  }
});
export type InputResourceSelection = z.infer<typeof InputResourceSelectionSchema>;

const CurrentSavedFilePartSchema = z.object({
  kind: z.literal("input_resource"),
  source_state: z.literal("saved"),
  project_folder_id: IdSchema,
  workspace_location_id: IdSchema,
  relative_path: z.string().trim().min(1).max(4096),
  display_name: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(256),
  byte_size: z.number().int().nonnegative().max(INPUT_RESOURCE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  selection: InputResourceSelectionSchema.optional(),
}).strict();

const CurrentDraftFilePartSchema = z.object({
  kind: z.literal("input_resource"),
  source_state: z.literal("draft"),
  draft_id: IdSchema,
  draft_version: z.number().int().positive(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  display_name: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(256),
  byte_size: z.number().int().nonnegative().max(INPUT_RESOURCE_MAX_BYTES),
  selection: InputResourceSelectionSchema.optional(),
}).strict();

export const ConversationInputResourcePartSchema = z.discriminatedUnion("source_state", [
  CurrentSavedFilePartSchema,
  CurrentDraftFilePartSchema,
]);
export type ConversationInputResourcePart = z.infer<typeof ConversationInputResourcePartSchema>;

export const ConversationInputResourceMessagePartSchema = z.object({
  kind: z.literal("input_resource"),
  id: IdSchema,
  resource_id: IdSchema,
  source_state: z.enum(["saved", "draft"]),
  display_name: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(256),
  byte_size: z.number().int().nonnegative().max(INPUT_RESOURCE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  relative_path: z.string().trim().min(1).max(4096).nullable(),
  captured_at: ISODateTimeSchema,
  selection: InputResourceSelectionSchema.optional(),
}).strict();
export type ConversationInputResourceMessagePart = z.infer<typeof ConversationInputResourceMessagePartSchema>;

export const ConversationInputResourceDescriptorSchema = z.object({
  resource_id: IdSchema,
  source_state: z.enum(["saved", "draft"]),
  display_name: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(256),
  relative_path: z.string().trim().min(1).max(4096).nullable(),
  byte_size: z.number().int().nonnegative().max(INPUT_RESOURCE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  captured_at: ISODateTimeSchema,
  selection: InputResourceSelectionSchema.optional(),
}).strict();
export type ConversationInputResourceDescriptor = z.infer<typeof ConversationInputResourceDescriptorSchema>;

export const InputResourceReadInputSchema = z.object({
  resource_id: IdSchema,
  start_line: z.number().int().min(1).default(1),
  line_count: z.number().int().min(1).max(INPUT_RESOURCE_MAX_READ_LINES).default(INPUT_RESOURCE_MAX_READ_LINES),
}).strict();
export type InputResourceReadInput = z.infer<typeof InputResourceReadInputSchema>;

export const InputResourceReadOutputSchema = z.object({
  resource_id: IdSchema,
  start_line: z.number().int().min(1),
  end_line: z.number().int().min(1),
  next_line: z.number().int().min(1).nullable(),
  total_lines: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  content: z.string().max(INPUT_RESOURCE_MAX_READ_BYTES),
  truncated: z.boolean(),
}).strict();
export type InputResourceReadOutput = z.infer<typeof InputResourceReadOutputSchema>;

export const InputResourceSearchInputSchema = z.object({
  resource_id: IdSchema,
  query: z.string().trim().min(1).max(INPUT_RESOURCE_MAX_QUERY_LENGTH),
  case_sensitive: z.boolean().default(false),
  max_results: z.number().int().min(1).max(INPUT_RESOURCE_MAX_SEARCH_RESULTS).default(INPUT_RESOURCE_MAX_SEARCH_RESULTS),
}).strict();
export type InputResourceSearchInput = z.infer<typeof InputResourceSearchInputSchema>;

export const InputResourceSearchMatchSchema = z.object({
  line: z.number().int().min(1),
  excerpt: z.string().max(1024),
}).strict();
export type InputResourceSearchMatch = z.infer<typeof InputResourceSearchMatchSchema>;

export const InputResourceSearchOutputSchema = z.object({
  resource_id: IdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  matches: z.array(InputResourceSearchMatchSchema).max(INPUT_RESOURCE_MAX_SEARCH_RESULTS),
  truncated: z.boolean(),
}).strict();
export type InputResourceSearchOutput = z.infer<typeof InputResourceSearchOutputSchema>;

/** Runtime support is independent from ACP ResourceLink support. */
export const RuntimeInputResourceCapabilitySchema = z.object({
  read: z.boolean().nullable(),
  search: z.boolean().nullable(),
}).strict();
export type RuntimeInputResourceCapability = z.infer<typeof RuntimeInputResourceCapabilitySchema>;
