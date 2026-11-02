import type { Queryable } from "../../routeUtils/common.js";
import { sourceConnectionReaderConsentClause, sourceItemFullContentReadClause } from "../../sources/sourceItemAccess.js";
import { contentAccessLevelSql } from "../../access/contentAccessSql.js";
import { contentResourceDefinition } from "../../access/contentAccessRegistry.js";
import { readingFamilySql } from "../../sources/readingIdentity.js";
import { sha256, signalRevision, type BriefingCandidate, type BriefingDeps, type BriefingSignalDep } from "./contract.js";

const SOURCE_CONNECTION_ACCESS = contentResourceDefinition("source_connection")!;

/**
 * Every member of the audience array parameter passes `clause(user)`; an
 * empty audience passes nothing. A clause that evaluates to NULL for a member
 * (SQL three-valued logic, e.g. a consent branch with no match) counts as
 * "may not read": `NOT NULL` would otherwise let that member slip through.
 */
export function everyReader(audienceParam: string, clause: (user: string) => string): string {
  return `(cardinality(${audienceParam}::varchar[]) > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest(${audienceParam}::varchar[]) AS audience(user_id) WHERE NOT COALESCE((${clause("audience.user_id")}), false)))`;
}

/**
 * A scope row is in the window when its item's retained body or analysis
 * changed in `(since, cutoff]`, so a revision of already briefed material is
 * found without any new scope activity on it.
 */
export function contentChangedInWindowSql(itemExpr: string, since: string, cutoff: string): string {
  return `EXISTS (SELECT 1 FROM source_items changed
      LEFT JOIN source_item_annotations changed_analysis
        ON changed_analysis.source_item_id = changed.id AND changed_analysis.space_id = changed.space_id AND changed_analysis.status = 'succeeded'
     WHERE changed.id = ${itemExpr}
       AND ((changed.reading_body_changed_at > ${since}::timestamptz AND changed.reading_body_changed_at <= ${cutoff}::timestamptz)
         OR (changed_analysis.updated_at > ${since}::timestamptz AND changed_analysis.updated_at <= ${cutoff}::timestamptz)))`;
}

/** One scope signal row on an item, as an adapter reads it. */
export interface CandidateSignal {
  source_item_id: string;
  lens_kind: BriefingCandidate["signals"][number]["lens"]["kind"];
  lens_label: string;
  signal: string | null;
  activity_at: string;
  change_at: string | null;
  analysis_kind: BriefingSignalDep["kind"];
  analysis_id: string;
  /** The Source that collected or judged it. */
  connection_id: string | null;
}

const annotationRevision = (summary: string | null) => sha256(summary ?? "").slice(0, 16);

/**
 * Turns a scope's signals into candidates, shared by every adapter: the
 * item's reading family, content revision, objective annotation and
 * provenance, each with the dependency it was read from. An item is kept only
 * when the whole audience may fully read it (no Space oversight); the others
 * are returned as `not_shared_ids` so they are carried, never sent.
 */
/**
 * Of a scope's unfiltered signals (`BriefingScopeAdapter.scopeMembers`), the
 * items still members: not deleted, with at least one signal whose Source
 * still exists (a deleted Source cannot come back; an archived or private one
 * can). Ids only: no text of an item is read here.
 */
export async function liveScopeMembers(db: Queryable, spaceId: string, signals: CandidateSignal[]): Promise<Set<string>> {
  if (signals.length === 0) return new Set();
  const rows = await db.query<{ id: string }>(
    `SELECT DISTINCT i.id
       FROM unnest($2::varchar[], $3::varchar[]) AS signal(item_id, connection_id)
       JOIN source_items i ON i.id = signal.item_id AND i.space_id = $1 AND i.deleted_at IS NULL
       LEFT JOIN source_connections c ON c.id = signal.connection_id AND c.space_id = $1
      WHERE signal.connection_id IS NULL OR c.deleted_at IS NULL AND c.id IS NOT NULL`,
    [spaceId, signals.map((row) => row.source_item_id), signals.map((row) => row.connection_id)],
  );
  return new Set(rows.rows.map((row) => row.id));
}

export async function hydrateCandidates(
  db: Queryable,
  spaceId: string,
  audience: string[],
  signals: CandidateSignal[],
): Promise<{ rows: BriefingCandidate[]; not_shared_ids: string[] }> {
  const ids = [...new Set(signals.map((row) => row.source_item_id))];
  if (ids.length === 0) return { rows: [], not_shared_ids: [] };
  const items = await db.query<{
    id: string; connection_id: string | null; title: string; source_domain: string | null;
    occurred_at: string | null; first_seen_at: string; excerpt: string | null; family_key: string;
    content_revision: string; content_changed_at: string | null; annotated_at: string | null; summary: string | null;
    annotation_id: string | null; annotation_connection_id: string | null;
    unverified: boolean; shared: boolean;
  }>(
    `SELECT i.id, i.connection_id, i.title, i.source_domain, i.occurred_at::text, i.first_seen_at::text, i.excerpt,
            ${readingFamilySql("i")} AS family_key,
            COALESCE(i.content_hash, '') || ':' || i.reading_body_revision AS content_revision,
            GREATEST(i.reading_body_changed_at, a.updated_at)::text AS content_changed_at, a.annotated_at::text AS annotated_at,
            a.summary, a.id AS annotation_id, ac.source_connection_id AS annotation_connection_id,
            COALESCE(i.metadata_json->>'result_provenance', '') = 'agent_provided_unverified' AS unverified,
            ${everyReader("$3", (user) => sourceItemFullContentReadClause("i", user))} AS shared
       FROM source_items i
       LEFT JOIN source_item_annotations a ON a.source_item_id = i.id AND a.space_id = i.space_id AND a.status = 'succeeded'
       LEFT JOIN source_channels ac ON ac.id = a.source_channel_id AND ac.space_id = a.space_id
      WHERE i.space_id = $1 AND i.id = ANY($2::varchar[]) AND i.deleted_at IS NULL`,
    [spaceId, ids, audience],
  );
  const byItem = new Map(items.rows.map((row) => [row.id, row]));
  const notShared: string[] = [];
  const rows: BriefingCandidate[] = [];
  for (const id of ids) {
    const item = byItem.get(id);
    if (!item || !item.shared) { notShared.push(id); continue; }
    const own = signals.filter((row) => row.source_item_id === id);
    const iso = (value: string) => new Date(value).toISOString();
    const times = own.map((row) => Date.parse(String(row.activity_at)));
    if (item.content_changed_at) times.push(Date.parse(item.content_changed_at));
    rows.push({
      source_item_id: id,
      family_key: item.family_key,
      content_revision: item.content_revision,
      connection_id: item.connection_id,
      title: item.title,
      source_domain: item.source_domain,
      occurred_at: item.occurred_at ? iso(item.occurred_at) : null,
      first_seen_at: iso(item.first_seen_at),
      activity_at: new Date(Math.max(...times)).toISOString(),
      change_at: own.map((row) => row.change_at).filter(Boolean).map((at) => iso(String(at))).sort().pop() ?? null,
      unverified: item.unverified,
      summary: item.summary,
      excerpt: item.excerpt,
      annotation: item.annotation_id
        ? {
          id: item.annotation_id, item_id: id, connection_id: item.annotation_connection_id,
          revision: annotationRevision(item.summary), at: item.annotated_at ? iso(item.annotated_at) : null,
        }
        : null,
      signals: own.map((row) => ({
        lens: { kind: row.lens_kind, label: row.lens_label },
        text: row.signal?.trim() || null,
        activity_at: iso(String(row.activity_at)),
        change_at: row.change_at ? iso(String(row.change_at)) : null,
        dep: {
          kind: row.analysis_kind, id: row.analysis_id, item_id: id, connection_id: row.connection_id,
          revision: signalRevision(row.lens_label, row.signal?.trim() || null),
          at: iso(String(row.activity_at)),
        },
      })),
    });
  }
  return { rows, not_shared_ids: notShared };
}

/** Of these items, the ones every audience member may still fully read. */
export async function sharedItems(db: Queryable, spaceId: string, audience: string[], itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await db.query<{ id: string }>(
    `SELECT i.id FROM source_items i
      WHERE i.space_id = $1 AND i.id = ANY($2::varchar[]) AND i.deleted_at IS NULL
        AND ${everyReader("$3", (user) => sourceItemFullContentReadClause("i", user))}`,
    [spaceId, [...new Set(itemIds)], audience],
  );
  return new Set(rows.rows.map((row) => row.id));
}

/** Current content revision of each live item, and current revision of each succeeded annotation. */
export async function materialRevisions(
  db: Queryable,
  spaceId: string,
  itemIds: string[],
  annotationIds: string[],
): Promise<{ items: Map<string, string>; annotations: Map<string, string> }> {
  const items = itemIds.length
    ? (await db.query<{ id: string; revision: string }>(
      `SELECT id, COALESCE(content_hash, '') || ':' || reading_body_revision AS revision
         FROM source_items WHERE space_id = $1 AND id = ANY($2::varchar[]) AND deleted_at IS NULL`,
      [spaceId, [...new Set(itemIds)]],
    )).rows
    : [];
  const annotations = annotationIds.length
    ? (await db.query<{ id: string; summary: string | null }>(
      `SELECT id, summary FROM source_item_annotations WHERE space_id = $1 AND id = ANY($2::varchar[]) AND status = 'succeeded'`,
      [spaceId, [...new Set(annotationIds)]],
    )).rows
    : [];
  return {
    items: new Map(items.map((row) => [row.id, row.revision])),
    annotations: new Map(annotations.map((row) => [row.id, annotationRevision(row.summary)])),
  };
}

/** One collecting Source an analysis or scope judgment came through, at the time it was made. */
export interface CollectingRef { connection_id: string | null; at: string | null }
export const collectingKey = (ref: CollectingRef) => `${ref.connection_id}|${ref.at ?? ""}`;

/** Every collecting Source behind these dependencies (annotations and scope signals). */
export function collectingRefs(deps: BriefingDeps[]): CollectingRef[] {
  return deps.flatMap((dep) => [...dep.annotations, ...dep.signals].map((ref) => ({ connection_id: ref.connection_id, at: ref.at ?? null })));
}

/**
 * Of these collecting Sources, those every audience member may read in full
 * through the canonical Source reader gate (owner, consent reader, live or
 * delivered subscriber; never Space oversight) — the same gate Following
 * applies to its collecting binding. An analysis or judgment's text is
 * shared only when its own Source is, whatever the item it describes.
 * A reference with no Source is not gated here (its item gate applies).
 */
export async function readableCollecting(db: Queryable, spaceId: string, audience: string[], refs: CollectingRef[]): Promise<Set<string>> {
  const gated = [...new Map(refs.filter((ref) => ref.connection_id).map((ref) => [collectingKey(ref), ref])).values()];
  const readable = new Set(refs.filter((ref) => !ref.connection_id).map(collectingKey));
  if (gated.length === 0) return readable;
  const rows = await db.query<{ ord: string }>(
    `SELECT ref.ord::text AS ord
       FROM unnest($2::varchar[], $3::timestamptz[]) WITH ORDINALITY AS ref(connection_id, at, ord)
       JOIN source_connections collecting ON collecting.id = ref.connection_id AND collecting.space_id = $1
      WHERE ${everyReader("$4", (user) => `${sourceConnectionReaderConsentClause("collecting", user, "COALESCE(ref.at, now())", { includeOversight: false })}
        AND ${contentAccessLevelSql({ definition: SOURCE_CONNECTION_ACCESS, alias: "collecting", userExpr: user, includeOversight: false })} = 'full'`)}`,
    [spaceId, gated.map((ref) => ref.connection_id), gated.map((ref) => ref.at), audience],
  );
  for (const row of rows.rows) readable.add(collectingKey(gated[Number(row.ord) - 1]!));
  return readable;
}
