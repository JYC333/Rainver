import { z } from "zod";

export const ReaderDocumentTypeSchema = z.enum(["source_item", "source_snapshot", "research_report", "research_notebook"]);

export const ReaderAnnotationCreateSchema = z.object({
  document_type: ReaderDocumentTypeSchema,
  document_id: z.string().min(1),
  annotation_type: z.enum(["highlight", "comment", "excerpt", "bookmark"]),
  quote_text: z.string().min(1),
  anchor_json: z.record(z.string(), z.unknown()),
  color: z.string().optional(),
  label: z.string().optional(),
}).strict();
export type ReaderAnnotationCreate = z.infer<typeof ReaderAnnotationCreateSchema>;

/**
 * A place in a Reader document, taken on one document version. The block's
 * ProseMirror position is exact only on that structure; the quote (start of the
 * block's text) and the text before it relocate it on another version; the
 * progress fraction is the last resort. All offsets are UTF-16 code units.
 */
export const ReaderPositionAnchorSchema = z.object({
  block_index: z.number().int().min(0).max(1_000_000),
  pm_pos: z.number().int().min(0).max(100_000_000),
  text_offset: z.number().int().min(0).max(100_000_000),
  quote: z.string().max(200),
  before_context: z.string().max(80),
}).strict();
export type ReaderPositionAnchor = z.infer<typeof ReaderPositionAnchorSchema>;

export const ReaderPositionMarkSchema = z.object({
  anchor: ReaderPositionAnchorSchema,
  progress: z.number().min(0).max(1),
}).strict();
export type ReaderPositionMark = z.infer<typeof ReaderPositionMarkSchema>;

/**
 * One position report. Rules (server): only a report on the document's
 * current version (both hashes, checked by the server) is applied; any other
 * is not accepted, whatever its time. A stored position from an earlier
 * version is replaced by the first current-version report. Within one version
 * `current` is replaced only by a report with a later `client_at` (a delayed
 * request or an older tab cannot move it back); `furthest` only grows, only
 * from reports that `dwelled` (reading, not scrolling past); `reset_furthest`
 * sets `furthest` to this report's `current` and wins over any report measured
 * before it. `client_at` orders reports of one version only, by the clients'
 * own clocks: a fast clock (up to the 5-minute limit) can outrank a correct
 * one, so it is a tie-breaker, not a proof of real order across devices.
 */
export const ReaderPositionWriteSchema = z.object({
  content_hash: z.string().min(1).max(128),
  structure_hash: z.string().min(1).max(128),
  current: ReaderPositionMarkSchema,
  dwelled: z.boolean().default(false),
  reset_furthest: z.boolean().default(false),
  client_at: z.string().datetime({ offset: true }),
}).strict();
export type ReaderPositionWrite = z.input<typeof ReaderPositionWriteSchema>;

export const ReaderPositionSchema = z.object({
  content_hash: z.string(),
  structure_hash: z.string(),
  current: ReaderPositionMarkSchema,
  furthest: ReaderPositionMarkSchema.nullable(),
  current_client_at: z.string(),
  updated_at: z.string(),
  /** Increases with every stored change; a client keeps the reply with the highest one, whatever order replies arrive in. */
  revision: z.number().int().min(0),
}).strict();
export type ReaderPosition = z.infer<typeof ReaderPositionSchema>;
export const ReaderPositionResultSchema = z.object({ position: ReaderPositionSchema.nullable(), accepted: z.boolean() }).strict();
export type ReaderPositionResult = z.infer<typeof ReaderPositionResultSchema>;

/** A person's Reader appearance, kept in their user settings (all Spaces, all devices). */
export const ReaderAppearanceSchema = z.object({
  font_size: z.number().int().min(14).max(26).nullable().default(null),
  line_height: z.enum(['compact', 'normal', 'relaxed']).default('normal'),
  width: z.enum(['narrow', 'medium', 'wide']).default('medium'),
  font: z.enum(['sans', 'serif']).default('sans'),
  theme: z.enum(['app', 'light', 'sepia', 'dark']).default('app'),
}).strict();
export type ReaderAppearance = z.infer<typeof ReaderAppearanceSchema>;


/** Replace a quote on the version shown, without overwriting another range edit. */
export const ReaderAnnotationRangeUpdateSchema = z.object({
  expected_quote_text: z.string().min(1).max(200000),
  expected_anchor_json: z.record(z.string(), z.unknown()),
  content_hash: z.string().min(1).max(128),
  structure_hash: z.string().min(1).max(128),
  quote_text: z.string().min(1).max(200000),
  anchor_json: z.object({
    schema_version: z.literal(1), normalizer: z.literal("plain_text_v1"),
    quote_text: z.string().min(1).max(200000),
    text_range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), unit: z.literal("utf16") }).strict(),
    before_context: z.string().max(10000), after_context: z.string().max(10000),
    content_hash: z.string().min(1).max(128), structure_hash: z.string().min(1).max(128),
    document_ref: z.object({ document_type: ReaderDocumentTypeSchema, document_id: z.string().min(1) }).strict(),
    tiptap_range: z.object({ from: z.number().int().nonnegative(), to: z.number().int().positive() }).strict().refine(range => range.to > range.from).optional(),
    block_ref: z.object({ index: z.number().int().nonnegative(), node_type: z.string().min(1), from: z.number().int().nonnegative(), to: z.number().int().positive() }).strict().optional(),
  }).strict(),
}).strict().refine(input => input.anchor_json.quote_text === input.quote_text
  && input.anchor_json.text_range.end >= input.anchor_json.text_range.start
  && input.anchor_json.content_hash === input.content_hash && input.anchor_json.structure_hash === input.structure_hash,
  { message: "Replacement anchor must match the quote and document version" });
export type ReaderAnnotationRangeUpdate = z.infer<typeof ReaderAnnotationRangeUpdateSchema>;

export const ReaderDocumentNoteCreateSchema = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict();
export const ReaderDocumentNoteResponseSchema = z.object({ note: z.object({ id: z.string().min(1), space_id: z.string().min(1), status: z.enum(['active','archived','deleted']) }).strict().nullable() }).strict();
export type ReaderDocumentNoteResponse = z.infer<typeof ReaderDocumentNoteResponseSchema>;
