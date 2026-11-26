import {sql} from 'drizzle-orm';
import {boolean, check, date, foreignKey, index, integer, pgSchema, primaryKey, text, timestamp, unique} from 'drizzle-orm/pg-core';

/**
 * Plugin-owned tables of the PhD Application package (schema
 * `plugin_phd_application`). Every row is keyed by Space, owning person and the
 * host-authorized Project. Child records retain the parent's storage owner.
 * Funding and contact links can point to an application owned by a different
 * member of the same Project. Core objects (Projects, Tasks, Artifacts) are
 * referenced by id only: the plugin role cannot reference core tables, and
 * disabling or unbinding the package never deletes either side.
 */
const schema = pgSchema('plugin_phd_application');
const owner = {
  spaceId: text('space_id').notNull(),
  userId: text('user_id').notNull(),
  projectId: text('project_id').notNull(),
};
const stamps = {
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
};

export const applications = schema.table('applications', {
  ...owner,
  id: text('id').notNull(),
  track: text('track').notNull(),
  institution: text('institution').notNull(),
  program: text('program').notNull(),
  department: text('department'),
  intake: text('intake'),
  status: text('status').notNull(),
  /** Funding track only: `separate` (own submission) or `automatic` (considered with the program application); null for a program application. */
  submission: text('submission'),
  /**
   * First applied submission timestamp for new decisions. Legacy backfills use the last
   * known update as a guard timestamp, including cases where submission is inferred.
   */
  submissionRecordedAt: timestamp('submission_recorded_at', {withTimezone: true}),
  resultNote: text('result_note'),
  notes: text('notes'),
  sourceLabel: text('source_label'),
  sourceUrl: text('source_url'),
  revision: integer('revision').notNull().default(1),
  archivedAt: timestamp('archived_at', {withTimezone: true}),
  projectShared: boolean('project_shared').notNull().default(false),
  /**
   * When the current status became true: the person's change (now) or, for a Gmail application
   * update, the message's receipt time. An older message never changes a newer status (ADR 0034).
   * A new record's initial status is no observed fact and carries the epoch.
   */
  statusChangedAt: timestamp('status_changed_at', {withTimezone: true}).notNull().defaultNow(),
  ...stamps,
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  unique('applications_project_id_key').on(t.spaceId, t.projectId, t.id),
  check('applications_submitted_not_automatic', sql`${t.submissionRecordedAt} IS NULL OR ${t.submission} IS DISTINCT FROM 'automatic'`),
]);

/**
 * A funding record (track `funding`) applying to a program application (track
 * `phd`) of the same Project. One funding record may apply to several
 * program applications and one application may have several funding records; the
 * funding page and the application detail read the same rows. Removing a link never
 * changes either record.
 */
export const fundingLinks = schema.table('application_funding_links', {
  ...owner,
  fundingId: text('funding_id').notNull(),
  applicationId: text('application_id').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.fundingId, t.applicationId]}),
  foreignKey({name: 'application_funding_links_funding_fk', columns: [t.spaceId, t.userId, t.projectId, t.fundingId], foreignColumns: [applications.spaceId, applications.userId, applications.projectId, applications.id]}).onDelete('cascade'),
  foreignKey({name: 'application_funding_links_program_fk', columns: [t.spaceId, t.projectId, t.applicationId], foreignColumns: [applications.spaceId, applications.projectId, applications.id]}).onDelete('cascade'),
  index('application_funding_links_program_idx').on(t.spaceId, t.projectId, t.applicationId),
]);

export const deadlines = schema.table('application_deadlines', {
  ...owner,
  id: text('id').notNull(),
  applicationId: text('application_id').notNull(),
  kind: text('kind').notNull(),
  label: text('label'),
  dueOn: date('due_on').notNull(),
  taskId: text('task_id'),
  /** When the date (or kind) was last set: the person's edit (now) or the receipt time of the Gmail message that set it. */
  dateChangedAt: timestamp('date_changed_at', {withTimezone: true}).notNull().defaultNow(),
  ...stamps,
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  foreignKey({name: 'application_deadlines_application_fk', columns: [t.spaceId, t.userId, t.projectId, t.applicationId], foreignColumns: [applications.spaceId, applications.userId, applications.projectId, applications.id]}).onDelete('cascade'),
  index('application_deadlines_application_idx').on(t.spaceId, t.userId, t.projectId, t.applicationId),
]);

export const materials = schema.table('application_materials', {
  ...owner,
  id: text('id').notNull(),
  applicationId: text('application_id').notNull(),
  kind: text('kind').notNull(),
  label: text('label'),
  required: boolean('required').notNull().default(true),
  status: text('status').notNull(),
  position: integer('position').notNull(),
  refType: text('ref_type'),
  refId: text('ref_id'),
  /** The Note holding this material's text (a core Note id; Notes keeps its body and history). */
  noteId: text('note_id'),
  ...stamps,
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  foreignKey({name: 'application_materials_application_fk', columns: [t.spaceId, t.userId, t.projectId, t.applicationId], foreignColumns: [applications.spaceId, applications.userId, applications.projectId, applications.id]}).onDelete('cascade'),
  index('application_materials_application_idx').on(t.spaceId, t.userId, t.projectId, t.applicationId),
]);

/**
 * Append-only record of the Note versions the person confirmed for a material.
 * A Note revision is immutable, so a pinned (note, version) keeps pointing at
 * exactly the text that was reviewed after later edits, regenerations or a
 * relink of the material to another Note.
 */
export const materialReviews = schema.table('application_material_reviews', {
  ...owner,
  id: text('id').notNull(),
  materialId: text('material_id').notNull(),
  noteId: text('note_id').notNull(),
  noteVersion: integer('note_version').notNull(),
  reviewedAt: timestamp('reviewed_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  foreignKey({name: 'application_material_reviews_material_fk', columns: [t.spaceId, t.userId, t.projectId, t.materialId], foreignColumns: [materials.spaceId, materials.userId, materials.projectId, materials.id]}).onDelete('cascade'),
  index('application_material_reviews_material_idx').on(t.spaceId, t.userId, t.projectId, t.materialId),
]);

/** Source Notes (master CV, experience notes, supervisor facts) a material draws on, each pinned to the version used. */
export const materialSources = schema.table('application_material_sources', {
  ...owner,
  id: text('id').notNull(),
  materialId: text('material_id').notNull(),
  noteId: text('note_id').notNull(),
  noteVersion: integer('note_version').notNull(),
  ...stamps,
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  foreignKey({name: 'application_material_sources_material_fk', columns: [t.spaceId, t.userId, t.projectId, t.materialId], foreignColumns: [materials.spaceId, materials.userId, materials.projectId, materials.id]}).onDelete('cascade'),
  unique('application_material_sources_note_key').on(t.spaceId, t.userId, t.projectId, t.materialId, t.noteId),
]);

/**
 * A generated draft the person started from a material: their requirements for this
 * application, the Note the material linked then (and its version, which a later apply
 * must still find), and the private host Run that holds the draft. The draft text and
 * its pinned input revisions live on that Run (`notes.draft`), never here. `applied_*`
 * records the one Note version the draft was written to.
 */
export const materialGenerations = schema.table('application_material_generations', {
  ...owner,
  id: text('id').notNull(),
  materialId: text('material_id').notNull(),
  runId: text('run_id').notNull(),
  /** Legacy rows use the material's storage owner as the requester. */
  requestedByUserId: text('requested_by_user_id'),
  requirements: text('requirements').notNull(),
  lengthWords: integer('length_words'),
  emphasis: text('emphasis'),
  baseNoteId: text('base_note_id'),
  baseVersion: integer('base_version'),
  appliedNoteId: text('applied_note_id'),
  appliedVersion: integer('applied_version'),
  appliedAt: timestamp('applied_at', {withTimezone: true}),
  ...stamps,
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  foreignKey({name: 'application_material_generations_material_fk', columns: [t.spaceId, t.userId, t.projectId, t.materialId], foreignColumns: [materials.spaceId, materials.userId, materials.projectId, materials.id]}).onDelete('cascade'),
  index('application_material_generations_material_idx').on(t.spaceId, t.userId, t.projectId, t.materialId),
  unique('application_material_generations_run_key').on(t.spaceId, t.runId),
]);

/**
 * The person's reusable material Notes (master CV, experience notes) in this Project:
 * a Note id with a kind and label. The Note keeps its text, history and access rules;
 * an application's tailored material pins a version of it as a source.
 */
export const libraryItems = schema.table('application_library_items', {
  ...owner,
  id: text('id').notNull(),
  noteId: text('note_id').notNull(),
  kind: text('kind').notNull(),
  label: text('label'),
  projectShared: boolean('project_shared').notNull().default(false),
  ...stamps,
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  unique('application_library_items_note_key').on(t.spaceId, t.userId, t.projectId, t.noteId),
]);

export const contacts = schema.table('application_contacts', {
  ...owner,
  id: text('id').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  email: text('email'),
  affiliation: text('affiliation'),
  note: text('note'),
  projectShared: boolean('project_shared').notNull().default(false),
  ...stamps,
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  index('application_contacts_owner_idx').on(t.spaceId, t.userId, t.projectId),
]);

/** The applications (any track) a contact is involved in; none is a Project-level contact. */
export const contactLinks = schema.table('application_contact_links', {
  ...owner,
  contactId: text('contact_id').notNull(),
  applicationId: text('application_id').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.contactId, t.applicationId]}),
  foreignKey({name: 'application_contact_links_contact_fk', columns: [t.spaceId, t.userId, t.projectId, t.contactId], foreignColumns: [contacts.spaceId, contacts.userId, contacts.projectId, contacts.id]}).onDelete('cascade'),
  foreignKey({name: 'application_contact_links_program_fk', columns: [t.spaceId, t.projectId, t.applicationId], foreignColumns: [applications.spaceId, applications.projectId, applications.id]}).onDelete('cascade'),
  index('application_contact_links_project_application_idx').on(t.spaceId, t.projectId, t.applicationId),
]);

export const contactEvents = schema.table('application_contact_events', {
  ...owner,
  id: text('id').notNull(),
  contactId: text('contact_id').notNull(),
  occurredOn: date('occurred_on').notNull(),
  channel: text('channel').notNull(),
  direction: text('direction').notNull(),
  summary: text('summary').notNull(),
  response: text('response').notNull(),
  nextStep: text('next_step'),
  ...stamps,
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  foreignKey({name: 'application_contact_events_contact_fk', columns: [t.spaceId, t.userId, t.projectId, t.contactId], foreignColumns: [contacts.spaceId, contacts.userId, contacts.projectId, contacts.id]}).onDelete('cascade'),
  index('application_contact_events_contact_idx').on(t.spaceId, t.userId, t.projectId, t.contactId),
]);

/**
 * What a Gmail application update did (ADR 0034): one row per message, effect and application,
 * keyed by the mailbox owner. A message processed again (a retry, an overlapping read) returns
 * its first outcome instead of writing twice. Ids, values and fixed codes only; never mail text.
 */
export const mailFacts = schema.table('application_mail_facts', {
  ...owner,
  id: text('id').notNull(),
  applicationId: text('application_id').notNull(),
  sourceMessageId: text('source_message_id').notNull(),
  sourceReceivedAt: timestamp('source_received_at', {withTimezone: true}).notNull(),
  /** `status`, `submission` or `deadline:<kind>`: one outcome per message for each. */
  effectKey: text('effect_key').notNull(),
  effect: text('effect').notNull(),
  outcome: text('outcome').notNull(),
  reason: text('reason'),
  beforeValue: text('before_value'),
  afterValue: text('after_value'),
  deadlineId: text('deadline_id'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [
  primaryKey({columns: [t.spaceId, t.userId, t.projectId, t.id]}),
  unique('application_mail_facts_source_key').on(t.spaceId, t.userId, t.projectId, t.sourceMessageId, t.effectKey, t.applicationId),
  foreignKey({name: 'application_mail_facts_application_fk', columns: [t.spaceId, t.projectId, t.applicationId], foreignColumns: [applications.spaceId, applications.projectId, applications.id]}).onDelete('cascade'),
  index('application_mail_facts_recent_idx').on(t.spaceId, t.userId, t.projectId, t.createdAt),
  check('application_mail_facts_outcome', sql`${t.outcome} IN ('recorded', 'unchanged', 'conflict')`),
  check('application_mail_facts_message_id', sql`${t.sourceMessageId} ~ '^[0-9a-f]{1,64}$'`),
]);
