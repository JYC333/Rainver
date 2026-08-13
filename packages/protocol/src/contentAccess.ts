/** Wire-safe cross-person content access audit contracts. */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

export const ContentReadTraceSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    resource_type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    resource_id: IdSchema,
    owner_user_id: IdSchema,
    viewer_user_id: IdSchema,
    agent_id: IdSchema.nullish(),
    run_id: IdSchema.nullish(),
    access_type: z.string(),
    reason: z.string().nullish(),
    accessed_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();

