/**
 * Network profile contracts.
 *
 * Network profiles are space-scoped policy objects. They describe how server
 * provider calls and managed CLI subprocesses should reach the network without
 * storing provider secrets or broad process environment.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

export const NETWORK_PROFILE_MODE_VALUES = ["direct", "http_proxy"] as const;

export const NetworkProfileDTOSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    name: z.string(),
    mode: z.enum(NETWORK_PROFILE_MODE_VALUES),
    proxy_url: z.string().nullish(),
    no_proxy: z.string().nullish(),
    enabled: z.boolean(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();

export const NetworkProfileCreateRequestSchema = z.object({
  name: z.string().min(1),
  mode: z.enum(NETWORK_PROFILE_MODE_VALUES).default("http_proxy"),
  proxy_url: z.string().nullish(),
  no_proxy: z.string().nullish(),
  enabled: z.boolean().optional(),
});

export const NetworkProfileUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  mode: z.enum(NETWORK_PROFILE_MODE_VALUES).optional(),
  proxy_url: z.string().nullish(),
  no_proxy: z.string().nullish(),
  enabled: z.boolean().optional(),
});

export const CliCredentialProfileUpdateRequestSchema = z.object({
  network_profile_id: IdSchema.nullish(),
});
