import {z} from 'zod';
import type {PluginOperationManifest} from '@rainver/protocol';
import {APPLICATION_TRACKS, CONTACT_CHANNELS, CONTACT_DIRECTIONS, CONTACT_LINKS_MAX, CONTACT_RESPONSES, CONTACT_ROLES, DEADLINE_KINDS, DECISION_STATUSES, FUNDING_LINKS_MAX, FUNDING_SUBMISSIONS, LIBRARY_KINDS, MATERIAL_KINDS, MATERIAL_STATUSES, PROGRESS_STATUSES} from './domain.js';

/**
 * Application management: the first bundled Project-level operation package
 * (PhD application is its first track, funding its second). Browser-safe declaration shared by the
 * server runtime and the bundled views; see OFFICIAL_OPTIONAL_MODULES
 * "Application management package".
 */
export const PLUGIN_ID = 'applications';
const id = z.string().trim().min(1).max(64);
const project = {project_id: id};
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
/** A calendar day; the record is about a date, not an instant. */
export const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Invalid date');
/** Only web links: a stored source is rendered as a link and must never carry a script URL. */
export const SourceUrlSchema = z.string().trim().max(2000).url().refine(v => /^https?:\/\//i.test(v), 'Only http(s) links');
const SourceSchema = z.object({label: optionalText(200), url: SourceUrlSchema.nullable().optional()}).strict();
const DeadlineInput = z.object({kind: z.enum(DEADLINE_KINDS), label: optionalText(200), due_on: DaySchema}).strict();
const ReferenceInput = z.object({type: z.enum(['artifact', 'task']), id}).strict();

const Day = z.string();
const Stamp = z.string();
const SourceOut = z.object({label: z.string().nullable(), url: z.string().nullable()}).strict();
const DeadlineOut = z.object({id: z.string(), kind: z.string(), label: z.string().nullable(), due_on: Day, task_id: z.string().nullable()}).strict();
const Version = z.number().int().positive();
const GenerationRowOut = z.object({
  id: z.string(), requirements: z.string(), created_at: z.string(),
  applied: z.object({note_id: z.string(), note_version: Version, applied_at: z.string()}).strict().nullable(),
}).strict();
/** A Note as a material shows it: title and current version only when every reader may still read it in this Project. */
const NoteRefOut = {note_id: z.string(), title: z.string().nullable(), current_version: Version.nullable(), available: z.boolean()};
const MaterialOut = z.object({
  id: z.string(), kind: z.string(), label: z.string().nullable(), required: z.boolean(), status: z.string(), position: z.number().int(),
  reference: z.object({type: z.string(), id: z.string(), title: z.string().nullable(), available: z.boolean()}).strict().nullable(),
  note: z.object(NoteRefOut).strict().nullable(),
  /** Confirmed versions, newest first; each keeps pointing at the immutable revision that was reviewed. */
  reviews: z.array(z.object({id: z.string(), note_id: z.string(), note_version: Version, reviewed_at: Stamp}).strict()),
  /** Source Notes with the version used; `updated` when the Note has a newer version since. */
  sources: z.array(z.object({id: z.string(), ...NoteRefOut, note_version: Version, updated: z.boolean()}).strict()),
  /** Drafts generated from this material, newest first (at most five); text is read with material.get_generation. */
  generations: z.array(GenerationRowOut),
}).strict();
const NoteRevisionOut = z.object({
  note_id: z.string(), title: z.string().nullable(), current_version: Version, version: Version, content_hash: z.string(), created_at: Stamp,
  text: z.string().nullable(), truncated: z.boolean(),
}).strict();
const ApplicationRow = z.object({
  id: z.string(), track: z.string(), institution: z.string(), program: z.string(), department: z.string().nullable(), intake: z.string().nullable(),
  /** Funding track: `separate` or `automatic`; null for a program application. */
  submission: z.string().nullable(),
  status: z.string(), result_note: z.string().nullable(), source: SourceOut.nullable(), archived: z.boolean(), revision: z.number().int(), updated_at: Stamp,
  next_deadline: z.object({kind: z.string(), label: z.string().nullable(), due_on: Day}).strict().nullable(),
  deadlines: z.number().int(), materials: z.object({done: z.number().int(), total: z.number().int()}).strict(),
  /** A program application's funding records (ids). */
  funding_ids: z.array(z.string()),
  /** A funding record's program applications (ids); empty for funding not tied to one yet. */
  applies_to: z.array(z.string()),
}).strict();
const ContactOut = z.object({
  /** Every application (any track) the contact is involved in; empty for a Project-level contact. */
  id: z.string(), application_ids: z.array(z.string()), name: z.string(), role: z.string(), email: z.string().nullable(), affiliation: z.string().nullable(), note: z.string().nullable(),
  events: z.number().int(), last_event: z.object({occurred_on: Day, channel: z.string(), direction: z.string(), response: z.string(), next_step: z.string().nullable()}).strict().nullable(),
}).strict();
const EventOut = z.object({id: z.string(), occurred_on: Day, channel: z.string(), direction: z.string(), summary: z.string(), response: z.string(), next_step: z.string().nullable(), created_at: Stamp}).strict();
const Ref = (key: string) => z.object({[key]: z.string()}).strict();
const LibraryUseOut = z.object({
  material_id: z.string(), application_id: z.string(), track: z.string(), institution: z.string(), program: z.string(), archived: z.boolean(),
  material_kind: z.string(), material_label: z.string().nullable(),
  /** `source`: the material pins this Note at `note_version`; `linked`: the material's own text is this Note, `note_version` its newest reviewed version (null when none). */
  relation: z.enum(['source', 'linked']), note_version: Version.nullable(),
  /** The Note has a newer version than pinned (source) or than the newest review (linked). */
  updated: z.boolean(),
}).strict();
const LibraryItemOut = z.object({
  id: z.string(), kind: z.string(), label: z.string().nullable(), created_at: Stamp, note: z.object(NoteRefOut).strict(),
  uses: z.array(LibraryUseOut),
}).strict();
const FundingLinkInput = z.object({...project, funding_id: id, application_id: id}).strict();
const ContactLinks = z.array(id).max(CONTACT_LINKS_MAX);

export const inputs = {
  'application.list': z.object({...project, include_archived: z.boolean().optional(), track: z.enum(APPLICATION_TRACKS).optional()}).strict(),
  'application.get': z.object({...project, application_id: id}).strict(),
  'application.summary': z.object({...project}).strict(),
  'application.create': z.object({
    ...project, track: z.enum(APPLICATION_TRACKS).default('phd'), institution: text(200), program: text(200), department: optionalText(200), intake: optionalText(100), notes: optionalText(4000),
    source: SourceSchema.nullable().optional(), deadlines: z.array(DeadlineInput).max(20).optional(), create_tasks: z.boolean().optional(), checklist: z.enum(['track_default', 'empty']).default('track_default'),
    /** Funding track only (required there): its own submission or considered automatically with the program application. */
    submission: z.enum(FUNDING_SUBMISSIONS).optional(),
    /** Funding track only: active program applications of this Project it applies to. */
    applies_to: z.array(id).max(FUNDING_LINKS_MAX).optional(),
  }).strict(),
  'application.update': z.object({
    ...project, application_id: id, revision: z.number().int().positive(), institution: text(200).optional(), program: text(200).optional(), department: optionalText(200), intake: optionalText(100),
    notes: optionalText(4000), source: SourceSchema.nullable().optional(), archived: z.boolean().optional(),
    /** Funding track only; `automatic` needs an empty checklist. */
    submission: z.enum(FUNDING_SUBMISSIONS).optional(),
  }).strict(),
  'funding.link': FundingLinkInput,
  'funding.unlink': FundingLinkInput,
  'application.update_status': z.object({...project, application_id: id, status: z.enum(PROGRESS_STATUSES), result_note: optionalText(1000)}).strict(),
  'application.propose_status': z.object({...project, application_id: id, status: z.enum(DECISION_STATUSES), result_note: optionalText(1000)}).strict(),
  'deadline.add': z.object({...project, application_id: id, ...DeadlineInput.shape, create_task: z.boolean().optional()}).strict(),
  'deadline.update': z.object({...project, deadline_id: id, kind: z.enum(DEADLINE_KINDS).optional(), label: optionalText(200), due_on: DaySchema.optional()}).strict(),
  'deadline.remove': z.object({...project, deadline_id: id}).strict(),
  'material.add': z.object({...project, application_id: id, kind: z.enum(MATERIAL_KINDS), label: optionalText(200), required: z.boolean().optional()}).strict(),
  'material.update': z.object({...project, material_id: id, label: optionalText(200), required: z.boolean().optional(), status: z.enum(MATERIAL_STATUSES).optional(), reference: ReferenceInput.nullable().optional()}).strict(),
  'material.remove': z.object({...project, material_id: id}).strict(),
  'material.link_note': z.object({...project, material_id: id, note_id: id.nullable()}).strict(),
  'material.add_source': z.object({...project, material_id: id, note_id: id, note_version: Version.optional()}).strict(),
  'material.remove_source': z.object({...project, source_id: id}).strict(),
  /** The Note and version the person saw and confirms; both must still be the material's linked Note. */
  'material.mark_reviewed': z.object({...project, material_id: id, note_id: id, note_version: Version}).strict(),
  'material.read_note': z.object({...project, material_id: id, note_id: id, version: Version.optional()}).strict(),
  'material.generate': z.object({
    ...project, material_id: id, requirements: text(4000), length_words: z.number().int().min(50).max(3000).nullable().optional(), emphasis: optionalText(1000),
    /** Which of the material's pinned sources to use (default: all). */
    source_ids: z.array(id).min(1).max(20).optional(),
    /** Also give the model the linked Note's current version to revise (default: when one is linked). */
    include_linked: z.boolean().optional(),
    model_provider_id: id.nullable().optional(), model: z.string().trim().min(1).max(200).nullable().optional(),
  }).strict(),
  'material.get_generation': z.object({...project, generation_id: id}).strict(),
  'material.apply_generation': z.object({...project, generation_id: id, target: z.enum(['linked', 'new']), title: text(300).optional()}).strict(),
  'library.list': z.object({...project}).strict(),
  'library.add': z.object({...project, note_id: id, kind: z.enum(LIBRARY_KINDS), label: optionalText(200)}).strict(),
  'library.update': z.object({...project, item_id: id, kind: z.enum(LIBRARY_KINDS).optional(), label: optionalText(200)}).strict(),
  'library.remove': z.object({...project, item_id: id}).strict(),
  'contact.list': z.object({...project, application_id: id.optional()}).strict(),
  'contact.list_events': z.object({...project, contact_id: id}).strict(),
  'contact.create': z.object({...project, application_ids: ContactLinks.optional(), name: text(200), role: z.enum(CONTACT_ROLES), email: z.string().trim().max(320).email().nullable().optional(), affiliation: optionalText(200), note: optionalText(2000)}).strict(),
  'contact.update': z.object({...project, contact_id: id, application_ids: ContactLinks.optional(), name: text(200).optional(), role: z.enum(CONTACT_ROLES).optional(), email: z.string().trim().max(320).email().nullable().optional(), affiliation: optionalText(200), note: optionalText(2000)}).strict(),
  'contact.log_event': z.object({...project, contact_id: id, occurred_on: DaySchema, channel: z.enum(CONTACT_CHANNELS), direction: z.enum(CONTACT_DIRECTIONS), summary: text(2000), response: z.enum(CONTACT_RESPONSES), next_step: optionalText(500)}).strict(),
} as const;
export type ApplicationsOperation = keyof typeof inputs;

export const outputs = {
  'application.list': z.object({items: z.array(ApplicationRow)}).strict(),
  'application.get': z.object({
    application: ApplicationRow.extend({notes: z.string().nullable(), created_at: Stamp}).strict(), deadlines: z.array(DeadlineOut), materials: z.array(MaterialOut),
    /** The same funding records the funding page lists, for a program application; empty for funding. */
    funding: z.array(ApplicationRow),
    /** The program applications a funding record applies to; empty for a program application. */
    applies_to: z.array(ApplicationRow),
  }).strict(),
  'application.summary': z.object({
    /** Program applications (track `phd`). */
    total: z.number().int(), open: z.number().int(), by_status: z.record(z.string(), z.number().int()),
    materials: z.object({done: z.number().int(), total: z.number().int()}).strict(),
    /** Funding records (track `funding`), not archived. */
    funding: z.object({total: z.number().int(), open: z.number().int()}).strict(),
    upcoming: z.array(z.object({application_id: z.string(), track: z.string(), institution: z.string(), program: z.string(), kind: z.string(), label: z.string().nullable(), due_on: Day}).strict()),
  }).strict(),
  'application.create': z.object({application_id: z.string(), revision: z.number().int(), task_ids: z.array(z.string())}).strict(),
  'application.update': z.object({application_id: z.string(), revision: z.number().int()}).strict(),
  'application.update_status': z.object({application_id: z.string(), status: z.string(), revision: z.number().int()}).strict(),
  'application.propose_status': z.object({application_id: z.string(), status: z.string(), revision: z.number().int()}).strict(),
  'funding.link': z.object({funding_id: z.string(), application_id: z.string()}).strict(),
  'funding.unlink': z.object({funding_id: z.string(), application_id: z.string()}).strict(),
  'deadline.add': z.object({deadline_id: z.string(), task_id: z.string().nullable()}).strict(),
  'deadline.update': Ref('deadline_id'),
  'deadline.remove': Ref('deadline_id'),
  'material.add': Ref('material_id'),
  'material.update': Ref('material_id'),
  'material.remove': Ref('material_id'),
  'material.link_note': z.object({material_id: z.string(), note_id: z.string().nullable(), current_version: Version.nullable()}).strict(),
  'material.add_source': z.object({source_id: z.string(), note_id: z.string(), note_version: Version}).strict(),
  'material.remove_source': Ref('source_id'),
  'material.mark_reviewed': z.object({review_id: z.string(), note_id: z.string(), note_version: Version}).strict(),
  'material.read_note': NoteRevisionOut,
  'material.generate': z.object({generation_id: z.string(), run_id: z.string()}).strict(),
  'material.get_generation': z.object({
    generation_id: z.string(), material_id: z.string(), requirements: z.string(), length_words: z.number().int().nullable(), emphasis: z.string().nullable(), created_at: Stamp,
    /** The private Run's status; `succeeded` carries the draft. */
    status: z.string(), error_code: z.string().nullable(), draft: z.string().nullable(),
    /** Statements to check before using the text. */
    verify: z.array(z.string()),
    /** Every pinned input with the version used; `used` when the model reports drawing on it, `updated` when the Note has a newer version since. */
    sources: z.array(z.object({...NoteRefOut, note_version: Version, used: z.boolean(), updated: z.boolean()}).strict()),
    /** The Note the material linked at generation and its version then; `changed` when it has been edited since (applying to it would be refused). */
    base: z.object({...NoteRefOut, note_version: Version, changed: z.boolean()}).strict().nullable(),
    applied: z.object({note_id: z.string(), note_version: Version, applied_at: Stamp}).strict().nullable(),
    /** Whether `target: 'new'` can create a Note here: only where the ordinary creation rule keeps a new private Note in this Space (a Personal Space). */
    save_new: z.boolean(),
  }).strict(),
  'material.apply_generation': z.object({generation_id: z.string(), note_id: z.string(), note_version: Version}).strict(),
  'library.list': z.object({items: z.array(LibraryItemOut)}).strict(),
  'library.add': z.object({item_id: z.string(), note_id: z.string(), current_version: Version}).strict(),
  'library.update': Ref('item_id'),
  'library.remove': Ref('item_id'),
  'contact.list': z.object({items: z.array(ContactOut)}).strict(),
  'contact.list_events': z.object({items: z.array(EventOut)}).strict(),
  'contact.create': Ref('contact_id'),
  'contact.update': Ref('contact_id'),
  'contact.log_event': Ref('event_id'),
} as const;

export const STATUS_PROPOSAL_TYPE = `plugin.${PLUGIN_ID}.application.decide`;
type Spec = {title: string; description: string; kind?: 'query'; proposal?: true; data_class?: 'personal'; person_only?: true};
const specs: Record<ApplicationsOperation, Spec> = {
  'application.list': {kind: 'query', title: 'List applications', description: 'List your program applications (track phd) and funding records (track funding) in this Project with next deadline, checklist progress and funding links; filter by track'},
  'application.get': {kind: 'query', title: 'Read an application', description: 'Read one program application or funding record with its deadlines, material checklist and linked funding or program applications; referenced core objects are resolved for the readers'},
  'application.summary': {kind: 'query', title: 'Summarize applications', description: 'Program application counts by status and checklist completion, funding counts and the next upcoming deadlines'},
  'application.create': {title: 'Create an application', description: 'Create a program application (institution, program) or a funding record (track funding: funder as institution, name as program, submission separate or automatic, optional program applications it applies to) with deadlines, source and the track checklist; due dates become Project Tasks only when asked per deadline'},
  'application.update': {title: 'Edit an application', description: 'Edit application or funding facts (and a funding record\'s submission mode) or archive/restore it; requires the current revision'},
  'application.update_status': {title: 'Record application progress', description: 'Record reversible progress or an external result (preparing, interview, offer, rejected, ...)'},
  'application.propose_status': {proposal: true, title: 'Propose an application decision', description: 'Propose a consequential status (submitted, accepted, declined, withdrawn); it takes effect only after the person approves it'},
  'funding.link': {title: 'Link funding to an application', description: 'Record that a funding record applies to a program application of this Project; both must be active'},
  'funding.unlink': {title: 'Unlink funding from an application', description: 'Remove a funding link; neither record is changed'},
  'deadline.add': {title: 'Add a deadline', description: 'Add one of several deadlines; optionally create a Project Task due that day'},
  'deadline.update': {title: 'Edit a deadline', description: 'Change a deadline kind, label or date; a linked Task is not changed'},
  'deadline.remove': {title: 'Remove a deadline', description: 'Remove a deadline; a linked Task stays on the Board'},
  'material.add': {title: 'Add a material item', description: 'Add a required or optional material to the checklist'},
  'material.update': {title: 'Update a material item', description: 'Change a material status or label, or reference an existing Project Artifact or Task'},
  'material.remove': {title: 'Remove a material item', description: 'Remove a checklist item with its review record and source list; referenced core objects and Notes are not changed'},
  'material.link_note': {title: 'Link a material to its Note', description: 'Link the Note that holds this material\'s text (a Note of this Project or a Project-free personal Note you can read), or unlink it with null; recorded reviews are kept'},
  'material.add_source': {title: 'Add a source Note', description: 'Record a Note this material draws on (master CV, experience, supervisor facts), pinned to its current or a given version; adding it again re-pins the version'},
  'material.remove_source': {title: 'Remove a source Note', description: 'Remove a source reference from a material; the Note itself is not changed'},
  'material.mark_reviewed': {person_only: true, title: 'Record a reviewed version', description: 'Record that you reviewed and confirmed a version of the material\'s linked Note; only the person can record it, and earlier reviewed versions are kept'},
  'material.generate': {person_only: true, title: 'Generate a material draft', description: 'Generate a private draft for this material from its pinned source Note versions and your requirements for this application; you preview it before anything is written'},
  'material.get_generation': {kind: 'query', person_only: true, title: 'Preview a material draft', description: 'Read a generated draft with the sources it used and the statements to check'},
  'material.apply_generation': {person_only: true, title: 'Save a material draft to Notes', description: 'Write a previewed draft once as a new version of the material\'s private Note (refused if the Note changed since) or as a new private Note linked to the material'},
  'material.read_note': {kind: 'query', title: 'Read a material Note version', description: 'Read the text of the material\'s linked, reviewed or source Note at its current or a given version, through the Note\'s own access rules'},
  'library.list': {kind: 'query', title: 'List library materials', description: 'List your reusable material Notes (master CV, experience) with their current version and every material that draws on them, with stale pinned versions'},
  'library.add': {title: 'Add a library material', description: 'Register an existing Note you can read (a Note of this Project or a Project-free personal Note) as a reusable material; the Note is not changed'},
  'library.update': {title: 'Edit a library material', description: 'Change a library material\'s kind or label'},
  'library.remove': {title: 'Remove a library material', description: 'Remove a Note from the library; the Note and the materials that pin it are not changed'},
  'contact.list': {kind: 'query', data_class: 'personal', title: 'List contacts', description: 'List supervisors, referees and other contacts with the applications they are involved in and their latest contact event'},
  'contact.list_events': {kind: 'query', data_class: 'personal', title: 'List contact events', description: 'List the recorded contact history with one contact'},
  'contact.create': {data_class: 'personal', title: 'Add a contact', description: 'Add a supervisor, referee or other contact, optionally linked to one or more active applications'},
  'contact.update': {data_class: 'personal', title: 'Edit a contact', description: 'Edit a contact or replace the applications it is linked to'},
  'contact.log_event': {data_class: 'personal', title: 'Log a contact event', description: 'Record a contact that already happened (nothing is sent) with its response and next step'},
};

const manifest: PluginOperationManifest = {
  id: PLUGIN_ID,
  version: '1.0.0',
  hostApi: 1,
  scope: 'space',
  name: 'Application management',
  description: 'Track applications in a Project: program applications grouped by institution, funding, a reusable material library, contacts, deadlines, materials, progress, results and opportunity sources. PhD application is the first track, funding the second.',
  requires: [],
  permissions: {agent: true},
  data_access: 'caller_owned',
  project_binding: 'required',
  entities: [
    {name: 'application'},
    {name: 'funding', exemption: 'Funding records are applications of track funding, read with application.list / get'},
    {name: 'library'},
    {name: 'deadline', exemption: 'Deadlines are read with their application (application.get / summary)'},
    {name: 'material', exemption: 'Material items are read with their application (application.get); a linked Note version through material.read_note'},
    // Third-party contact details and communication history: personal (ADR 0030), so an Agent needs a Space owner's consent to read them and cannot write them.
    {name: 'contact', data_class: 'personal'},
  ],
  migrations: ['0000_application_records', '0001_material_notes', '0002_material_generations', '0003_funding_library_contact_links', '0004_submission_recorded', '0005_narrow_submission_history'],
  core_ports: ['tasks.create', 'references.resolve', 'notes.read', 'notes.draft'],
  proposalTypes: [{id: STATUS_PROPOSAL_TYPE, operation: `plugin.${PLUGIN_ID}.application.propose_status`, payload_schema: inputs['application.propose_status']}],
  web: {entries: [
    {id: 'board', title: 'Applications', icon: 'graduation-cap', placements: ['project.area']},
    {id: 'summary', title: 'Applications', icon: 'graduation-cap', placements: ['project.overview.card']},
  ]},
  operations: (Object.keys(specs) as ApplicationsOperation[]).map(key => {
    const spec = specs[key];
    const query = spec.kind === 'query';
    return {
      id: `plugin.${PLUGIN_ID}.${key}`,
      version: 1,
      title: spec.title,
      description: spec.description,
      kind: query ? 'query' as const : 'command' as const,
      side_effects: query ? 'none' as const : spec.proposal ? 'proposal' as const : 'durable' as const,
      data_class: spec.data_class ?? 'non_sensitive' as const,
      input_schema: inputs[key],
      output_schema: outputs[key],
      gate_class: spec.proposal ? 'direction' as const : null,
      ...(spec.proposal ? {proposal_type: STATUS_PROPOSAL_TYPE} : {}),
      ...(spec.person_only ? {actors: ['user'] as ['user']} : {}),
    };
  }),
};
export default manifest;
