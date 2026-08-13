import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";

/**
 * Filing a personal capture into a Project (ADR 0013 decision 6).
 *
 * A capture and a formal object are different kinds of thing, so filing is a
 * transformation rather than a copy: a new object is created in the target
 * Project's Space and the original capture stays in the personal Space as
 * provenance. There is therefore no second copy to keep in sync.
 */
export const CaptureFilingRequestSchema = z.object({
  activity_id: IdSchema,
  target_project_id: IdSchema,
  title: z.string().trim().min(1).max(512).optional(),
}).strict();

export const CaptureFilingResponseSchema = z.object({
  activity_id: IdSchema,
  object_id: IdSchema,
  target_space_id: IdSchema,
  target_project_id: IdSchema,
  visibility: z.literal("space_shared"),
  filed_at: ISODateTimeSchema,
}).strict();
