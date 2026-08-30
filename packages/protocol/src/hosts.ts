/**
 * Execution-host contracts: what a paired host can run, and what a dispatch
 * to it can choose from.
 *
 * The daemon's heartbeat is normalized by the server into `HostCapabilities`
 * before it is stored, so this is the one shape the server, the web, and any
 * other reader agree on — a runtime on a host has one identity, adapter type
 * × copy, and everything about a copy lives on the copy.
 */

import { z } from "zod";
import { IdSchema } from "./common.js";

export const RuntimeOptionChoiceSchema = z.object({
  value: z.string(),
  /** The runtime's own display name for the choice, when it gave one. */
  name: z.string().nullable(),
  /** What the choice resolves to, when the runtime said (e.g. what `default` means). */
  description: z.string().nullable(),
});
export type RuntimeOptionChoice = z.infer<typeof RuntimeOptionChoiceSchema>;

/**
 * What a copy of a runtime says it can be set to, asked over ACP — never a
 * guessed list: effort levels differ per runtime, and model ids can carry
 * brackets that are part of the name. Empty lists with current values mean
 * the copy could not be asked and only its configured model/effort is known.
 */
export const RuntimeOptionsSchema = z.object({
  models: z.array(RuntimeOptionChoiceSchema),
  current_model: z.string().nullable(),
  efforts: z.array(RuntimeOptionChoiceSchema),
  current_effort: z.string().nullable(),
});
export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>;

export const OWN_INSTALLATION = "own";

/** One copy of a runtime on a host: the machine's own PATH install, or a daemon-managed one. */
export const RuntimeInstallationSchema = z.object({
  /** `own` or `managed:<version>`. */
  id: z.string(),
  version: z.string().nullable(),
  /** Whether its login state exists; null when the runtime declares no login. */
  logged_in: z.boolean().nullable(),
  /** Null when the copy could not be asked and has no configured model either. */
  options: RuntimeOptionsSchema.nullable(),
});
export type RuntimeInstallation = z.infer<typeof RuntimeInstallationSchema>;

export const HostCapabilitiesSchema = z.object({
  /** PATH binaries the daemon found (vendor CLIs and git), for display only. */
  runtimes: z.array(z.string()),
  versions: z.record(z.string(), z.string()),
  /** Every copy of every adapter, keyed by adapter type. */
  installations: z.record(z.string(), z.array(RuntimeInstallationSchema)),
});
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

/** The server's name for a backend that is not a ModelProvider. */
export const INHERIT_BACKEND = "inherit";
export const AMBIENT_BACKEND = "ambient";

/**
 * One backend a dispatch to a host copy can run on, as the server decides
 * it: `inherit` (the thread's own, or the host default), `ambient` (the
 * copy's own login), or a ModelProvider id — with whether it is usable and
 * why not, and the models/efforts it offers.
 */
export const DispatchBackendSchema = z.object({
  id: z.string(),
  label: z.string(),
  usable: z.boolean(),
  reason: z.string().nullable(),
  /** What `inherit` stands for: `ambient` or a provider id; null otherwise. */
  resolves_to: z.string().nullable(),
  models: z.array(RuntimeOptionChoiceSchema),
  current_model: z.string().nullable(),
  efforts: z.array(RuntimeOptionChoiceSchema),
  current_effort: z.string().nullable(),
});
export type DispatchBackend = z.infer<typeof DispatchBackendSchema>;

/** What a dispatch to a host can choose from (`GET /hosts/:id/dispatch-options`). */
export const DispatchOptionsSchema = z.object({
  adapters: z.array(z.object({
    adapter_type: z.string(),
    display_name: z.string(),
    installations: z.array(RuntimeInstallationSchema.pick({ id: true, version: true, logged_in: true })),
  })),
  /** The effective selection: a thread's pin, else the request's, else the default. */
  adapter_type: z.string().nullable(),
  installation: z.string().nullable(),
  backends: z.array(DispatchBackendSchema),
});
export type DispatchOptions = z.infer<typeof DispatchOptionsSchema>;

export const HostExecutionTargetLocationSchema = z.object({
  id: IdSchema,
  project_folder_id: IdSchema,
  folder_name: z.string().trim().min(1),
  display_path: z.string().nullable(),
  execution_ready: z.boolean(),
}).strict();
export type HostExecutionTargetLocation = z.infer<typeof HostExecutionTargetLocationSchema>;

export const HostExecutionTargetAdapterSchema = z.object({
  adapter_type: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  installations: z.array(RuntimeInstallationSchema.pick({ id: true, version: true, logged_in: true })),
}).strict();
export type HostExecutionTargetAdapter = z.infer<typeof HostExecutionTargetAdapterSchema>;

export const HostExecutionTargetSchema = z.object({
  host_id: IdSchema,
  host_name: z.string().trim().min(1),
  host_online: z.boolean(),
  locations: z.array(HostExecutionTargetLocationSchema),
  adapters: z.array(HostExecutionTargetAdapterSchema),
}).strict();
export type HostExecutionTarget = z.infer<typeof HostExecutionTargetSchema>;

export const HostExecutionTargetsResponseSchema = z.object({
  targets: z.array(HostExecutionTargetSchema),
}).strict();
export type HostExecutionTargetsResponse = z.infer<typeof HostExecutionTargetsResponseSchema>;
