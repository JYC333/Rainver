import { z } from 'zod';
const id = z.string().trim().min(1).max(36),
  nullable = id.nullable(),
  obj = z.record(z.unknown());
const content = {
  title: z.string().optional(),
  excerpt: z.string().nullable().optional(),
  plain_text: z.string().nullable().optional(),
  content_json: obj.nullable().optional(),
  content_format: z.enum(['markdown', 'plain', 'prosemirror_json']).optional(),
  content_schema_version: z.number().int().positive().optional(),
  primary_project_id: nullable.optional(),
  collection_id: nullable.optional()
};
export const NoteDraftSchema = z.object({
  ...content,
  title: z.string().trim().min(1),
  visibility: z.enum(['private', 'space_shared']).optional(),
  status: z.literal('active').optional(),
  created_from_activity_id: nullable.optional()
}).strict();
export const NoteEditSchema = z.object({
  ...content,
  status: z.enum(['active', 'archived', 'deleted']).optional(),
  project_role: z.string().nullable().optional(),
  expect_version: z.number().int().positive().nullable().optional()
}).strict();
export const CollectionDraftSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1),
  parent_id: nullable.optional(),
  sort_order: z.number().int().nullable().optional()
}).strict();
export const CollectionEditSchema = CollectionDraftSchema.omit({
  id: true
}).partial().extend({
  is_hidden: z.boolean().optional()
}).strict();
const receipt = z.object({
  id,
  space_id: id,
  project_ids: z.array(id)
}).strict();
export const NoteObjectReceiptSchema = receipt.extend({
  version: z.number().int().positive()
}).strict();
export const CollectionReceiptSchema = receipt.extend({
  deleted: z.boolean()
}).strict();
const order = z.number().int().min(0);
export const NoteTreeSchema = z.discriminatedUnion('kind', [z.object({
  kind: z.literal('notes'),
  updates: z.array(z.object({
    note_id: id,
    from_collection_id: id,
    collection_id: id,
    sort_order: order
  }).strict()).min(1).max(500)
}).strict(), z.object({
  kind: z.literal('collections'),
  updates: z.array(z.object({
    id,
    parent_id: nullable,
    sort_order: order
  }).strict()).min(1).max(500)
}).strict()]);
export const NOTE_OBJECT_SCHEMAS = {
  'knowledge.note.create': {
    input: NoteDraftSchema,
    output: NoteObjectReceiptSchema
  },
  'knowledge.note.update': {
    input: z.object({
      note_id: id,
      changes: NoteEditSchema
    }).strict(),
    output: NoteObjectReceiptSchema
  },
  'knowledge.collection.create': {
    input: CollectionDraftSchema,
    output: CollectionReceiptSchema
  },
  'knowledge.collection.update': {
    input: z.object({
      collection_id: id,
      changes: CollectionEditSchema
    }).strict(),
    output: CollectionReceiptSchema
  },
  'knowledge.collection.delete': {
    input: z.object({
      collection_id: id
    }).strict(),
    output: CollectionReceiptSchema
  },
  'knowledge.collection.ensure_project': {
    input: z.object({
      project_id: id
    }).strict(),
    output: CollectionReceiptSchema
  },
  'knowledge.note.placement.add': {
    input: z.object({
      note_id: id,
      collection_id: id,
      share_with_project: z.boolean().default(false)
    }).strict(),
    output: NoteObjectReceiptSchema
  },
  'knowledge.note.placement.remove': {
    input: z.object({
      note_id: id,
      collection_id: id
    }).strict(),
    output: NoteObjectReceiptSchema
  },
  'knowledge.note.share.revoke': {
    input: z.object({
      note_id: id,
      project_id: id
    }).strict(),
    output: NoteObjectReceiptSchema
  },
  'knowledge.note.tree.reorder': {
    input: NoteTreeSchema,
    output: z.object({
      kind: z.enum(['notes', 'collections']),
      updated: z.number().int().nonnegative()
    }).strict()
  }
} as const;

export const NOTE_OBJECT_TITLES:Record<keyof typeof NOTE_OBJECT_SCHEMAS,string>={
 'knowledge.note.create':'Create a working Note','knowledge.note.update':'Edit a working Note',
 'knowledge.collection.create':'Create a Note folder','knowledge.collection.update':'Edit a Note folder','knowledge.collection.delete':'Delete a Note folder','knowledge.collection.ensure_project':'Open the Project Notes folder',
 'knowledge.note.placement.add':'Add a Note placement','knowledge.note.placement.remove':'Remove a Note placement','knowledge.note.share.revoke':'Revoke a Note Project share','knowledge.note.tree.reorder':'Reorder the Notes tree'
};
