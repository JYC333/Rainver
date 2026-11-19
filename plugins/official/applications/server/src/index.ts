import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PluginOperationRefusal, type PluginOperationContext, type PluginOperationExecutor, type PluginOperationId, type PluginProposalOptions, type Queryable, type RainverPlugin} from '@rainver/protocol';
import manifest, {inputs, PLUGIN_ID, STATUS_PROPOSAL_TYPE, type ApplicationsOperation} from '../../operationManifest.js';
import {CLOSED_STATUSES, DECISION_STATUSES, FUNDING_LINKS_MAX, MATERIAL_DONE, TRACK_CONFIG, type ApplicationTrack} from '../../domain.js';

/**
 * Server runtime of the application management package.
 *
 * Ownership (caller_owned): every statement filters the host GUCs
 * `rainver.space_id` and `rainver.user_id` and the Project the host authorized
 * from the input's `project_id`, so a person reads and writes only their own
 * records in a Project they can reach. No statement reads another person's
 * rows; cross-person sharing would need a canonical B11 adapter first.
 * Core objects are reached only through the declared typed ports.
 */
type In<K extends ApplicationsOperation> = (typeof inputs)[K]['_output'];
type Ctx = PluginOperationContext;
const OWN = `space_id=current_setting('rainver.space_id') AND user_id=current_setting('rainver.user_id') AND project_id=$1`;
const refuse = (kind: 'conflict' | 'invalid', reason: string) => new PluginOperationRefusal(kind, reason);
const day = (column: string) => `to_char(${column},'YYYY-MM-DD')`;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
/** Task titles are written in plain English; the person can rename the Task on the Board. */
const DEADLINE_TITLE: Record<string, string> = {
  application: 'Application deadline', funding: 'Funding deadline', references: 'References due', supervisor_contact: 'Contact supervisor',
  interview: 'Interview', decision: 'Decision due', other: 'Deadline',
};

interface ApplicationDbRow {
  id: string; track: string; institution: string; program: string; department: string | null; intake: string | null; submission: string | null; status: string;
  result_note: string | null; notes: string | null; source_label: string | null; source_url: string | null; archived: boolean; revision: number;
  created_at: Date; updated_at: Date; next_deadline: {kind: string; label: string | null; due_on: string} | null; deadlines: number; materials_done: number; materials_total: number;
  funding_ids: string[]; applies_to: string[];
}
const APPLICATION_COLUMNS = `a.id,a.track,a.institution,a.program,a.department,a.intake,a.submission,a.status,a.result_note,a.notes,a.source_label,a.source_url,
  a.archived_at IS NOT NULL AS archived,a.revision,a.created_at,a.updated_at,
  ARRAY(SELECT l.funding_id FROM application_funding_links l WHERE l.space_id=a.space_id AND l.user_id=a.user_id AND l.project_id=a.project_id AND l.application_id=a.id
    ORDER BY l.created_at,l.funding_id) AS funding_ids,
  ARRAY(SELECT l.application_id FROM application_funding_links l WHERE l.space_id=a.space_id AND l.user_id=a.user_id AND l.project_id=a.project_id AND l.funding_id=a.id
    ORDER BY l.created_at,l.application_id) AS applies_to,
  (SELECT json_build_object('kind',d.kind,'label',d.label,'due_on',${day('d.due_on')}) FROM application_deadlines d
    WHERE d.space_id=a.space_id AND d.user_id=a.user_id AND d.project_id=a.project_id AND d.application_id=a.id AND d.due_on>=current_date
    ORDER BY d.due_on,d.created_at,d.id LIMIT 1) AS next_deadline,
  (SELECT count(*)::int FROM application_deadlines d WHERE d.space_id=a.space_id AND d.user_id=a.user_id AND d.project_id=a.project_id AND d.application_id=a.id) AS deadlines,
  (SELECT count(*)::int FROM application_materials m WHERE m.space_id=a.space_id AND m.user_id=a.user_id AND m.project_id=a.project_id AND m.application_id=a.id AND m.status=ANY($2::text[])) AS materials_done,
  (SELECT count(*)::int FROM application_materials m WHERE m.space_id=a.space_id AND m.user_id=a.user_id AND m.project_id=a.project_id AND m.application_id=a.id) AS materials_total`;
/** Source Notes one material may record. */
const MATERIAL_SOURCES_MAX = 20;
const OWN_A = `a.space_id=current_setting('rainver.space_id') AND a.user_id=current_setting('rainver.user_id') AND a.project_id=$1`;

function applicationOut(r: ApplicationDbRow) {
  return {
    id: r.id, track: r.track, institution: r.institution, program: r.program, department: r.department, intake: r.intake, submission: r.submission, status: r.status,
    result_note: r.result_note, source: r.source_label || r.source_url ? {label: r.source_label, url: r.source_url} : null, archived: r.archived,
    revision: r.revision, updated_at: iso(r.updated_at), next_deadline: r.next_deadline, deadlines: r.deadlines,
    materials: {done: r.materials_done, total: r.materials_total}, funding_ids: r.funding_ids, applies_to: r.applies_to,
  };
}
/** Applications first by state, then the next deadline, then name: the order every list uses. */
const listOrder = (r: ApplicationDbRow) => [r.archived ? 1 : 0, CLOSED_STATUSES.includes(r.status as never) ? 1 : 0, r.next_deadline?.due_on ?? '9999-12-31', r.institution.toLowerCase(), r.id].join('\u0000');
const sortRows = (rows: ApplicationDbRow[]) => rows.sort((a, b) => listOrder(a).localeCompare(listOrder(b)));

async function applicationRows(db: Queryable, project: string, where: string, params: unknown[]) {
  return (await db.query<ApplicationDbRow>(`SELECT ${APPLICATION_COLUMNS} FROM applications a WHERE ${OWN_A} ${where}`, [project, MATERIAL_DONE, ...params])).rows;
}

/** The application row for a write, locked; refused when missing or (unless allowed) archived. */
interface GenerationDbRow {
  id: string; material_id: string; run_id: string; requirements: string; length_words: number | null; emphasis: string | null;
  base_note_id: string | null; base_version: number | null; applied_note_id: string | null; applied_version: number | null; applied_at: Date | null; created_at: Date;
}
const appliedOut = (g: GenerationDbRow) => g.applied_note_id && g.applied_version ? {note_id: g.applied_note_id, note_version: g.applied_version, applied_at: iso(g.applied_at)} : null;
/** Plain-English material names for generated Note titles and the drafting request. */
const MATERIAL_TITLE: Record<string, string> = {
  cv: 'CV', statement: 'Statement of purpose', research_proposal: 'Research proposal', transcript: 'Transcript', reference: 'Reference', writing_sample: 'Writing sample', language_test: 'Language test',
};
/**
 * The drafting request the host freezes on the private Run: this application's facts and the
 * person's requirements, never Note text (the host reads the pinned revisions itself).
 */
function draftInstruction(app: {institution: string; program: string}, material: {kind: string; label: string | null}, input: {requirements: string; length_words?: number | null; emphasis?: string | null}, base: {note_id: string; version: number} | null) {
  return [
    `Material: ${material.label ?? MATERIAL_TITLE[material.kind] ?? material.kind} for ${app.program} at ${app.institution}.`,
    `Requirements from the institution or the person:\n${input.requirements}`,
    ...(input.length_words ? [`Target length: about ${input.length_words} words.`] : []),
    ...(input.emphasis ? [`Emphasis: ${input.emphasis}`] : []),
    base ? `Revise the current draft (note ${base.note_id}, version ${base.version}) using the other notes as facts.` : 'Write a new draft from the notes.',
  ].join('\n\n');
}

async function lockApplication(db: Queryable, project: string, applicationId: string, options: {allowArchived?: boolean} = {}) {
  const row = (await db.query<{id: string; track: string; submission: string | null; institution: string; program: string; status: string; revision: number; archived: boolean}>(
    `SELECT id,track,submission,institution,program,status,revision,archived_at IS NOT NULL AS archived FROM applications WHERE ${OWN} AND id=$2 FOR UPDATE`, [project, applicationId])).rows[0];
  if (!row) throw refuse('invalid', 'application_not_found');
  if (row.archived && !options.allowArchived) throw refuse('conflict', 'application_archived');
  return row;
}

/** The parent application of a deadline or material, locked and refused when archived (as for adding one). */
async function lockChildApplication(db: Queryable, table: 'application_deadlines' | 'application_materials', project: string, id: string, missing: string) {
  const row = (await db.query<{application_id: string}>(`SELECT application_id FROM ${table} WHERE ${OWN} AND id=$2`, [project, id])).rows[0];
  if (!row) throw refuse('invalid', missing);
  return lockApplication(db, project, row.application_id);
}

/** Locks applications in id order, the order every multi-application writer uses; `active` ids must not be archived. */
async function lockApplications(db: Queryable, project: string, ids: Iterable<string>, active: ReadonlySet<string>) {
  const locked = new Map<string, Awaited<ReturnType<typeof lockApplication>>>();
  for (const id of [...new Set(ids)].sort()) locked.set(id, await lockApplication(db, project, id, {allowArchived: !active.has(id)}));
  return locked;
}

const contactLinks = async (db: Queryable, project: string, contactId: string) =>
  (await db.query<{application_id: string}>(`SELECT application_id FROM application_contact_links WHERE ${OWN} AND contact_id=$2 ORDER BY application_id`, [project, contactId])).rows.map(r => r.application_id);

/**
 * A contact for a write, locked after the applications it is linked to and (when replacing
 * its links) the target ones, applications first and in id order like every other writer.
 * A newly linked application must be active; a kept archived link is allowed. `links` is
 * the current set and `archived` tells which of them are archived.
 */
async function lockContact(db: Queryable, project: string, contactId: string, target?: readonly string[]) {
  const seen = (await db.query(`SELECT 1 FROM application_contacts WHERE ${OWN} AND id=$2`, [project, contactId])).rows[0];
  if (!seen) throw refuse('invalid', 'contact_not_found');
  const links = await contactLinks(db, project, contactId);
  const added = new Set((target ?? []).filter(id => !links.includes(id)));
  const locked = await lockApplications(db, project, [...links, ...(target ?? [])], added);
  const row = (await db.query(`SELECT 1 FROM application_contacts WHERE ${OWN} AND id=$2 FOR UPDATE`, [project, contactId])).rows[0];
  if (!row) throw refuse('invalid', 'contact_not_found');
  // Relinked by a concurrent writer between the read and the locks: the caller retries on current state.
  if ((await contactLinks(db, project, contactId)).join() !== links.join()) throw refuse('conflict', 'revision_conflict');
  return {links, archived: (id: string) => locked.get(id)?.archived === true};
}
/** A contact whose every application is archived belongs to closed work and is read-only; a Project-level contact never is. */
const contactFrozen = (links: readonly string[], archived: (id: string) => boolean) => links.length > 0 && links.every(archived);

async function insertContactLinks(db: Queryable, project: string, contactId: string, ids: readonly string[]) {
  if (!ids.length) return;
  await db.query(`INSERT INTO application_contact_links(space_id,user_id,project_id,contact_id,application_id)
    SELECT current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`, [project, contactId, [...ids]]);
}

/**
 * The records of a funding link write, locked in id order like every other multi-application
 * writer: the funding record (track `funding`; null while `application.create` is inserting it)
 * and the program applications (never track `funding`). Linking needs every record active;
 * unlinking only the funding record, so funding can be moved off an archived application.
 * `application.create` with `applies_to` and `funding.link` take these locks before the shared
 * capacity check below, so two concurrent writers cannot both pass it on the same application.
 */
async function lockFundingLink(db: Queryable, project: string, fundingId: string | null, applicationIds: readonly string[], link: boolean) {
  const ids = fundingId ? [fundingId, ...applicationIds] : [...applicationIds];
  const locked = await lockApplications(db, project, ids, new Set(link ? ids : fundingId ? [fundingId] : []));
  if (fundingId && locked.get(fundingId)!.track !== 'funding') throw refuse('invalid', 'not_funding');
  if (applicationIds.some(id => locked.get(id)!.track === 'funding')) throw refuse('invalid', 'not_program_application');
  return locked;
}

/**
 * Inserts funding links under the locks of `lockFundingLink` and checks both ends' capacity
 * (FUNDING_LINKS_MAX links per funding record and per program application) on the committed
 * result, then advances each newly linked program application's revision. Returns the ids
 * newly linked (an existing link is kept as it is).
 */
async function insertFundingLinks(db: Queryable, project: string, fundingId: string, applicationIds: readonly string[]) {
  if (!applicationIds.length) return [];
  const added = (await db.query<{application_id: string}>(`INSERT INTO application_funding_links(space_id,user_id,project_id,funding_id,application_id)
    SELECT current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING RETURNING application_id`, [project, fundingId, [...applicationIds]])).rows.map(r => r.application_id);
  if (!added.length) return added;
  const n = (await db.query<{n: number}>(`SELECT greatest((SELECT count(*) FROM application_funding_links WHERE ${OWN} AND funding_id=$2),
    coalesce((SELECT max(c) FROM (SELECT count(*) AS c FROM application_funding_links WHERE ${OWN} AND application_id=ANY($3::text[]) GROUP BY application_id) x),0))::int AS n`, [project, fundingId, added])).rows[0]!.n;
  if (n > FUNDING_LINKS_MAX) throw refuse('conflict', 'link_limit');
  for (const id of added) await touch(db, project, id);
  return added;
}
const LIBRARY_MAX = 200;

/** The business fields of `application.update`, besides its revision and archive state. */
const APPLICATION_DETAIL_FIELDS = ['institution', 'program', 'department', 'intake', 'notes', 'source', 'submission'] as const;

async function touch(db: Queryable, project: string, applicationId: string) {
  return (await db.query<{revision: number}>(`UPDATE applications SET revision=revision+1,updated_at=now() WHERE ${OWN} AND id=$2 RETURNING revision`, [project, applicationId])).rows[0]!.revision;
}

async function insertDeadline(ctx: Ctx, project: string, application: {id: string; institution: string; program: string}, d: {kind: string; label?: string | null; due_on: string}, createTask: boolean) {
  const deadlineId = randomUUID();
  let taskId: string | null = null;
  if (createTask) {
    // A to-do is a core Task on the Project Board (the progress truth); the deadline keeps only its id.
    const task = await ctx.core!.tasks!.create({
      project_id: project, title: `${d.label?.trim() || DEADLINE_TITLE[d.kind] || 'Deadline'} — ${application.institution}, ${application.program}`.slice(0, 300),
      description: 'Created from a deadline in Application management.', due_at: d.due_on,
    });
    taskId = task.task_id;
  }
  await ctx.db.query(`INSERT INTO application_deadlines(space_id,user_id,project_id,id,application_id,kind,label,due_on,task_id)
    VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4,$5,$6::date,$7)`, [project, deadlineId, application.id, d.kind, d.label ?? null, d.due_on, taskId]);
  return {deadline_id: deadlineId, task_id: taskId};
}

async function insertMaterial(db: Queryable, project: string, applicationId: string, m: {kind: string; label?: string | null; required?: boolean}) {
  const materialId = randomUUID();
  await db.query(`INSERT INTO application_materials(space_id,user_id,project_id,id,application_id,kind,label,required,status,position)
    VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4,$5,$6,'todo',
      (SELECT coalesce(max(position),0)+1 FROM application_materials WHERE ${OWN} AND application_id=$3))`, [project, materialId, applicationId, m.kind, m.label ?? null, m.required ?? true]);
  return materialId;
}

/** Applies a patch: `undefined` keeps a column, `null` clears a nullable one. Column names are constants. */
function patchSet(patch: Record<string, unknown>, columns: Record<string, string>, first: number) {
  const sets: string[] = [], values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${column}=$${first + values.length - 1}`);
  }
  return {sets, values};
}

async function setStatus(ctx: Ctx, input: {project_id: string; application_id: string; status: string; result_note?: string | null}) {
  const app = await lockApplication(ctx.db, input.project_id, input.application_id);
  if (input.status === 'submitted' && app.submission === 'automatic') throw refuse('conflict', 'no_submission');
  // A recorded decision is final for direct edits; changing it again is another approved decision.
  if (!DECISION_STATUSES.includes(input.status as typeof DECISION_STATUSES[number]) && ['accepted', 'declined', 'withdrawn'].includes(app.status)) throw refuse('conflict', 'status_decided');
  // An applied `submitted` decision is recorded once and outlives every later status: progress such as
  // `under_review` replaces the status, never this history (see `application.update`).
  const row = (await ctx.db.query<{revision: number}>(`UPDATE applications SET status=$3,result_note=CASE WHEN $4::boolean THEN $5 ELSE result_note END,revision=revision+1,updated_at=now(),
      submission_recorded_at=CASE WHEN $3='submitted' THEN coalesce(submission_recorded_at,now()) ELSE submission_recorded_at END
    WHERE ${OWN} AND id=$2 RETURNING revision`, [input.project_id, input.application_id, input.status, input.result_note !== undefined, input.result_note ?? null])).rows[0]!;
  return {application_id: input.application_id, status: input.status, revision: row.revision};
}

const handlers: {[K in ApplicationsOperation]: (input: In<K>, ctx: Ctx) => Promise<unknown>} = {
  async 'application.list'(input, {db}) {
    const rows = await applicationRows(db, input.project_id, `${input.include_archived ? '' : 'AND a.archived_at IS NULL'} AND ($3::text IS NULL OR a.track=$3)`, [input.track ?? null]);
    return {items: sortRows(rows).map(applicationOut)};
  },
  async 'application.get'(input, {db, core}) {
    const row = (await applicationRows(db, input.project_id, 'AND a.id=$3', [input.application_id]))[0];
    if (!row) throw refuse('invalid', 'application_not_found');
    const deadlines = (await db.query<{id: string; kind: string; label: string | null; due_on: string; task_id: string | null}>(
      `SELECT id,kind,label,${day('due_on')} AS due_on,task_id FROM application_deadlines WHERE ${OWN} AND application_id=$2 ORDER BY due_on,created_at,id`, [input.project_id, input.application_id])).rows;
    const materials = (await db.query<{id: string; kind: string; label: string | null; required: boolean; status: string; position: number; ref_type: string | null; ref_id: string | null; note_id: string | null}>(
      `SELECT id,kind,label,required,status,position,ref_type,ref_id,note_id FROM application_materials WHERE ${OWN} AND application_id=$2 ORDER BY position,id`, [input.project_id, input.application_id])).rows;
    const ids = materials.map(m => m.id);
    const reviews = (await db.query<{id: string; material_id: string; note_id: string; note_version: number; reviewed_at: Date}>(
      `SELECT id,material_id,note_id,note_version,reviewed_at FROM application_material_reviews WHERE ${OWN} AND material_id=ANY($2::text[]) ORDER BY reviewed_at DESC,id DESC`, [input.project_id, ids])).rows;
    const sources = (await db.query<{id: string; material_id: string; note_id: string; note_version: number}>(
      `SELECT id,material_id,note_id,note_version FROM application_material_sources WHERE ${OWN} AND material_id=ANY($2::text[]) ORDER BY created_at,id`, [input.project_id, ids])).rows;
    const generations = (await db.query<GenerationDbRow>(`SELECT * FROM (SELECT g.*,row_number() OVER (PARTITION BY material_id ORDER BY created_at DESC,id DESC) AS n
      FROM application_material_generations g WHERE ${OWN} AND material_id=ANY($2::text[])) x WHERE n<=5 ORDER BY created_at DESC,id DESC`, [input.project_id, ids])).rows;
    // Each Note's title and current version, resolved once for every current reader through the core Notes gate.
    const notes = new Map<string, {title: string | null; current_version: number} | null>();
    const note = async (noteId: string) => {
      if (!notes.has(noteId)) {
        const read = await core!.notes!.read({note_id: noteId});
        notes.set(noteId, read ? {title: read.title, current_version: read.current_version} : null);
      }
      const seen = notes.get(noteId);
      return {note_id: noteId, title: seen?.title ?? null, current_version: seen?.current_version ?? null, available: !!seen};
    };
    const out = [];
    for (const m of materials) {
      let reference = null;
      if (m.ref_type && m.ref_id) {
        // Resolved for every current reader through the core read gate; an unreadable object shows no title.
        const resolved = await core!.references!.resolve({type: m.ref_type as 'artifact' | 'task', id: m.ref_id});
        reference = {type: m.ref_type, id: m.ref_id, title: resolved?.title ?? null, available: !!resolved};
      }
      const materialSources = [];
      for (const source of sources.filter(x => x.material_id === m.id)) {
        const resolved = await note(source.note_id);
        materialSources.push({id: source.id, ...resolved, note_version: source.note_version, updated: resolved.current_version !== null && resolved.current_version > source.note_version});
      }
      out.push({
        id: m.id, kind: m.kind, label: m.label, required: m.required, status: m.status, position: m.position, reference,
        note: m.note_id ? await note(m.note_id) : null,
        reviews: reviews.filter(r => r.material_id === m.id).map(r => ({id: r.id, note_id: r.note_id, note_version: r.note_version, reviewed_at: iso(r.reviewed_at)})),
        sources: materialSources,
        generations: generations.filter(g => g.material_id === m.id).map(g => ({id: g.id, requirements: g.requirements, created_at: iso(g.created_at), applied: appliedOut(g)})),
      });
    }
    // Both sides of the funding links, read as the same records the lists show (archived ones included).
    const linked = async (ids: string[]) => ids.length ? sortRows(await applicationRows(db, input.project_id, 'AND a.id=ANY($3::text[])', [ids])).map(applicationOut) : [];
    return {
      application: {...applicationOut(row), notes: row.notes, created_at: iso(row.created_at)}, deadlines, materials: out,
      funding: await linked(row.funding_ids), applies_to: await linked(row.applies_to),
    };
  },
  async 'application.summary'(input, {db}) {
    const all = await applicationRows(db, input.project_id, 'AND a.archived_at IS NULL', []);
    const rows = all.filter(r => r.track !== 'funding'), funding = all.filter(r => r.track === 'funding');
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const isOpen = (r: ApplicationDbRow) => !CLOSED_STATUSES.includes(r.status as never);
    const open = rows.filter(isOpen);
    const upcoming = (await db.query<{application_id: string; track: string; institution: string; program: string; kind: string; label: string | null; due_on: string}>(
      `SELECT d.application_id,a.track,a.institution,a.program,d.kind,d.label,${day('d.due_on')} AS due_on FROM application_deadlines d
        JOIN applications a ON a.space_id=d.space_id AND a.user_id=d.user_id AND a.project_id=d.project_id AND a.id=d.application_id
        WHERE ${OWN_A} AND a.archived_at IS NULL AND NOT (a.status=ANY($2::text[])) AND d.due_on>=current_date
        ORDER BY d.due_on,a.institution,d.id LIMIT 5`, [input.project_id, CLOSED_STATUSES])).rows;
    return {
      total: rows.length, open: open.length, by_status: byStatus,
      materials: {done: open.reduce((n, r) => n + r.materials_done, 0), total: open.reduce((n, r) => n + r.materials_total, 0)},
      funding: {total: funding.length, open: funding.filter(isOpen).length},
      upcoming,
    };
  },
  async 'application.create'(input, ctx) {
    const funding = input.track === 'funding';
    // A funding record says how it is decided; a program application has no such mode and applies to nothing.
    if (funding && !input.submission) throw refuse('invalid', 'submission_required');
    if (!funding && (input.submission || input.applies_to?.length)) throw refuse('invalid', 'funding_only');
    const targets = [...new Set(input.applies_to ?? [])];
    await lockFundingLink(ctx.db, input.project_id, null, targets, true);
    const applicationId = randomUUID();
    await ctx.db.query(`INSERT INTO applications(space_id,user_id,project_id,id,track,institution,program,department,intake,submission,status,notes,source_label,source_url)
      VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4,$5,$6,$7,$11,'planning',$8,$9,$10)`,
    [input.project_id, applicationId, input.track, input.institution, input.program, input.department ?? null, input.intake ?? null, input.notes ?? null, input.source?.label ?? null, input.source?.url ?? null, funding ? input.submission : null]);
    await insertFundingLinks(ctx.db, input.project_id, applicationId, targets);
    const application = {id: applicationId, institution: input.institution, program: input.program};
    const taskIds: string[] = [];
    for (const d of input.deadlines ?? []) {
      const created = await insertDeadline(ctx, input.project_id, application, d, input.create_tasks ?? false);
      if (created.task_id) taskIds.push(created.task_id);
    }
    // Considered automatically: nothing is submitted, so no checklist.
    if (input.checklist === 'track_default' && input.submission !== 'automatic') for (const m of TRACK_CONFIG[input.track as ApplicationTrack].materials) await insertMaterial(ctx.db, input.project_id, applicationId, m);
    return {application_id: applicationId, revision: 1, task_ids: taskIds};
  },
  async 'application.update'(input, {db}) {
    const current = (await db.query<{revision: number; archived: boolean; track: string; submission: string | null; submitted: boolean}>(`SELECT revision,archived_at IS NOT NULL AS archived,track,submission,submission_recorded_at IS NOT NULL AS submitted FROM applications WHERE ${OWN} AND id=$2 FOR UPDATE`, [input.project_id, input.application_id])).rows[0];
    if (!current) throw refuse('invalid', 'application_not_found');
    if (current.revision !== input.revision) throw refuse('conflict', 'revision_conflict');
    if (input.submission !== undefined && current.track !== 'funding') throw refuse('invalid', 'funding_only');
    // Switching to automatic consideration: a checklist would no longer be submitted, so it must be removed first.
    if (input.submission === 'automatic' && current.submission !== 'automatic') {
      // A confirmed submission or an ambiguous pre-0004 history blocks this switch. This row
      // lock also serializes with approval, and the CHECK constraint enforces the guard in SQL.
      if (current.submitted) throw refuse('conflict', 'submission_recorded');
      const materials = (await db.query<{n: number}>(`SELECT count(*)::int AS n FROM application_materials WHERE ${OWN} AND application_id=$2`, [input.project_id, input.application_id])).rows[0]!.n;
      if (materials) throw refuse('conflict', 'checklist_not_empty');
    }
    // An archived application is read-only: only archive state itself changes (restore first, then edit).
    if (current.archived && APPLICATION_DETAIL_FIELDS.some(field => input[field] !== undefined)) throw refuse('conflict', 'application_archived');
    const source = input.source === undefined ? {} : {source_label: input.source?.label ?? null, source_url: input.source?.url ?? null};
    const {sets, values} = patchSet({...input, ...source}, {institution: 'institution', program: 'program', department: 'department', intake: 'intake', notes: 'notes', source_label: 'source_label', source_url: 'source_url', submission: 'submission'}, 3);
    if (input.archived !== undefined) sets.push(input.archived ? 'archived_at=coalesce(archived_at,now())' : 'archived_at=NULL');
    const row = (await db.query<{revision: number}>(`UPDATE applications SET ${[...sets, 'revision=revision+1', 'updated_at=now()'].join(',')} WHERE ${OWN} AND id=$2 RETURNING revision`,
      [input.project_id, input.application_id, ...values])).rows[0]!;
    return {application_id: input.application_id, revision: row.revision};
  },
  'application.update_status': (input, ctx) => setStatus(ctx, input),
  // Never executed directly: P1 turns a call into a pending Proposal; the applier below runs on approval.
  'application.propose_status': (input, ctx) => setStatus(ctx, input),
  async 'funding.link'(input, {db}) {
    await lockFundingLink(db, input.project_id, input.funding_id, [input.application_id], true);
    if ((await insertFundingLinks(db, input.project_id, input.funding_id, [input.application_id])).length) await touch(db, input.project_id, input.funding_id);
    return {funding_id: input.funding_id, application_id: input.application_id};
  },
  async 'funding.unlink'(input, {db}) {
    await lockFundingLink(db, input.project_id, input.funding_id, [input.application_id], false);
    const row = (await db.query(`DELETE FROM application_funding_links WHERE ${OWN} AND funding_id=$2 AND application_id=$3 RETURNING funding_id`, [input.project_id, input.funding_id, input.application_id])).rows[0];
    if (!row) throw refuse('invalid', 'link_not_found');
    for (const id of [input.funding_id, input.application_id]) await touch(db, input.project_id, id);
    return {funding_id: input.funding_id, application_id: input.application_id};
  },
  async 'deadline.add'(input, ctx) {
    const app = await lockApplication(ctx.db, input.project_id, input.application_id);
    const created = await insertDeadline(ctx, input.project_id, app, input, input.create_task ?? false);
    await touch(ctx.db, input.project_id, app.id);
    return created;
  },
  async 'deadline.update'(input, {db}) {
    await lockChildApplication(db, 'application_deadlines', input.project_id, input.deadline_id, 'deadline_not_found');
    const {sets, values} = patchSet(input, {kind: 'kind', label: 'label', due_on: 'due_on'}, 3);
    const row = (await db.query<{application_id: string}>(`UPDATE application_deadlines SET ${[...sets, 'updated_at=now()'].join(',')} WHERE ${OWN} AND id=$2 RETURNING application_id`,
      [input.project_id, input.deadline_id, ...values])).rows[0];
    if (!row) throw refuse('invalid', 'deadline_not_found');
    await touch(db, input.project_id, row.application_id);
    return {deadline_id: input.deadline_id};
  },
  async 'deadline.remove'(input, {db}) {
    await lockChildApplication(db, 'application_deadlines', input.project_id, input.deadline_id, 'deadline_not_found');
    const row = (await db.query<{application_id: string}>(`DELETE FROM application_deadlines WHERE ${OWN} AND id=$2 RETURNING application_id`, [input.project_id, input.deadline_id])).rows[0];
    if (!row) throw refuse('invalid', 'deadline_not_found');
    await touch(db, input.project_id, row.application_id);
    return {deadline_id: input.deadline_id};
  },
  async 'material.add'(input, {db}) {
    const app = await lockApplication(db, input.project_id, input.application_id);
    if (app.submission === 'automatic') throw refuse('conflict', 'no_submission');
    const materialId = await insertMaterial(db, input.project_id, app.id, input);
    await touch(db, input.project_id, app.id);
    return {material_id: materialId};
  },
  async 'material.update'(input, {db, core}) {
    await lockChildApplication(db, 'application_materials', input.project_id, input.material_id, 'material_not_found');
    // Saved only when the object exists, the caller reads it and it belongs to this Project; reads recheck it later.
    if (input.reference && !(await core!.references!.verify(input.reference))) throw refuse('invalid', 'reference_unavailable');
    const ref = input.reference === undefined ? {} : {ref_type: input.reference?.type ?? null, ref_id: input.reference?.id ?? null};
    const {sets, values} = patchSet({...input, ...ref}, {label: 'label', required: 'required', status: 'status', ref_type: 'ref_type', ref_id: 'ref_id'}, 3);
    const row = (await db.query<{application_id: string}>(`UPDATE application_materials SET ${[...sets, 'updated_at=now()'].join(',')} WHERE ${OWN} AND id=$2 RETURNING application_id`,
      [input.project_id, input.material_id, ...values])).rows[0];
    if (!row) throw refuse('invalid', 'material_not_found');
    await touch(db, input.project_id, row.application_id);
    return {material_id: input.material_id};
  },
  async 'material.remove'(input, {db}) {
    await lockChildApplication(db, 'application_materials', input.project_id, input.material_id, 'material_not_found');
    const row = (await db.query<{application_id: string}>(`DELETE FROM application_materials WHERE ${OWN} AND id=$2 RETURNING application_id`, [input.project_id, input.material_id])).rows[0];
    if (!row) throw refuse('invalid', 'material_not_found');
    await touch(db, input.project_id, row.application_id);
    return {material_id: input.material_id};
  },
  async 'material.link_note'(input, {db, core}) {
    await lockChildApplication(db, 'application_materials', input.project_id, input.material_id, 'material_not_found');
    // Saved only for an active Note the readers read whose Project closure stays in this Project; reads recheck it.
    const verified = input.note_id ? await core!.notes!.verify({note_id: input.note_id}) : null;
    if (input.note_id && !verified) throw refuse('invalid', 'note_unavailable');
    const row = (await db.query<{application_id: string}>(`UPDATE application_materials SET note_id=$3,updated_at=now() WHERE ${OWN} AND id=$2 RETURNING application_id`,
      [input.project_id, input.material_id, input.note_id])).rows[0];
    if (!row) throw refuse('invalid', 'material_not_found');
    await touch(db, input.project_id, row.application_id);
    return {material_id: input.material_id, note_id: input.note_id, current_version: verified?.current_version ?? null};
  },
  async 'material.add_source'(input, {db, core}) {
    await lockChildApplication(db, 'application_materials', input.project_id, input.material_id, 'material_not_found');
    // `version` given: that revision must exist. Absent: the Note's current version is pinned.
    const verified = await core!.notes!.verify({note_id: input.note_id, ...(input.note_version ? {version: input.note_version} : {})});
    if (!verified) throw refuse('invalid', 'note_unavailable');
    const version = input.note_version ?? verified.current_version;
    const count = (await db.query<{n: number; existing: string | null}>(`SELECT count(*)::int AS n,max(id) FILTER (WHERE note_id=$3) AS existing FROM application_material_sources WHERE ${OWN} AND material_id=$2`,
      [input.project_id, input.material_id, input.note_id])).rows[0]!;
    if (!count.existing && count.n >= MATERIAL_SOURCES_MAX) throw refuse('conflict', 'source_limit');
    const sourceId = count.existing ?? randomUUID();
    await db.query(`INSERT INTO application_material_sources(space_id,user_id,project_id,id,material_id,note_id,note_version)
      VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4,$5)
      ON CONFLICT (space_id,user_id,project_id,material_id,note_id) DO UPDATE SET note_version=EXCLUDED.note_version,updated_at=now()`,
    [input.project_id, sourceId, input.material_id, input.note_id, version]);
    const application = (await db.query<{application_id: string}>(`SELECT application_id FROM application_materials WHERE ${OWN} AND id=$2`, [input.project_id, input.material_id])).rows[0]!;
    await touch(db, input.project_id, application.application_id);
    return {source_id: sourceId, note_id: input.note_id, note_version: version};
  },
  async 'material.remove_source'(input, {db}) {
    const seen = (await db.query<{material_id: string}>(`SELECT material_id FROM application_material_sources WHERE ${OWN} AND id=$2`, [input.project_id, input.source_id])).rows[0];
    if (!seen) throw refuse('invalid', 'source_not_found');
    const app = await lockChildApplication(db, 'application_materials', input.project_id, seen.material_id, 'source_not_found');
    const row = (await db.query(`DELETE FROM application_material_sources WHERE ${OWN} AND id=$2 RETURNING id`, [input.project_id, input.source_id])).rows[0];
    if (!row) throw refuse('invalid', 'source_not_found');
    await touch(db, input.project_id, app.id);
    return {source_id: input.source_id};
  },
  async 'material.mark_reviewed'(input, {db, core}) {
    await lockChildApplication(db, 'application_materials', input.project_id, input.material_id, 'material_not_found');
    const material = (await db.query<{application_id: string; note_id: string | null}>(`SELECT application_id,note_id FROM application_materials WHERE ${OWN} AND id=$2 FOR UPDATE`, [input.project_id, input.material_id])).rows[0];
    if (!material) throw refuse('invalid', 'material_not_found');
    if (!material.note_id) throw refuse('conflict', 'note_not_linked');
    // The person confirms the Note and version they saw; a relink since (another tab, another device) is refused, never recorded against the new Note.
    if (material.note_id !== input.note_id) throw refuse('conflict', 'note_relinked');
    if (!await core!.notes!.verify({note_id: material.note_id, version: input.note_version})) throw refuse('invalid', 'note_unavailable');
    // Recording the same version again keeps the first record.
    const existing = (await db.query<{id: string}>(`SELECT id FROM application_material_reviews WHERE ${OWN} AND material_id=$2 AND note_id=$3 AND note_version=$4`,
      [input.project_id, input.material_id, material.note_id, input.note_version])).rows[0];
    const reviewId = existing?.id ?? randomUUID();
    if (!existing) {
      await db.query(`INSERT INTO application_material_reviews(space_id,user_id,project_id,id,material_id,note_id,note_version)
        VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4,$5)`, [input.project_id, reviewId, input.material_id, material.note_id, input.note_version]);
      await touch(db, input.project_id, material.application_id);
    }
    return {review_id: reviewId, note_id: material.note_id, note_version: input.note_version};
  },
  async 'material.read_note'(input, {db, core}) {
    // Only a Note this material links, reviewed or draws on: the package is no general Note reader.
    const linked = (await db.query(`SELECT 1 FROM application_materials m WHERE m.space_id=current_setting('rainver.space_id') AND m.user_id=current_setting('rainver.user_id') AND m.project_id=$1 AND m.id=$2
      AND (m.note_id=$3
        OR EXISTS (SELECT 1 FROM application_material_reviews r WHERE r.space_id=m.space_id AND r.user_id=m.user_id AND r.project_id=m.project_id AND r.material_id=m.id AND r.note_id=$3)
        OR EXISTS (SELECT 1 FROM application_material_sources s WHERE s.space_id=m.space_id AND s.user_id=m.user_id AND s.project_id=m.project_id AND s.material_id=m.id AND s.note_id=$3))`,
    [input.project_id, input.material_id, input.note_id])).rows[0];
    if (!linked) throw refuse('invalid', 'note_not_linked');
    const read = await core!.notes!.read({note_id: input.note_id, ...(input.version ? {version: input.version} : {}), body: true});
    if (!read) throw refuse('invalid', 'note_unavailable');
    return read;
  },
  async 'material.generate'(input, {db, core}) {
    const app = await lockChildApplication(db, 'application_materials', input.project_id, input.material_id, 'material_not_found');
    const material = (await db.query<{kind: string; label: string | null; note_id: string | null}>(`SELECT kind,label,note_id FROM application_materials WHERE ${OWN} AND id=$2 FOR UPDATE`,
      [input.project_id, input.material_id])).rows[0]!;
    const pinned = (await db.query<{id: string; note_id: string; note_version: number}>(`SELECT id,note_id,note_version FROM application_material_sources WHERE ${OWN} AND material_id=$2 ORDER BY created_at,id`,
      [input.project_id, input.material_id])).rows;
    const chosen = input.source_ids ? pinned.filter(p => input.source_ids!.includes(p.id)) : pinned;
    if (input.source_ids && chosen.length !== new Set(input.source_ids).size) throw refuse('invalid', 'source_not_found');
    // The linked Note at its current version, which an apply to it must still find.
    let base: {note_id: string; version: number} | null = null;
    if (material.note_id) {
      const verified = await core!.notes!.verify({note_id: material.note_id});
      if (verified) base = {note_id: material.note_id, version: verified.current_version};
    }
    const includeLinked = input.include_linked ?? !!base;
    if (includeLinked && !base) throw refuse('conflict', material.note_id ? 'note_unavailable' : 'note_not_linked');
    // Revising the linked Note means its current version: a pinned source of the same Note
    // yields to it, so the model is given exactly the version a save to it is checked against.
    const linked = includeLinked ? base : null;
    const inputs = [...chosen.filter(p => p.note_id !== linked?.note_id).map(p => ({note_id: p.note_id, version: p.note_version})), ...(linked ? [linked] : [])];
    if (!inputs.length) throw refuse('invalid', 'no_inputs');
    const instruction = draftInstruction(app, material, input, includeLinked ? base : null);
    const started = await core!.drafts!.start({project_id: input.project_id, inputs, instruction, provider_id: input.model_provider_id ?? null, model: input.model ?? null});
    if (started.outcome !== 'queued') throw refuse('conflict', {busy: 'generation_busy', provider_unavailable: 'provider_unavailable', egress_denied: 'note_egress_denied', unavailable: 'note_unavailable'}[started.outcome]);
    const generationId = randomUUID();
    await db.query(`INSERT INTO application_material_generations(space_id,user_id,project_id,id,material_id,run_id,requirements,length_words,emphasis,base_note_id,base_version)
      VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.project_id, generationId, input.material_id, started.run_id, input.requirements, input.length_words ?? null, input.emphasis ?? null, base?.note_id ?? null, base?.version ?? null]);
    await touch(db, input.project_id, app.id);
    return {generation_id: generationId, run_id: started.run_id};
  },
  async 'material.get_generation'(input, {db, core}) {
    const g = (await db.query<GenerationDbRow>(`SELECT * FROM application_material_generations WHERE ${OWN} AND id=$2`, [input.project_id, input.generation_id])).rows[0];
    if (!g) throw refuse('invalid', 'generation_not_found');
    const draft = await core!.drafts!.read({run_id: g.run_id});
    if (!draft) throw refuse('invalid', 'generation_not_found');
    const current = new Map<string, {title: string | null; current_version: number} | null>();
    const note = async (noteId: string) => {
      if (!current.has(noteId)) {
        const read = await core!.notes!.read({note_id: noteId});
        current.set(noteId, read ? {title: read.title, current_version: read.current_version} : null);
      }
      const seen = current.get(noteId);
      return {note_id: noteId, title: seen?.title ?? null, current_version: seen?.current_version ?? null, available: !!seen};
    };
    const used = new Set(draft.sources_used.map(s => `${s.note_id}@${s.version}`));
    const sources = [];
    for (const ref of draft.inputs) {
      const resolved = await note(ref.note_id);
      sources.push({...resolved, note_version: ref.version, used: used.has(`${ref.note_id}@${ref.version}`), updated: resolved.current_version !== null && resolved.current_version > ref.version});
    }
    let base = null;
    if (g.base_note_id && g.base_version) {
      const resolved = await note(g.base_note_id);
      base = {...resolved, note_version: g.base_version, changed: resolved.current_version !== g.base_version};
    }
    return {
      generation_id: g.id, material_id: g.material_id, requirements: g.requirements, length_words: g.length_words, emphasis: g.emphasis, created_at: iso(g.created_at),
      status: draft.status, error_code: draft.error_code, draft: draft.draft, verify: draft.verify, sources, base, applied: appliedOut(g), save_new: draft.save_new,
    };
  },
  async 'material.apply_generation'(input, {db, core}) {
    const g = (await db.query<GenerationDbRow>(`SELECT * FROM application_material_generations WHERE ${OWN} AND id=$2`, [input.project_id, input.generation_id])).rows[0];
    if (!g) throw refuse('invalid', 'generation_not_found');
    const app = await lockChildApplication(db, 'application_materials', input.project_id, g.material_id, 'generation_not_found');
    const material = (await db.query<{kind: string; label: string | null; note_id: string | null}>(`SELECT kind,label,note_id FROM application_materials WHERE ${OWN} AND id=$2 FOR UPDATE`,
      [input.project_id, g.material_id])).rows[0]!;
    // Written once: a second apply (or a concurrent one, serialized here) is refused.
    const locked = (await db.query<GenerationDbRow>(`SELECT * FROM application_material_generations WHERE ${OWN} AND id=$2 FOR UPDATE`, [input.project_id, g.id])).rows[0]!;
    if (locked.applied_note_id) throw refuse('conflict', 'generation_applied');
    let target: {note_id: string | null; expect_version: number | null};
    if (input.target === 'linked') {
      // Only the Note the material linked when the draft was started, still at that version.
      if (!locked.base_note_id || !locked.base_version || material.note_id !== locked.base_note_id) throw refuse('conflict', 'note_changed');
      target = {note_id: locked.base_note_id, expect_version: locked.base_version};
    } else target = {note_id: null, expect_version: null};
    const title = input.title ?? `${material.label ?? MATERIAL_TITLE[material.kind] ?? 'Material'} — ${app.institution}`;
    const written = await core!.drafts!.apply({run_id: locked.run_id, ...target, title});
    if (written.outcome !== 'written') {
      throw refuse('conflict', {conflict: 'note_changed', not_private: 'note_not_private', not_ready: 'generation_not_ready', unavailable: 'note_unavailable', placement_unavailable: 'note_placement_unavailable'}[written.outcome]);
    }
    await db.query(`UPDATE application_material_generations SET applied_note_id=$3,applied_version=$4,applied_at=now(),updated_at=now() WHERE ${OWN} AND id=$2`,
      [input.project_id, g.id, written.note_id, written.version]);
    if (material.note_id !== written.note_id) await db.query(`UPDATE application_materials SET note_id=$3,updated_at=now() WHERE ${OWN} AND id=$2`, [input.project_id, g.material_id, written.note_id]);
    await touch(db, input.project_id, app.id);
    return {generation_id: g.id, note_id: written.note_id, note_version: written.version};
  },
  async 'library.list'(input, {db, core}) {
    const items = (await db.query<{id: string; note_id: string; kind: string; label: string | null; created_at: Date}>(
      `SELECT id,note_id,kind,label,created_at FROM application_library_items WHERE ${OWN} ORDER BY kind,created_at,id`, [input.project_id])).rows;
    const noteIds = items.map(i => i.note_id);
    // Every material of the person in this Project that draws on (source) or is written in (linked) a library Note.
    const uses = (await db.query<{note_id: string; material_id: string; application_id: string; track: string; institution: string; program: string; archived: boolean;
      material_kind: string; material_label: string | null; relation: 'source' | 'linked'; note_version: number | null}>(
      `SELECT s.note_id,m.id AS material_id,a.id AS application_id,a.track,a.institution,a.program,a.archived_at IS NOT NULL AS archived,m.kind AS material_kind,m.label AS material_label,
          'source' AS relation,s.note_version
        FROM application_material_sources s
        JOIN application_materials m ON m.space_id=s.space_id AND m.user_id=s.user_id AND m.project_id=s.project_id AND m.id=s.material_id
        JOIN applications a ON a.space_id=m.space_id AND a.user_id=m.user_id AND a.project_id=m.project_id AND a.id=m.application_id
        WHERE s.space_id=current_setting('rainver.space_id') AND s.user_id=current_setting('rainver.user_id') AND s.project_id=$1 AND s.note_id=ANY($2::text[])
      UNION ALL
      SELECT m.note_id,m.id,a.id,a.track,a.institution,a.program,a.archived_at IS NOT NULL,m.kind,m.label,'linked',
          (SELECT max(r.note_version) FROM application_material_reviews r WHERE r.space_id=m.space_id AND r.user_id=m.user_id AND r.project_id=m.project_id AND r.material_id=m.id AND r.note_id=m.note_id)
        FROM application_materials m
        JOIN applications a ON a.space_id=m.space_id AND a.user_id=m.user_id AND a.project_id=m.project_id AND a.id=m.application_id
        WHERE m.space_id=current_setting('rainver.space_id') AND m.user_id=current_setting('rainver.user_id') AND m.project_id=$1 AND m.note_id=ANY($2::text[])
      ORDER BY 7,5,6,2`, [input.project_id, noteIds])).rows;
    const out = [];
    for (const item of items) {
      // Title and current version through the core Notes gate for every current reader.
      const read = await core!.notes!.read({note_id: item.note_id});
      const current = read?.current_version ?? null;
      out.push({
        id: item.id, kind: item.kind, label: item.label, created_at: iso(item.created_at),
        note: {note_id: item.note_id, title: read?.title ?? null, current_version: current, available: !!read},
        uses: uses.filter(u => u.note_id === item.note_id).map(({note_id: _note, ...u}) => ({...u, updated: current !== null && (u.note_version === null ? u.relation === 'linked' : current > u.note_version)})),
      });
    }
    return {items: out};
  },
  async 'library.add'(input, {db, core}) {
    // Only an active Note the readers read whose Project closure stays in this Project, as for linking it to a material.
    const verified = await core!.notes!.verify({note_id: input.note_id});
    if (!verified) throw refuse('invalid', 'note_unavailable');
    const count = (await db.query<{n: number; existing: string | null}>(`SELECT count(*)::int AS n,max(id) FILTER (WHERE note_id=$2) AS existing FROM application_library_items WHERE ${OWN}`,
      [input.project_id, input.note_id])).rows[0]!;
    if (count.existing) throw refuse('conflict', 'library_note_exists');
    if (count.n >= LIBRARY_MAX) throw refuse('conflict', 'library_limit');
    const itemId = randomUUID();
    const row = (await db.query(`INSERT INTO application_library_items(space_id,user_id,project_id,id,note_id,kind,label)
      VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [input.project_id, itemId, input.note_id, input.kind, input.label ?? null])).rows[0];
    if (!row) throw refuse('conflict', 'library_note_exists');
    return {item_id: itemId, note_id: input.note_id, current_version: verified.current_version};
  },
  async 'library.update'(input, {db}) {
    const {sets, values} = patchSet(input, {kind: 'kind', label: 'label'}, 3);
    const row = (await db.query(`UPDATE application_library_items SET ${[...sets, 'updated_at=now()'].join(',')} WHERE ${OWN} AND id=$2 RETURNING id`, [input.project_id, input.item_id, ...values])).rows[0];
    if (!row) throw refuse('invalid', 'library_item_not_found');
    return {item_id: input.item_id};
  },
  async 'library.remove'(input, {db}) {
    const row = (await db.query(`DELETE FROM application_library_items WHERE ${OWN} AND id=$2 RETURNING id`, [input.project_id, input.item_id])).rows[0];
    if (!row) throw refuse('invalid', 'library_item_not_found');
    return {item_id: input.item_id};
  },
  async 'contact.list'(input, {db}) {
    const rows = (await db.query<{id: string; application_ids: string[]; name: string; role: string; email: string | null; affiliation: string | null; note: string | null; events: number;
      last_event: {occurred_on: string; channel: string; direction: string; response: string; next_step: string | null} | null}>(
      `SELECT c.id,
        ARRAY(SELECT l.application_id FROM application_contact_links l WHERE l.space_id=c.space_id AND l.user_id=c.user_id AND l.project_id=c.project_id AND l.contact_id=c.id
          ORDER BY l.created_at,l.application_id) AS application_ids,
        c.name,c.role,c.email,c.affiliation,c.note,
        (SELECT count(*)::int FROM application_contact_events e WHERE e.space_id=c.space_id AND e.user_id=c.user_id AND e.project_id=c.project_id AND e.contact_id=c.id) AS events,
        (SELECT json_build_object('occurred_on',${day('e.occurred_on')},'channel',e.channel,'direction',e.direction,'response',e.response,'next_step',e.next_step)
          FROM application_contact_events e WHERE e.space_id=c.space_id AND e.user_id=c.user_id AND e.project_id=c.project_id AND e.contact_id=c.id
          ORDER BY e.occurred_on DESC,e.created_at DESC,e.id DESC LIMIT 1) AS last_event
      FROM application_contacts c WHERE c.space_id=current_setting('rainver.space_id') AND c.user_id=current_setting('rainver.user_id') AND c.project_id=$1
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM application_contact_links l WHERE l.space_id=c.space_id AND l.user_id=c.user_id AND l.project_id=c.project_id AND l.contact_id=c.id AND l.application_id=$2))
      ORDER BY c.name,c.id`, [input.project_id, input.application_id ?? null])).rows;
    return {items: rows};
  },
  async 'contact.list_events'(input, {db}) {
    const contact = (await db.query(`SELECT 1 FROM application_contacts WHERE ${OWN} AND id=$2`, [input.project_id, input.contact_id])).rows[0];
    if (!contact) throw refuse('invalid', 'contact_not_found');
    const rows = (await db.query<{id: string; occurred_on: string; channel: string; direction: string; summary: string; response: string; next_step: string | null; created_at: Date}>(
      `SELECT id,${day('occurred_on')} AS occurred_on,channel,direction,summary,response,next_step,created_at FROM application_contact_events
        WHERE ${OWN} AND contact_id=$2 ORDER BY occurred_on DESC,created_at DESC,id DESC`, [input.project_id, input.contact_id])).rows;
    return {items: rows.map(r => ({...r, created_at: iso(r.created_at)}))};
  },
  async 'contact.create'(input, {db}) {
    // A Project-level contact has no application; each linked application must be active (archived is read-only).
    const targets = [...new Set(input.application_ids ?? [])];
    await lockApplications(db, input.project_id, targets, new Set(targets));
    const contactId = randomUUID();
    await db.query(`INSERT INTO application_contacts(space_id,user_id,project_id,id,name,role,email,affiliation,note)
      VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4,$5,$6,$7)`,
    [input.project_id, contactId, input.name, input.role, input.email ?? null, input.affiliation ?? null, input.note ?? null]);
    await insertContactLinks(db, input.project_id, contactId, targets);
    return {contact_id: contactId};
  },
  async 'contact.update'(input, {db}) {
    // A contact whose every application is archived is read-only, except replacing its links so that
    // it is Project-level or involves an active application; a newly linked application must be active.
    const target = input.application_ids === undefined ? undefined : [...new Set(input.application_ids)];
    const current = await lockContact(db, input.project_id, input.contact_id, target);
    if (contactFrozen(target ?? current.links, current.archived)) throw refuse('conflict', 'application_archived');
    const {sets, values} = patchSet(input, {name: 'name', role: 'role', email: 'email', affiliation: 'affiliation', note: 'note'}, 3);
    const row = (await db.query(`UPDATE application_contacts SET ${[...sets, 'updated_at=now()'].join(',')} WHERE ${OWN} AND id=$2 RETURNING id`, [input.project_id, input.contact_id, ...values])).rows[0];
    if (!row) throw refuse('invalid', 'contact_not_found');
    if (target) {
      await db.query(`DELETE FROM application_contact_links WHERE ${OWN} AND contact_id=$2 AND NOT (application_id=ANY($3::text[]))`, [input.project_id, input.contact_id, target]);
      await insertContactLinks(db, input.project_id, input.contact_id, target);
    }
    return {contact_id: input.contact_id};
  },
  async 'contact.log_event'(input, {db}) {
    const contact = await lockContact(db, input.project_id, input.contact_id);
    if (contactFrozen(contact.links, contact.archived)) throw refuse('conflict', 'application_archived');
    const eventId = randomUUID();
    await db.query(`INSERT INTO application_contact_events(space_id,user_id,project_id,id,contact_id,occurred_on,channel,direction,summary,response,next_step)
      VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2,$3,$4::date,$5,$6,$7,$8,$9)`,
    [input.project_id, eventId, input.contact_id, input.occurred_on, input.channel, input.direction, input.summary, input.response, input.next_step ?? null]);
    await db.query(`UPDATE application_contacts SET updated_at=now() WHERE ${OWN} AND id=$2`, [input.project_id, input.contact_id]);
    return {event_id: eventId};
  },
};

/** The application revision a decision proposal is frozen against (null when the person has no such record). */
const decisionPrecondition: NonNullable<PluginProposalOptions['preconditions']> = async (raw, {db}, phase) => {
  const input = raw as In<'application.propose_status'>;
  const row = (await db.query<{revision: number; submission: string | null}>(`SELECT revision,submission FROM applications WHERE ${OWN} AND id=$2 FOR UPDATE`, [input.project_id, input.application_id])).rows[0];
  // On approval the core compares revisions first. The applier still enforces the mode.
  if (phase === 'propose' && input.status === 'submitted' && row?.submission === 'automatic') throw refuse('conflict', 'no_submission');
  return {application_revision: row?.revision ?? null};
};

/** Parses with the declared schema (defaults applied) before the handler, for actions and the proposal applier alike. */
const executor = (key: ApplicationsOperation): PluginOperationExecutor => (raw, ctx) => (handlers[key] as (input: unknown, ctx: Ctx) => Promise<unknown>)(inputs[key].parse(raw), ctx);

export function createApplicationsPlugin(): RainverPlugin {
  return {
    id: PLUGIN_ID,
    version: manifest.version,
    operationManifest: manifest,
    migrations: (manifest.migrations ?? []).map(id => ({id, sql: readFileSync(new URL(`../../migrations/${id}.sql`, import.meta.url), 'utf8')})),
    activate(ctx) {
      for (const key of Object.keys(handlers) as ApplicationsOperation[]) ctx.actions!.register(`plugin.${PLUGIN_ID}.${key}` as PluginOperationId, executor(key));
      // A decision is approved against the revision it was proposed for: any later change, including
      // another approved decision, supersedes it instead of letting an older proposal overwrite it.
      ctx.lifecycle!.proposals.register(STATUS_PROPOSAL_TYPE, executor('application.propose_status'), {preconditions: decisionPrecondition});
      return {activated: true};
    },
  };
}

export const applicationsPlugin = createApplicationsPlugin();
export default applicationsPlugin;
