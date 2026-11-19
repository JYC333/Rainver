import {z} from 'zod';
import type {PluginOperationManifest} from '@rainver/protocol';

/**
 * Diary: a personal, user-level journal. Browser-safe declaration shared by
 * the server runtime and the bundled view; see OFFICIAL_OPTIONAL_MODULES
 * "Diary package".
 *
 * Every operation is `sensitive` (ADR 0030): an Agent reaches it only with the
 * data owner's own consent in an owner-only, network-isolated Run. Writing and
 * deleting the text are person-only operations; the only Agent write is an
 * append proposal that takes effect after the person approves it and never
 * rewrites what the person wrote.
 */
export const PLUGIN_ID = 'diary';
/** A calendar day; an entry is about a date, not an instant. */
export const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Invalid date');
/** Bounds of one entry's text (the legacy editor had none; 200 000 characters is far above a day's writing). */
export const ENTRY_TEXT_MAX = 200_000;
export const APPEND_TEXT_MAX = 8_000;
export const LIST_LIMIT_MAX = 100;

const Entry = z.object({id: z.string(), user_id: z.string(), entry_date: z.string(), content: z.string(), created_at: z.string(), updated_at: z.string()}).strict();
const Reflection = z.object({id: z.string(), entry_id: z.string(), reflection_date: z.string(), content: z.string(), ai_model: z.string().nullable(), created_at: z.string()}).strict();
export type DiaryEntryOut = z.infer<typeof Entry>;
export type DiaryReflectionOut = z.infer<typeof Reflection>;

export const inputs = {
  'entry.get': z.object({date: DaySchema}).strict(),
  'entry.list': z.object({limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(), before: DaySchema.optional()}).strict(),
  'entry.on_this_day': z.object({date: DaySchema}).strict(),
  'entry.save': z.object({date: DaySchema, content: z.string().max(ENTRY_TEXT_MAX)}).strict(),
  'entry.delete': z.object({date: DaySchema}).strict(),
  'entry.propose_append': z.object({date: DaySchema, text: z.string().trim().min(1).max(APPEND_TEXT_MAX)}).strict(),
  'reflection.list': z.object({date: DaySchema}).strict(),
} as const;
export type DiaryOperation = keyof typeof inputs;

export const outputs = {
  'entry.get': z.object({date: z.string(), entry: Entry.nullable()}).strict(),
  'entry.list': z.object({entries: z.array(Entry)}).strict(),
  'entry.on_this_day': z.object({date: z.string(), entries: z.array(Entry)}).strict(),
  'entry.save': z.object({entry: Entry}).strict(),
  'entry.delete': z.object({deleted: z.boolean()}).strict(),
  'entry.propose_append': z.object({entry_id: z.string(), entry_date: z.string()}).strict(),
  'reflection.list': z.object({entry_date: z.string(), reflections: z.array(Reflection)}).strict(),
} as const;

export const APPEND_PROPOSAL_TYPE = `plugin.${PLUGIN_ID}.entry.append`;
export const REFLECTION_JOB = `plugin.${PLUGIN_ID}.reflection.generate`;
export const ReflectionJobPayload = z.object({entry_id: z.string().min(1).max(64), entry_date: DaySchema}).strict();

type Spec = {title: string; description: string; kind?: 'query'; proposal?: true; person_only?: true};
const specs: Record<DiaryOperation, Spec> = {
  'entry.get': {kind: 'query', title: 'Read a diary entry', description: 'Read your diary entry of one day'},
  'entry.list': {kind: 'query', title: 'List diary entries', description: 'List your recent diary entries, newest first, optionally before a day'},
  'entry.on_this_day': {kind: 'query', title: 'Diary entries on this day', description: 'List your entries written on the same month and day in earlier years'},
  'entry.save': {person_only: true, title: 'Save a diary entry', description: 'Write the text of your diary entry of one day'},
  'entry.delete': {person_only: true, title: 'Delete a diary entry', description: 'Delete your diary entry of one day with its reflections'},
  'entry.propose_append': {proposal: true, title: 'Propose a diary addition', description: 'Propose text to add at the end of a day\'s entry; nothing is written until the person approves it, and existing text is never changed'},
  'reflection.list': {kind: 'query', title: 'List reflections', description: 'List the reflections generated for your entry of one day'},
};

const manifest: PluginOperationManifest = {
  id: PLUGIN_ID,
  version: '1.0.0',
  hostApi: 1,
  scope: 'user',
  name: 'Diary',
  description: 'A personal diary that shows entries from the same day across multiple years, with optional reflections. Agents read it only with your consent and can only propose additions.',
  requires: [],
  permissions: {agent: true, background: true},
  data_access: 'caller_owned',
  entities: [
    {name: 'entry', data_class: 'sensitive'},
    {name: 'reflection', data_class: 'sensitive', exemption: 'Reflections are written only by the reflection Job and deleted with their entry'},
  ],
  migrations: ['0000_diary_records'],
  proposalTypes: [{id: APPEND_PROPOSAL_TYPE, operation: `plugin.${PLUGIN_ID}.entry.propose_append`, payload_schema: inputs['entry.propose_append']}],
  jobs: [{id: REFLECTION_JOB, payload_schema: ReflectionJobPayload}],
  web: {entries: [{id: 'journal', title: 'Diary', icon: 'book', placements: ['navigation']}]},
  operations: (Object.keys(specs) as DiaryOperation[]).map(key => {
    const spec = specs[key];
    const query = spec.kind === 'query';
    return {
      id: `plugin.${PLUGIN_ID}.${key}`,
      version: 1,
      title: spec.title,
      description: spec.description,
      kind: query ? 'query' as const : 'command' as const,
      side_effects: query ? 'none' as const : spec.proposal ? 'proposal' as const : 'durable' as const,
      data_class: 'sensitive' as const,
      input_schema: inputs[key],
      output_schema: outputs[key],
      // Adding to a text the person wrote, in their most sensitive record (ADR 0017 belief reach).
      gate_class: spec.proposal ? 'belief_reach' as const : null,
      ...(spec.proposal ? {proposal_type: APPEND_PROPOSAL_TYPE} : {}),
      ...(spec.person_only ? {actors: ['user'] as ['user']} : {}),
    };
  }),
};
export default manifest;
