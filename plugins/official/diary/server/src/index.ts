import {readFileSync} from 'node:fs';
import {PluginOperationRefusal, type PluginBackgroundContext, type PluginOperationContext, type PluginOperationExecutor, type PluginOperationId, type Queryable, type RainverPlugin} from '@rainver/protocol';
import manifest, {APPEND_PROPOSAL_TYPE, ENTRY_TEXT_MAX, PLUGIN_ID, REFLECTION_JOB, ReflectionJobPayload, inputs, type DiaryEntryOut, type DiaryOperation, type DiaryReflectionOut} from '../../operationManifest.js';

/**
 * Server runtime of the Diary package.
 *
 * Ownership (caller_owned, user-level): every statement filters the host GUC
 * `rainver.user_id`, the person the call acts for. The Diary is one person's
 * across all their Spaces, so no statement filters by Space, and no statement
 * reads another person's rows. Core objects are not reached at all.
 */
type In<K extends DiaryOperation> = (typeof inputs)[K]['_output'];
const OWN = `user_id=current_setting('rainver.user_id')`;
const ENTRY = `id,user_id,to_char(entry_date,'YYYY-MM-DD') AS entry_date,content,created_at,updated_at`;
const REFLECTION = `id,entry_id,to_char(reflection_date,'YYYY-MM-DD') AS reflection_date,content,ai_model,created_at`;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
type EntryRow = Omit<DiaryEntryOut, 'created_at' | 'updated_at'> & {created_at: Date; updated_at: Date};
type ReflectionRow = Omit<DiaryReflectionOut, 'created_at'> & {created_at: Date};
const entryOut = (r: EntryRow): DiaryEntryOut => ({id: r.id, user_id: r.user_id, entry_date: r.entry_date, content: r.content, created_at: iso(r.created_at), updated_at: iso(r.updated_at)});
const reflectionOut = (r: ReflectionRow): DiaryReflectionOut => ({id: r.id, entry_id: r.entry_id, reflection_date: r.reflection_date, content: r.content, ai_model: r.ai_model, created_at: iso(r.created_at)});

async function findEntry(db: Queryable, date: string) {
  return (await db.query<EntryRow>(`SELECT ${ENTRY} FROM entries WHERE ${OWN} AND entry_date=$1::date`, [date])).rows[0];
}
/** Entries on the same month and day in earlier years, newest first. */
async function onThisDay(db: Queryable, date: string) {
  return (await db.query<EntryRow>(`SELECT ${ENTRY} FROM entries WHERE ${OWN}
    AND extract(month from entry_date)=extract(month from $1::date) AND extract(day from entry_date)=extract(day from $1::date)
    AND entry_date<$1::date ORDER BY entry_date DESC`, [date])).rows;
}

const handlers: {[K in DiaryOperation]: (input: In<K>, ctx: PluginOperationContext) => Promise<unknown>} = {
  'entry.get': async ({date}, {db}) => {
    const row = await findEntry(db, date);
    return {date, entry: row ? entryOut(row) : null};
  },
  'entry.list': async ({limit, before}, {db}) => ({
    entries: (await db.query<EntryRow>(`SELECT ${ENTRY} FROM entries WHERE ${OWN} AND ($1::date IS NULL OR entry_date<$1::date) ORDER BY entry_date DESC LIMIT $2`, [before ?? null, limit ?? 30])).rows.map(entryOut),
  }),
  'entry.on_this_day': async ({date}, {db}) => ({date, entries: (await onThisDay(db, date)).map(entryOut)}),
  'entry.save': async ({date, content}, {db, jobs, settings}) => {
    const row = (await db.query<EntryRow>(`INSERT INTO entries(user_id,entry_date,content) VALUES (current_setting('rainver.user_id'),$1::date,$2)
      ON CONFLICT (user_id,entry_date) DO UPDATE SET content=EXCLUDED.content,updated_at=now() RETURNING ${ENTRY}`, [date, content])).rows[0]!;
    // The reflection is queued in the same transaction as the text it reflects on.
    if (settings?.ai_reflection_enabled === true) await jobs!.enqueue(REFLECTION_JOB, {entry_id: row.id, entry_date: date});
    return {entry: entryOut(row)};
  },
  'entry.delete': async ({date}, {db}) => ({deleted: ((await db.query(`DELETE FROM entries WHERE ${OWN} AND entry_date=$1::date`, [date])).rowCount ?? 0) > 0}),
  /**
   * Runs only as the canonical applier of an approved append Proposal. The text
   * goes after what is there (a new entry when the day has none); existing text
   * is never changed.
   */
  'entry.propose_append': async ({date, text}, {db}) => {
    const current = (await db.query<{content: string}>(`SELECT content FROM entries WHERE ${OWN} AND entry_date=$1::date FOR UPDATE`, [date])).rows[0]?.content ?? '';
    const next = current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text;
    if (next.length > ENTRY_TEXT_MAX) throw new PluginOperationRefusal('conflict', 'entry_too_long');
    const row = (await db.query<{id: string; entry_date: string}>(`INSERT INTO entries(user_id,entry_date,content) VALUES (current_setting('rainver.user_id'),$1::date,$2)
      ON CONFLICT (user_id,entry_date) DO UPDATE SET content=EXCLUDED.content,updated_at=now() RETURNING id,to_char(entry_date,'YYYY-MM-DD') AS entry_date`, [date, next])).rows[0]!;
    return {entry_id: row.id, entry_date: row.entry_date};
  },
  'reflection.list': async ({date}, {db}) => {
    const entry = await findEntry(db, date);
    if (!entry) throw new PluginOperationRefusal('invalid', 'entry_not_found');
    return {entry_date: date, reflections: (await db.query<ReflectionRow>(`SELECT ${REFLECTION} FROM reflections WHERE ${OWN} AND entry_id=$1 ORDER BY created_at DESC`, [entry.id])).rows.map(reflectionOut)};
  },
};

/**
 * The same-day reflection. It lists earlier years' entries of the same day; it
 * is a deterministic summary (`ai_model: 'stub'`), not a model call. It runs
 * for the entry's owner only and only while that person keeps it enabled.
 */
async function reflect(raw: unknown, {db, settings}: PluginBackgroundContext): Promise<Record<string, unknown>> {
  const {entry_id, entry_date} = ReflectionJobPayload.parse(raw);
  if (settings?.ai_reflection_enabled !== true) return {skipped: true, reason: 'reflection_disabled'};
  const entry = (await db.query<{id: string}>(`SELECT id FROM entries WHERE ${OWN} AND id=$1 AND entry_date=$2::date`, [entry_id, entry_date])).rows[0];
  if (!entry) return {skipped: true, reason: 'entry_not_found'};
  const past = await onThisDay(db, entry_date);
  if (past.length === 0) return {skipped: true, reason: 'no_past_entries'};
  const lines = [`On this day across ${past.length} previous year(s):`, '', ...past.map(e => `**${e.entry_date}**: ${e.content.slice(0, 200)}${e.content.length > 200 ? '...' : ''}`)];
  await db.query(`INSERT INTO reflections(user_id,entry_id,reflection_date,content,ai_model) VALUES (current_setting('rainver.user_id'),$1,current_date,$2,'stub')
    ON CONFLICT (entry_id,reflection_date) DO UPDATE SET content=EXCLUDED.content,ai_model=EXCLUDED.ai_model`, [entry_id, lines.join('\n')]);
  return {entry_id, past_entries_count: past.length};
}

/** Parses with the declared schema before the handler, for actions and the proposal applier alike. */
const executor = (key: DiaryOperation): PluginOperationExecutor => (raw, ctx) => (handlers[key] as (input: unknown, ctx: PluginOperationContext) => Promise<unknown>)(inputs[key].parse(raw), ctx);

export function createDiaryPlugin(): RainverPlugin {
  return {
    id: PLUGIN_ID,
    version: manifest.version,
    operationManifest: manifest,
    migrations: (manifest.migrations ?? []).map(id => ({id, sql: readFileSync(new URL(`../../migrations/${id}.sql`, import.meta.url), 'utf8')})),
    activate(ctx) {
      for (const key of Object.keys(handlers) as DiaryOperation[]) ctx.actions!.register(`plugin.${PLUGIN_ID}.${key}` as PluginOperationId, executor(key));
      ctx.lifecycle!.proposals.register(APPEND_PROPOSAL_TYPE, executor('entry.propose_append'));
      ctx.lifecycle!.jobs.register(REFLECTION_JOB, reflect, {disposeRegistration: 'handler'});
      return {activated: true};
    },
  };
}

export const diaryPlugin = createDiaryPlugin();
export default diaryPlugin;
