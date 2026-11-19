import type { ContentVisibility } from "../access/contentAccessTypes.js";

interface ContextTaintInput {
  ownerUserId: string | null;
  visibility: ContentVisibility;
}

interface RunContextTaintSummary {
  schema_version: 1;
  narrowest_visibility: ContentVisibility;
  input_owner_user_ids: string[];
  non_instructing_owner_user_ids: string[];
  personal_memory_grant_ids: string[];
  /** Personal/sensitive plugin reads (ADR 0030). Merge-only: no writer removes an entry. */
  plugin_reads?: PluginReadTaint[];
}

export interface PluginReadTaint {
  plugin_id: string;
  data_class: "personal" | "sensitive";
  /**
   * Whose data was read: the data owner of a direct read, or the owner an
   * inherited read carried from its source. Never the person instructing a
   * later Run that merely inherited it. `null` means the owner is unknown and
   * is treated as somebody else's. Absent on entries written before the field
   * existed (`sensitiveConversationReads` resolves those conservatively).
   */
  owner_user_id?: string | null;
}

interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

const VISIBILITY_RANK: Record<ContentVisibility, number> = {
  private: 0,
  selected_users: 1,
  space_shared: 2,
};

function narrowestVisibility(
  values: readonly ContentVisibility[],
): ContentVisibility {
  return values.reduce<ContentVisibility>(
    (narrowest, value) => VISIBILITY_RANK[value] < VISIBILITY_RANK[narrowest] ? value : narrowest,
    "space_shared",
  );
}

export function buildRunContextTaintSummary(input: {
  items: readonly ContextTaintInput[];
  instructingUserId: string | null;
  runVisibility: ContentVisibility;
  personalMemoryGrantIds?: readonly string[];
}): RunContextTaintSummary {
  const owners = sortedUnique(input.items.flatMap((item) => item.ownerUserId ? [item.ownerUserId] : []));
  const taintingOwners = sortedUnique(input.items.flatMap((item) =>
    item.visibility !== "space_shared" && item.ownerUserId ? [item.ownerUserId] : []
  ));
  return {
    schema_version: 1,
    narrowest_visibility: narrowestVisibility([
      input.runVisibility,
      ...input.items.map((item) => item.visibility),
    ]),
    input_owner_user_ids: owners,
    non_instructing_owner_user_ids: taintingOwners.filter((owner) => owner !== input.instructingUserId),
    personal_memory_grant_ids: sortedUnique(input.personalMemoryGrantIds ?? []),
  };
}

export function outputVisibilityForTaint(input: {
  requestedVisibility: ContentVisibility;
  runVisibility: ContentVisibility;
  taint: RunContextTaintSummary | null;
}): ContentVisibility {
  if (input.taint?.non_instructing_owner_user_ids.length) return "selected_users";
  return narrowestVisibility([
    input.requestedVisibility,
    input.runVisibility,
    input.taint?.narrowest_visibility ?? "space_shared",
  ]);
}

export function parseRunContextTaint(value: unknown): RunContextTaintSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const visibility = row.narrowest_visibility;
  if (row.schema_version !== 1 || !isVisibility(visibility)) return null;
  return {
    schema_version: 1,
    narrowest_visibility: visibility,
    input_owner_user_ids: stringArray(row.input_owner_user_ids),
    non_instructing_owner_user_ids: stringArray(row.non_instructing_owner_user_ids),
    personal_memory_grant_ids: stringArray(row.personal_memory_grant_ids),
    ...pluginReadsOf(row.plugin_reads),
  };
}

/**
 * The current Run's taint as its protections read it (outward writes, Memory,
 * materialization, and the merge when taint is persisted). `jsonType` is
 * `jsonb_typeof(context_taint_json)`: only SQL NULL — no row, or a Run whose
 * taint was never written — is the legal untainted state. Any other value
 * that does not parse (JSON null, an array, a string, a wrong schema or
 * visibility) is never read as "no taint": it becomes a Project-bound read of
 * unknown owner at the narrowest visibility, the same answer the conversation
 * aggregate gives it (`sensitiveConversationReads` marks it incomplete).
 */
export function protectiveRunContextTaint(value: unknown, jsonType: string | null | undefined): RunContextTaintSummary | null {
  if (jsonType === null || jsonType === undefined) return null;
  return parseRunContextTaint(value) ?? {
    schema_version: 1,
    narrowest_visibility: "private",
    input_owner_user_ids: [],
    non_instructing_owner_user_ids: [],
    personal_memory_grant_ids: [],
    plugin_reads: [{ plugin_id: UNRESOLVED_SENSITIVE_READ.pluginId, data_class: "sensitive", owner_user_id: null }],
  };
}

/** Reads one Run's taint for its protections (`protectiveRunContextTaint`); `forUpdate` locks the Run row. */
export async function readRunContextTaint(
  db: Queryable, spaceId: string, runId: string, options: { forUpdate?: boolean } = {},
): Promise<RunContextTaintSummary | null> {
  const row = (await db.query<{ taint: unknown; taint_type: string | null }>(
    `SELECT context_taint_json AS taint, jsonb_typeof(context_taint_json) AS taint_type
       FROM runs WHERE id=$1 AND space_id=$2${options.forUpdate ? " FOR UPDATE" : ""}`,
    [runId, spaceId],
  )).rows[0];
  return protectiveRunContextTaint(row?.taint, row?.taint_type);
}

/**
 * Malformed read metadata is never read as "no reads": a non-list or an
 * invalid entry counts as a Project-bound read of unknown owner, so outward
 * writes, Memory and materialization stay refused.
 */
function pluginReadsOf(value: unknown): { plugin_reads?: PluginReadTaint[] } {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return {};
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  const reads = entries.map((entry): PluginReadTaint => validPluginReadEntry(entry) ? entry
    : { plugin_id: UNRESOLVED_SENSITIVE_READ.pluginId, data_class: "sensitive", owner_user_id: null });
  return { plugin_reads: mergePluginReads(reads) };
}

/** True once the Run has read sensitive plugin data; the outward-write invariant and Memory inheritance key off it. */
export function hasSensitivePluginRead(taint: RunContextTaintSummary | null): boolean {
  return !!taint?.plugin_reads?.some((read) => read.data_class === "sensitive");
}

/**
 * True once the Run read — or inherited from its conversation — a Project-bound core read (ADR 0033 §6,
 * Gmail; ids from `projectBoundConsentIds`): what it writes must not leave that read's Project.
 */
export function hasProjectBoundRead(taint: RunContextTaintSummary | null, projectBoundIds: readonly string[]): boolean {
  return !!taint?.plugin_reads?.some((read) => read.data_class === "sensitive" && projectBoundIds.includes(read.plugin_id));
}

function mergePluginReads(values: readonly PluginReadTaint[]): PluginReadTaint[] {
  const seen = new Map<string, PluginReadTaint>();
  for (const value of values) {
    if (!value || typeof value.plugin_id !== "string" || (value.data_class !== "personal" && value.data_class !== "sensitive")) continue;
    const owner = value.owner_user_id === undefined ? undefined : typeof value.owner_user_id === "string" ? value.owner_user_id : null;
    seen.set(`${value.plugin_id}\u0000${value.data_class}\u0000${owner === undefined ? "\u0001" : owner ?? ""}`, {
      plugin_id: value.plugin_id, data_class: value.data_class, ...(owner === undefined ? {} : { owner_user_id: owner }),
    });
  }
  return [...seen.values()].sort((a, b) => a.plugin_id.localeCompare(b.plugin_id) || a.data_class.localeCompare(b.data_class)
    || String(a.owner_user_id ?? "").localeCompare(String(b.owner_user_id ?? "")));
}

export async function persistRunContextTaint(
  db: Queryable,
  input: {
    runId: string;
    spaceId: string;
    instructingUserId: string | null;
    runVisibility: ContentVisibility;
    items: readonly ContextTaintInput[];
    personalMemoryGrantIds?: readonly string[];
    pluginReads?: readonly PluginReadTaint[];
  },
): Promise<RunContextTaintSummary> {
  // A malformed stored summary merges as its conservative reading, so rewriting it never drops protection.
  const previous = await readRunContextTaint(db, input.spaceId, input.runId, { forUpdate: true });
  const current = buildRunContextTaintSummary(input);
  const summary: RunContextTaintSummary = {
    schema_version: 1,
    narrowest_visibility: narrowestVisibility([
      current.narrowest_visibility,
      previous?.narrowest_visibility ?? "space_shared",
    ]),
    input_owner_user_ids: sortedUnique([
      ...(previous?.input_owner_user_ids ?? []),
      ...current.input_owner_user_ids,
    ]),
    non_instructing_owner_user_ids: sortedUnique([
      ...(previous?.non_instructing_owner_user_ids ?? []),
      ...current.non_instructing_owner_user_ids,
    ]),
    personal_memory_grant_ids: sortedUnique([
      ...(previous?.personal_memory_grant_ids ?? []),
      ...current.personal_memory_grant_ids,
    ]),
  };
  const pluginReads = mergePluginReads([...(previous?.plugin_reads ?? []), ...(input.pluginReads ?? [])]);
  if (pluginReads.length) summary.plugin_reads = pluginReads;
  const hasTaint = summary.narrowest_visibility !== "space_shared"
    || summary.non_instructing_owner_user_ids.length > 0
    || summary.personal_memory_grant_ids.length > 0
    || pluginReads.length > 0;
  await db.query(
    `UPDATE runs
        SET has_context_taint = $1,
            context_taint_json = $2::jsonb,
            updated_at = $3
      WHERE id = $4 AND space_id = $5`,
    [hasTaint, JSON.stringify(summary), new Date().toISOString(), input.runId, input.spaceId],
  );
  return summary;
}

function isVisibility(value: unknown): value is ContentVisibility {
  return value === "private" || value === "selected_users" || value === "space_shared";
}

function stringArray(value: unknown): string[] {
  return sortedUnique(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** One sensitive read a conversation holds: which source and whose data (`null`: unknown, so somebody else's). */
export interface SensitiveConversationRead { pluginId: string; ownerUserId: string | null }

/**
 * What a conversation holds, and whether that answer is complete. `complete`
 * is false when the reads could not all be determined — more distinct reads
 * than a reference can carry, malformed read metadata, a reference chain
 * longer than the bound, or an old record that cannot be verified. Callers
 * then refuse what they would only allow on a complete answer (copying it on,
 * Memory, sharing), and a new Run inherits an unknown-owner Gmail read so its
 * outward writes stay refused.
 */
export interface SensitiveConversationReads { reads: SensitiveConversationRead[]; complete: boolean }

/** At most this many distinct reads are carried (the provenance bound); one more makes the answer incomplete. */
export const SENSITIVE_READS_LIMIT = 100;
/**
 * Marks a recorded `sensitive_reads` list (a reference's provenance, shared
 * Gmail text) written with every read and its real owner. A list without it
 * predates that and is not taken at its word: a conversation reference is
 * checked against its source, anything else cannot be verified.
 */
export const SENSITIVE_READS_VERSION = 2;
/** Conversations followed through old references before the answer is incomplete. */
const LEGACY_REFERENCE_HOPS_LIMIT = 50;
/** What an incomplete answer is inherited as: a Project-bound read of unknown owner. */
export const UNRESOLVED_SENSITIVE_READ: SensitiveConversationRead = Object.freeze({ pluginId: "core:gmail", ownerUserId: null });

const readKey = (read: SensitiveConversationRead) => `${read.pluginId}\u0000${read.ownerUserId ?? "\u0001"}`;

/**
 * Sensitive reads earlier Runs of this conversation made (merge-only Run taint,
 * ADR 0030). Their results and the replies built on them are in the
 * conversation's history and the CLI's resumed session, so a later Run of the
 * same conversation is treated as having read them too. Whether a read also
 * requires an isolated launch is the caller's separate decision: a
 * Project-bound core read (ADR 0033 §6, Gmail) is inherited as taint but keeps
 * the conversation's own runtime.
 *
 * A Room reference copied out of such a conversation carries its reads in its
 * provenance (`metadata_json.reference.sensitive_reads`, written by
 * `rooms/threadReferences.ts`), and so does the owner's shared Gmail text
 * (`metadata_json.sensitive_reads`, `gmailSummaryShare.ts`), so the
 * conversation it lands in holds that data too and is answered the same way:
 * its later Runs inherit the reads and reflection makes no Memory of it.
 *
 * Owners are kept, never reassigned: a read names whose data it is, and a Run
 * that inherited it records that same owner (`owner_user_id`), not the person
 * instructing it (`runSensitiveReads` for entries written before that field).
 * Every Run and message of the conversation is aggregated, however long it
 * is. Only a recorded list marked `sensitive_reads_version: 2` is taken as
 * written. An older conversation reference (no list, or a list without the
 * mark) is checked against its source conversation, transitively, and every
 * entry its old list names must be found there with the same owner; older
 * shared text cannot be checked, and malformed metadata of any kind is never
 * read as "no reads": each makes the answer incomplete.
 */
export async function sensitiveConversationReads(db: Queryable, spaceId: string, sessionId: string): Promise<SensitiveConversationReads> {
  const state = { complete: true, held: new Map<string, Map<string, SensitiveConversationRead>>() };
  const reads = await collectConversationReads(db, spaceId, sessionId, state);
  if (reads.size > SENSITIVE_READS_LIMIT) state.complete = false;
  return { reads: [...reads.values()].slice(0, SENSITIVE_READS_LIMIT), complete: state.complete };
}

/** One conversation's reads with those of the sources its old references are checked against (memoized; a cycle sees what is collected so far). */
async function collectConversationReads(
  db: Queryable, spaceId: string, sessionId: string,
  state: { complete: boolean; held: Map<string, Map<string, SensitiveConversationRead>> },
): Promise<Map<string, SensitiveConversationRead>> {
  const known = state.held.get(sessionId);
  if (known) return known;
  if (state.held.size >= LEGACY_REFERENCE_HOPS_LIMIT) { state.complete = false; return new Map(); }
  const held = new Map<string, SensitiveConversationRead>();
  state.held.set(sessionId, held);
  const own = await conversationOwnReads(db, spaceId, sessionId);
  if (!own.complete) state.complete = false;
  for (const read of own.reads) held.set(readKey(read), read);
  for (const legacy of own.legacyReferences) {
    const source = legacy.sourceExists ? await collectConversationReads(db, spaceId, legacy.sourceId, state) : null;
    if (!source) state.complete = false;
    for (const [key, read] of source ?? []) held.set(key, read);
    // What an old copy says it carried must still be found at its source with the same owner.
    for (const read of legacy.recorded) {
      if (source?.has(readKey(read))) continue;
      state.complete = false;
      const unknown = { pluginId: read.pluginId, ownerUserId: null };
      held.set(readKey(unknown), unknown);
    }
  }
  return held;
}

interface LegacyReference { sourceId: string; sourceExists: boolean; recorded: SensitiveConversationRead[] }

/** One conversation's reads (Runs, shared text, references) and its old references to check against their source. */
async function conversationOwnReads(db: Queryable, spaceId: string, sessionId: string): Promise<{ reads: SensitiveConversationRead[]; complete: boolean; legacyReferences: LegacyReference[] }> {
  const fromRuns = runReadsFromRows((await db.query<RunReadsRow>(
    `${RUN_READS_SELECT} WHERE r.space_id=$1 AND r.session_id=$2 AND r.context_taint_json IS NOT NULL`, [spaceId, sessionId],
  )).rows);
  let complete = fromRuns.complete;
  const reads = [...fromRuns.reads];
  // `has_*` keep a field's presence: an explicit JSON null arrives as null too, and is malformed, not absent.
  const records = (await db.query<{ is_reference: boolean; record_type: string | null; kind: unknown; source_id: unknown; has_version: boolean | null; version: unknown; has_reads: boolean | null; reads: unknown }>(
    `SELECT x.is_reference, jsonb_typeof(x.record) AS record_type, x.record->'kind' AS kind, x.record->'source_id' AS source_id,
            CASE WHEN jsonb_typeof(x.record)='object' THEN x.record ? 'sensitive_reads_version' END AS has_version,
            x.record->'sensitive_reads_version' AS version,
            CASE WHEN jsonb_typeof(x.record)='object' THEN x.record ? 'sensitive_reads' END AS has_reads,
            x.record->'sensitive_reads' AS reads
       FROM (SELECT m.role='system' AND m.metadata_json->>'room_display'='reference' AS is_reference,
                    CASE WHEN m.role='system' AND m.metadata_json->>'room_display'='reference' THEN m.metadata_json->'reference' ELSE m.metadata_json END AS record
               FROM messages m
              WHERE m.space_id=$1 AND m.session_id=$2
                AND ((m.role='system' AND m.metadata_json->>'room_display'='reference') OR m.metadata_json->>'shared_from'='private_gmail_summary')) x`,
    [spaceId, sessionId],
  )).rows;
  const legacy: { sourceId: string; recorded: SensitiveConversationRead[] }[] = [];
  for (const row of records) {
    if (row.record_type !== "object") { complete = false; continue; }
    if (row.has_version) {
      const recorded = row.version === SENSITIVE_READS_VERSION ? parseRecordedSensitiveReads(row.reads) : null;
      if (!recorded) complete = false;
      reads.push(...recorded ?? []);
      continue;
    }
    const recorded = row.has_reads ? parseRecordedSensitiveReads(row.reads) : [];
    if (!recorded) complete = false;
    if (row.is_reference && (row.kind === "thread" || row.kind === "messages") && typeof row.source_id === "string" && row.source_id) {
      legacy.push({ sourceId: row.source_id, recorded: recorded ?? [] });
      continue;
    }
    // Nothing to check it against: an old shared excerpt (whose source Run may have held others' reads),
    // or an old non-conversation copy claiming reads. Its reads, if any, are kept with an unknown owner.
    if (row.is_reference && !row.has_reads && (row.kind !== "thread" && row.kind !== "messages")) continue;
    complete = false;
    const named = recorded?.length ? recorded : [UNRESOLVED_SENSITIVE_READ];
    reads.push(...named.map((read) => ({ pluginId: read.pluginId, ownerUserId: null })));
  }
  const existing = legacy.length ? new Set((await db.query<{ id: string }>(
    `SELECT id FROM sessions WHERE space_id=$1 AND id = ANY($2::varchar[])`, [spaceId, [...new Set(legacy.map((item) => item.sourceId))]],
  )).rows.map((row) => row.id)) : new Set<string>();
  return { reads, complete, legacyReferences: legacy.map((item) => ({ ...item, sourceExists: existing.has(item.sourceId) })) };
}

/** A recorded `sensitive_reads` list as reads, or `null` when any part of it is malformed (never read as empty). */
export function parseRecordedSensitiveReads(value: unknown): SensitiveConversationRead[] | null {
  if (!Array.isArray(value) || value.length > SENSITIVE_READS_LIMIT) return null;
  const reads: SensitiveConversationRead[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { plugin_id: pluginId, owner_user_id: owner } = entry as Record<string, unknown>;
    if (typeof pluginId !== "string" || !pluginId) return null;
    if (owner !== null && (typeof owner !== "string" || !owner)) return null;
    reads.push({ pluginId, ownerUserId: owner });
  }
  return reads;
}

interface RunReadsRow { taint: unknown; taint_type: string | null; proven_owner: string | null }

/**
 * A Run's taint plus who, if anyone, provably owns an entry written before
 * entries recorded owners: the Run's instructing person, only when every
 * sensitive read the Run itself logged was of their data and nothing in its
 * conversation (an earlier Run's reads or malformed taint, a reference, shared
 * text) existed for it to inherit when it was created. Otherwise such an entry stays unknown.
 * An earlier Run is set aside only when its taint is provably a valid record of no reads; a missing
 * or JSON-null field makes that test SQL NULL, never true (`IS NOT TRUE`), so the earlier Run counts.
 */
const RUN_READS_SELECT = `SELECT r.context_taint_json AS taint, jsonb_typeof(r.context_taint_json) AS taint_type,
  CASE WHEN EXISTS (SELECT 1 FROM agent_data_read_logs l WHERE l.space_id=r.space_id AND l.run_id=r.id AND l.data_class='sensitive'
                      AND l.owner_user_id=COALESCE(r.instructed_by_user_id, r.owner_user_id))
        AND NOT EXISTS (SELECT 1 FROM agent_data_read_logs l WHERE l.space_id=r.space_id AND l.run_id=r.id AND l.data_class='sensitive'
                      AND l.owner_user_id<>COALESCE(r.instructed_by_user_id, r.owner_user_id))
        AND NOT EXISTS (SELECT 1 FROM runs p WHERE p.space_id=r.space_id AND p.session_id=r.session_id AND p.id<>r.id
                      AND p.created_at<=r.created_at AND p.context_taint_json IS NOT NULL
                      AND (jsonb_typeof(p.context_taint_json)='object' AND p.context_taint_json->'schema_version'='1'::jsonb
                           AND p.context_taint_json->>'narrowest_visibility' IN ('private','selected_users','space_shared')
                           AND NOT p.context_taint_json ? 'plugin_reads') IS NOT TRUE)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.space_id=r.space_id AND m.session_id=r.session_id AND m.created_at<=r.created_at
                      AND ((m.role='system' AND m.metadata_json->>'room_display'='reference') OR m.metadata_json->>'shared_from'='private_gmail_summary'))
       THEN COALESCE(r.instructed_by_user_id, r.owner_user_id) END AS proven_owner
  FROM runs r`;

function runReadsFromRows(rows: readonly RunReadsRow[]): SensitiveConversationReads {
  let complete = true;
  const reads: SensitiveConversationRead[] = [];
  for (const row of rows) {
    const entries = sensitiveTaintEntries(row.taint, row.taint_type);
    if (!entries) { complete = false; continue; }
    for (const entry of entries) reads.push({ pluginId: entry.pluginId, ownerUserId: entry.owner === undefined ? row.proven_owner : entry.owner });
  }
  return { reads, complete };
}

/**
 * The sensitive reads one Run holds, with their owners, by the same rule as a
 * conversation's Runs: what a reply of that Run may carry. Incomplete when its
 * taint is malformed. Used where one Run's output is passed on (shared Gmail text).
 */
export async function runSensitiveReads(db: Queryable, spaceId: string, runId: string): Promise<SensitiveConversationReads> {
  return runReadsFromRows((await db.query<RunReadsRow>(`${RUN_READS_SELECT} WHERE r.space_id=$1 AND r.id=$2`, [spaceId, runId])).rows);
}

/**
 * A Run taint's sensitive entries (owner `undefined`: written before owners were recorded), or `null` when
 * malformed. Only SQL NULL (`jsonType` null) is no taint, as in `protectiveRunContextTaint`; JSON null is malformed.
 */
function sensitiveTaintEntries(value: unknown, jsonType: string | null): { pluginId: string; owner: string | null | undefined }[] | null {
  if (jsonType === null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schema_version !== 1 || !isVisibility(row.narrowest_visibility)) return null;
  if (row.plugin_reads === undefined) return [];
  if (!Array.isArray(row.plugin_reads)) return null;
  const out: { pluginId: string; owner: string | null | undefined }[] = [];
  for (const entry of row.plugin_reads) {
    if (!validPluginReadEntry(entry)) return null;
    if (entry.data_class === "sensitive") out.push({ pluginId: entry.plugin_id, owner: entry.owner_user_id });
  }
  return out;
}

function validPluginReadEntry(value: unknown): value is PluginReadTaint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.plugin_id === "string" && entry.plugin_id.length > 0
    && (entry.data_class === "personal" || entry.data_class === "sensitive")
    && (entry.owner_user_id === undefined || entry.owner_user_id === null || (typeof entry.owner_user_id === "string" && entry.owner_user_id.length > 0));
}

/** The reads a new Run of a conversation inherits: what it holds, plus an unknown-owner read when that is incomplete. */
export function inheritedReads(found: SensitiveConversationReads): SensitiveConversationRead[] {
  return found.complete ? found.reads : [...found.reads, UNRESOLVED_SENSITIVE_READ];
}
