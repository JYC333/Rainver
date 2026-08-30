/**
 * Thread references — content a person picks from one conversation and copies
 * into another.
 *
 * A reference is **content, not a pointer**. It is resolved once, at the
 * moment a person attaches it, and lands in the target thread as a message
 * carrying its provenance. It never re-reads its source afterwards
 * (ADR 0018; `.agent/modules/rooms.md` §Thread References), which keeps a single
 * act of disclosure from becoming an ongoing one and keeps the agent's
 * knowledge inside a thread the same for everyone who speaks in it.
 *
 * What may be picked, and at what grain:
 *
 * - `thread` — another Room conversation, carried as its summary *as it stands
 *   now*. A whole thread is otherwise far past any turn's budget.
 * - `messages` — specific messages from another conversation, any set, not
 *   only a tail.
 * - `imported_session` — an imported CLI session, carried as its summary.
 * - `imported_records` — specific records from one.
 *
 * The two grains may be combined in a single attach.
 */

import { z } from "zod";
import { IdSchema } from "./common.js";

export const THREAD_REFERENCE_SOURCE_KINDS = [
  "thread",
  "messages",
  "imported_session",
  "imported_records",
] as const;
export const ThreadReferenceSourceKindSchema = z.enum(THREAD_REFERENCE_SOURCE_KINDS);
export type ThreadReferenceSourceKind = z.infer<typeof ThreadReferenceSourceKindSchema>;

/**
 * One pick. `id` names the conversation or imported session it comes from;
 * `item_ids` names the messages or records when the grain is specific ones.
 */
export const ThreadReferencePickSchema = z.object({
  kind: ThreadReferenceSourceKindSchema,
  id: IdSchema,
  item_ids: z.array(IdSchema).max(200).optional(),
}).strict();
export type ThreadReferencePick = z.infer<typeof ThreadReferencePickSchema>;

export const AttachThreadReferencesRequestSchema = z.object({
  references: z.array(ThreadReferencePickSchema).min(1).max(20),
  /**
   * Required when the pick's audience is narrower than the target's. The
   * server refuses without it and says who would gain access, rather than
   * copying quietly across a boundary somebody chose
   * (ADR 0013, ADR 0018 decision 3).
   *
   * Prefer echoing back the `gains_access_user_ids` the refusal named: a
   * roster can grow between the refusal and the confirmation, and a bare
   * `true` would then consent to people the person was never shown.
   */
  confirm_disclosure: z.union([z.boolean(), z.array(IdSchema)]).optional(),
}).strict();
export type AttachThreadReferencesRequest = z.infer<typeof AttachThreadReferencesRequestSchema>;

/** The 409 raised when a whole source has no summary to carry. */
export const ThreadReferenceSummaryUnavailableSchema = z.object({
  code: z.literal("reference_summary_unavailable"),
  detail: z.string().trim().min(1),
}).strict();
export type ThreadReferenceSummaryUnavailable = z.infer<typeof ThreadReferenceSummaryUnavailableSchema>;

/**
 * The 409 a cross-audience attach is refused with. `gains_access_user_ids` is
 * the point of it: a confirmation that cannot name who is being let in is not
 * informed consent.
 */
export const ThreadReferenceDisclosureRequiredSchema = z.object({
  code: z.literal("reference_disclosure_confirmation_required"),
  detail: z.string().trim().min(1),
  gains_access_user_ids: z.array(IdSchema),
}).strict();
export type ThreadReferenceDisclosureRequired = z.infer<typeof ThreadReferenceDisclosureRequiredSchema>;

/**
 * What a `reference` message carries in `metadata_json.reference`.
 *
 * `trust` follows provenance, not the attacher: content from another Rainver
 * thread is `domain_approved`, content from a vendor CLI transcript is
 * `external_untrusted`. Neither is user evidence — the checkpoint extractor
 * derives confirmation from `role = 'user'` alone, and a reference is a
 * system-role message.
 *
 * This is a *provenance* label, recorded on the message and read by whatever
 * displays or later consumes it. It is deliberately not the engine's
 * `ContextItem.trust`: a reference reaches a turn inside the Room continuity
 * item, which carries one trust for the whole block, and giving each
 * reference its own would mean splitting that item — a change to the
 * acquisition path, not to what a reference is.
 */
export const ThreadReferenceProvenanceSchema = z.object({
  kind: ThreadReferenceSourceKindSchema,
  source_id: IdSchema,
  /**
   * The Room the source conversation lives in, so a reader can open it. Null
   * for an imported session, which is reached by its own page and has no Room.
   *
   * Recorded at attach time like everything else here: a reference is a
   * snapshot, and re-deriving this later would mean re-reading a source the
   * reader may no longer be allowed to see.
   */
  source_room_id: IdSchema.nullable(),
  source_title: z.string().nullable(),
  item_ids: z.array(IdSchema),
  trust: z.enum(["domain_approved", "external_untrusted"]),
  /** Set when the copy was fitted to the context budget. */
  clipped: z.boolean(),
  attached_by_user_id: IdSchema,
  attached_at: z.string().min(1),
}).strict();
export type ThreadReferenceProvenance = z.infer<typeof ThreadReferenceProvenanceSchema>;
