import { z } from "zod";
import { IdSchema } from "./common.js";

/**
 * One capture gesture, several destinations.
 *
 * The client picks a destination; the server does not re-infer one. Inference
 * from a paste event or a URL is a *default* offered before typing, and it is
 * only knowable in the browser — a paste is an input event, not a property of
 * the text that arrives here.
 *
 * Every destination creates an `activity_record` first, which is what makes
 * capture uniform: the two marginalia destinations additionally project the
 * text into a private note in the same transaction, and the two raw
 * destinations leave it awaiting processing.
 */
export const CAPTURE_DESTINATION_VALUES = [
  /** Private margin note on the object the Area is currently about. */
  "object_marginalia",
  /** Private margin note on the Project itself. */
  "project_marginalia",
  /** Team-visible Project raw material, awaiting processing. */
  "project_raw",
  /** Personal Space inbox, awaiting processing. */
  "personal_inbox",
] as const;
export const CaptureDestinationSchema = z.enum(CAPTURE_DESTINATION_VALUES);
export type CaptureDestination = z.infer<typeof CaptureDestinationSchema>;

export const CaptureRequestSchema = z.object({
  text: z.string().trim().min(1).max(20000),
  destination: CaptureDestinationSchema,
  /** Required by every destination except `personal_inbox`. */
  project_id: IdSchema.optional(),
  /** Required by `object_marginalia`; a `space_objects` row id. */
  target_id: IdSchema.optional(),
}).strict();
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

export const CaptureResponseSchema = z.object({
  activity_id: IdSchema,
  destination: CaptureDestinationSchema,
  space_id: IdSchema,
  project_id: IdSchema.nullable(),
  visibility: z.enum(["private", "space_shared"]),
  status: z.enum(["raw", "processed"]),
  /** The marginalia note the capture was projected into, when there is one. */
  note_id: IdSchema.nullable(),
  note_title: z.string().nullable(),
  /**
   * The note block this capture became. It is what relocation later extracts
   * by: a block index would not survive the user inserting a line above it.
   */
  block_id: IdSchema.nullable(),
}).strict();
export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

/**
 * Relocating a capture, and promoting private marginalia to team material —
 * one mechanism, because they are the same act seen from different ends.
 *
 * `move` takes the blocks out of the source note; `copy` leaves them. They are
 * different verbs with different authority because they have different
 * consequences: a move changes what the team has, a copy changes who holds it.
 */
export const RELOCATION_MODE_VALUES = ["move", "copy"] as const;
export const RelocationModeSchema = z.enum(RELOCATION_MODE_VALUES);
export type RelocationMode = z.infer<typeof RelocationModeSchema>;

export const RelocationBlockSchema = z.object({
  block_id: IdSchema,
  text: z.string(),
  /** The capture's own block. Preselected; the rest are offered unchecked. */
  anchored: z.boolean(),
}).strict();

export const RelocationPreviewSchema = z.object({
  activity_id: IdSchema,
  note_id: IdSchema,
  blocks: z.array(RelocationBlockSchema),
  can_move: z.boolean(),
  can_copy_out: z.boolean(),
}).strict();
export type RelocationPreview = z.infer<typeof RelocationPreviewSchema>;

export const RelocationRequestSchema = z.object({
  destination: CaptureDestinationSchema,
  mode: RelocationModeSchema,
  /** Must be blocks the preview offered; anything else is refused. */
  block_ids: z.array(IdSchema).min(1).max(50),
  project_id: IdSchema.optional(),
  target_id: IdSchema.optional(),
}).strict();
export type RelocationRequest = z.infer<typeof RelocationRequestSchema>;

export const RelocationResponseSchema = z.object({
  activity_id: IdSchema,
  destination: CaptureDestinationSchema,
  mode: RelocationModeSchema,
  moved_block_ids: z.array(IdSchema),
  note_id: IdSchema.nullable(),
  block_id: IdSchema.nullable(),
}).strict();
export type RelocationResponse = z.infer<typeof RelocationResponseSchema>;
