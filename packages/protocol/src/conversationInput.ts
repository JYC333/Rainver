/**
 * Conversation input contracts.
 *
 * The browser sends opaque media ids and logical file references. It never
 * sends a host path, a file body, or an ACP-shaped object. The server owns
 * storage, authorization, snapshots, and the final ACP content blocks.
 */

import { z } from "zod";
import { IdSchema } from "./common.js";

export const CONVERSATION_MAX_IMAGES = 4;
export const CONVERSATION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const CONVERSATION_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const CONVERSATION_MAX_FILE_REFERENCES = 8;
export const CONVERSATION_MAX_FILE_SNAPSHOT_BYTES = 512 * 1024;
export const CONVERSATION_MAX_TOTAL_FILE_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export const ConversationImageMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export type ConversationImageMediaType = z.infer<typeof ConversationImageMediaTypeSchema>;

const SafeRelativePathSchema = z.string().trim().min(1).max(4096).refine(
  (value) => !value.startsWith("/") && !value.startsWith("\\") && !value.split(/[\\/]+/u).includes(".."),
  "path must be relative to an authorized workspace location",
);

export const ConversationInputImagePartSchema = z.object({
  kind: z.literal("image"),
  /** A server-issued id for a pending or message-owned media object. */
  media_id: IdSchema,
  filename: z.string().trim().min(1).max(512),
  media_type: ConversationImageMediaTypeSchema,
  byte_size: z.number().int().positive().max(CONVERSATION_MAX_IMAGE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
}).strict();
export type ConversationInputImagePart = z.infer<typeof ConversationInputImagePartSchema>;

export const ConversationInputMediaOutSchema = z.object({
  media_id: IdSchema,
  filename: z.string().trim().min(1).max(512),
  media_type: ConversationImageMediaTypeSchema,
  byte_size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  expires_at: z.string(),
}).strict();
export type ConversationInputMediaOut = z.infer<typeof ConversationInputMediaOutSchema>;

export const ConversationInputFileReferencePartSchema = z.object({
  kind: z.literal("file_reference"),
  project_folder_id: IdSchema,
  workspace_location_id: IdSchema,
  relative_path: SafeRelativePathSchema,
  display_name: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(256),
  byte_size: z.number().int().nonnegative().max(CONVERSATION_MAX_FILE_SNAPSHOT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type ConversationInputFileReferencePart = z.infer<typeof ConversationInputFileReferencePartSchema>;

export const ConversationInputPartSchema = z.discriminatedUnion("kind", [
  ConversationInputImagePartSchema,
  ConversationInputFileReferencePartSchema,
]);
export type ConversationInputPart = z.infer<typeof ConversationInputPartSchema>;

export const ConversationInputPartsSchema = z.array(ConversationInputPartSchema)
  .max(CONVERSATION_MAX_IMAGES + CONVERSATION_MAX_FILE_REFERENCES)
  .superRefine((parts, ctx) => {
    const images = parts.filter((part): part is ConversationInputImagePart => part.kind === "image");
    const files = parts.filter((part): part is ConversationInputFileReferencePart => part.kind === "file_reference");
    if (images.length > CONVERSATION_MAX_IMAGES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${CONVERSATION_MAX_IMAGES} images are allowed` });
    }
    if (files.length > CONVERSATION_MAX_FILE_REFERENCES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${CONVERSATION_MAX_FILE_REFERENCES} file references are allowed` });
    }
    const totalImageBytes = images.reduce((sum, part) => sum + part.byte_size, 0);
    if (totalImageBytes > CONVERSATION_MAX_TOTAL_IMAGE_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `images exceed the ${CONVERSATION_MAX_TOTAL_IMAGE_BYTES}-byte message limit` });
    }
    const totalFileBytes = files.reduce((sum, part) => sum + part.byte_size, 0);
    if (totalFileBytes > CONVERSATION_MAX_TOTAL_FILE_SNAPSHOT_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `file references exceed the ${CONVERSATION_MAX_TOTAL_FILE_SNAPSHOT_BYTES}-byte message limit` });
    }
  });

export const ConversationInputFileSearchItemSchema = z.object({
  project_folder_id: IdSchema,
  workspace_location_id: IdSchema,
  source: z.string().trim().min(1).max(512),
  relative_path: SafeRelativePathSchema,
  display_name: z.string().trim().min(1).max(512),
  kind: z.literal("file"),
  size_bytes: z.number().int().nonnegative(),
}).strict();
export type ConversationInputFileSearchItem = z.infer<typeof ConversationInputFileSearchItemSchema>;

export const ConversationInputFileSearchResponseSchema = z.object({
  items: z.array(ConversationInputFileSearchItemSchema).max(20),
  truncated: z.boolean(),
}).strict();
export type ConversationInputFileSearchResponse = z.infer<typeof ConversationInputFileSearchResponseSchema>;

export const ConversationMessageInputSchema = z.object({
  text: z.string().trim().max(8000).default(""),
  input_parts: ConversationInputPartsSchema.default([]),
}).superRefine((value, ctx) => {
  if (!value.text && value.input_parts.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "text or an input part is required" });
  }
});
export type ConversationMessageInput = z.infer<typeof ConversationMessageInputSchema>;

/** Unknown is represented by null; false is an explicit capability answer. */
export const RuntimePromptCapabilitiesSchema = z.object({
  image: z.boolean().nullable(),
  embedded_context: z.boolean().nullable(),
  resource_link: z.boolean().nullable(),
}).strict();
export type RuntimePromptCapabilities = z.infer<typeof RuntimePromptCapabilitiesSchema>;

export const ConversationInputResourceSchema = z.object({
  input_id: IdSchema,
  workspace_location_id: IdSchema,
  relative_path: SafeRelativePathSchema,
  /** Only populated for a built-in Host; it is relative to the shared instance workspace root. */
  workspace_relative_path: SafeRelativePathSchema.optional(),
  name: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(256),
  size_bytes: z.number().int().nonnegative(),
}).strict();
export type ConversationInputResource = z.infer<typeof ConversationInputResourceSchema>;
