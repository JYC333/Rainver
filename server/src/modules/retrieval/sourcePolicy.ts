import type { Queryable } from "../routeUtils/common.js";
import type { RetrievalSourceEgressPolicy } from "./egress/egressPolicy.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";

const SOURCE_EGRESS_CLASSES = [
  "internal_only",
  "local_provider_allowed",
  "external_provider_allowed",
] as const;

type SourceEgressClass = (typeof SOURCE_EGRESS_CLASSES)[number];

interface SourceConnectionPolicyRow {
  id: string;
  owner_user_id: string;
  consent_json: unknown;
  policy_json: unknown;
}

interface SourceConnectionIdRow {
  target_id: string;
  source_connection_id: string | null;
  pinned_connection_ids: unknown;
}

interface SpaceMembershipRoleRow {
  role: string;
}

export interface SourcePolicySnapshot {
  id: string;
  ownerUserId: string;
  allowedReaderUserIds: string[];
  allowedAgentIds: string[];
  allowSpaceAdmins: boolean;
  allowLocalProviderEgress: boolean;
  allowExternalModelEgress: boolean;
  sourceEgressClass: SourceEgressClass;
}

export interface SourceReadContext {
  viewerUserId: string;
  agentId?: string | null;
  viewerSpaceRole?: string | null;
}

export function sourceConnectionIdsFromJson(value: unknown): string[] {
  return uniqueStrings(Array.isArray(value) ? value : []);
}

export function sourceConnectionIdsFromMetadata(value: unknown): string[] {
  const record = objectRecord(value);
  if (!record) return [];
  return uniqueStrings([
    stringValue(record.source_connection_id),
    ...(Array.isArray(record.source_connection_ids) ? record.source_connection_ids : []),
  ]);
}

export function sourceConnectionIdsFromSourceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const record = objectRecord(entry);
    if (!record) continue;
    out.push(stringValue(record.source_connection_id));
    if (stringValue(record.source_type) === "source_connection") {
      out.push(stringValue(record.source_id));
    }
  }
  return uniqueStrings(out);
}

/** The provenance entries that carry an object's Source lineage (and so its Source policy). */
export const SOURCE_LINEAGE_PROVENANCE_TYPES = ["source_item", "source_snapshot", "extracted_evidence"] as const;

/**
 * `evidence_json` key of a lineage entry that pins the Source connections it was
 * derived under. The connection of a lineage entry is otherwise resolved live from
 * its Source item or snapshot, which `source.item.update` may rebind or clear; a
 * pinned connection keeps answering for the entry either way (the union applies).
 */
export const SOURCE_LINEAGE_PINNED_CONNECTIONS_KEY = "source_connection_ids";

export async function loadSourceConnectionIdsForTargets(
  db: Queryable,
  spaceId: string,
  targetType: string,
  targetIds: readonly string[],
): Promise<Map<string, string[]>> {
  const ids = uniqueStrings(targetIds);
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  if (ids.length === 0) return out;
  const result = await db.query<SourceConnectionIdRow>(
    `SELECT pl.target_id,
            COALESCE(ii.connection_id, ss.connection_id, ii_ev.connection_id, ss_ev.connection_id) AS source_connection_id,
            pl.evidence_json->'${SOURCE_LINEAGE_PINNED_CONNECTIONS_KEY}' AS pinned_connection_ids
       FROM provenance_links pl
       LEFT JOIN source_items ii
         ON pl.source_type = 'source_item'
        AND ii.space_id = pl.space_id
        AND ii.id = pl.source_id
        AND ii.deleted_at IS NULL
       LEFT JOIN source_snapshots ss
         ON pl.source_type = 'source_snapshot'
        AND ss.space_id = pl.space_id
        AND ss.id = pl.source_id
       LEFT JOIN extracted_evidence ev
         ON pl.source_type = 'extracted_evidence'
        AND ev.space_id = pl.space_id
        AND ev.id = pl.source_id
        AND ev.deleted_at IS NULL
       LEFT JOIN source_items ii_ev
         ON ii_ev.space_id = ev.space_id
        AND ii_ev.id = COALESCE(ev.source_item_id, ev.origin_source_item_id)
        AND ii_ev.deleted_at IS NULL
       LEFT JOIN source_snapshots ss_ev
         ON ss_ev.space_id = ev.space_id
        AND ss_ev.id = ev.source_snapshot_id
      WHERE pl.space_id = $1
        AND pl.target_type = $2
        AND pl.target_id = ANY($3::varchar[])
        AND pl.source_type = ANY($4::varchar[])`,
    [spaceId, targetType, ids, [...SOURCE_LINEAGE_PROVENANCE_TYPES]],
  );
  for (const row of result.rows) {
    const current = out.get(row.target_id) ?? [];
    for (const sourceId of uniqueStrings([row.source_connection_id, ...sourceConnectionIdsFromJson(row.pinned_connection_ids)])) {
      if (!current.includes(sourceId)) current.push(sourceId);
    }
    out.set(row.target_id, current);
  }
  return out;
}

/**
 * Holds every Source lineage entry of the targets `FOR SHARE` for the rest of the
 * transaction — the provenance links, each referenced item (direct, behind a snapshot
 * or behind evidence), snapshot and evidence row — so the connections
 * {@link loadSourceConnectionIdsForTargets} resolves cannot change before commit: a
 * concurrent rebind or detach (`source.item.update` updates the item row first) waits.
 * Locks follow item → snapshot → evidence order, as that writer does.
 */
export async function lockSourceLineageEntries(
  db: Queryable,
  spaceId: string,
  targetType: string,
  targetIds: readonly string[],
): Promise<void> {
  const ids = uniqueStrings(targetIds).sort();
  if (ids.length === 0) return;
  const links = (await db.query<{ source_type: string; source_id: string }>(
    `SELECT id, source_type, source_id FROM provenance_links
      WHERE space_id = $1 AND target_type = $2 AND target_id = ANY($3::varchar[]) AND source_type = ANY($4::varchar[])
      ORDER BY id FOR SHARE`,
    [spaceId, targetType, ids, [...SOURCE_LINEAGE_PROVENANCE_TYPES]],
  )).rows;
  const of = (type: string) => links.filter((link) => link.source_type === type).map((link) => link.source_id);
  const evidenceIds = uniqueStrings(of("extracted_evidence")).sort();
  const evidence = evidenceIds.length ? (await db.query<{ item_id: string | null; snapshot_id: string | null }>(
    "SELECT COALESCE(source_item_id, origin_source_item_id) AS item_id, source_snapshot_id AS snapshot_id FROM extracted_evidence WHERE space_id = $1 AND id = ANY($2::varchar[])",
    [spaceId, evidenceIds],
  )).rows : [];
  const snapshotIds = uniqueStrings([...of("source_snapshot"), ...evidence.map((row) => row.snapshot_id)]).sort();
  const snapshotItems = snapshotIds.length ? (await db.query<{ source_item_id: string | null }>(
    "SELECT source_item_id FROM source_snapshots WHERE space_id = $1 AND id = ANY($2::varchar[])",
    [spaceId, snapshotIds],
  )).rows.map((row) => row.source_item_id) : [];
  const itemIds = uniqueStrings([...of("source_item"), ...evidence.map((row) => row.item_id), ...snapshotItems]).sort();
  if (itemIds.length) await db.query("SELECT id FROM source_items WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id FOR SHARE", [spaceId, itemIds]);
  if (snapshotIds.length) await db.query("SELECT id FROM source_snapshots WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id FOR SHARE", [spaceId, snapshotIds]);
  if (evidenceIds.length) await db.query("SELECT id FROM extracted_evidence WHERE space_id = $1 AND id = ANY($2::varchar[]) ORDER BY id FOR SHARE", [spaceId, evidenceIds]);
}

/**
 * Whether a viewer (and the Agent acting for them, if any) reads every Source in the
 * lineage of each target, by the same rule retrieval applies: a lineage Source without
 * a readable policy snapshot (archived, deleted, unparseable) denies. A target with no
 * Source lineage answers true. Content-ACL reads of derived text (a Note detail, its
 * history, a plugin's Note read, the Reader's research notebook, a Project notebook
 * and the prompts built from it) call this beside their own content gate.
 */
export async function sourceLineageReadable(
  db: Queryable,
  spaceId: string,
  targetType: string,
  targetIds: readonly string[],
  context: SourceReadContext,
): Promise<boolean> {
  const ids = uniqueStrings(targetIds);
  return (await sourceLineageReadableTargets(db, spaceId, targetType, ids, context)).size === ids.length;
}

/**
 * {@link sourceLineageReadable} per target: the ids of `targetIds` whose whole Source
 * lineage the viewer reads. A list of bodies (a Project notebook, a prompt's Notes)
 * withholds each other target's body by this one rule.
 */
export async function sourceLineageReadableTargets(
  db: Queryable,
  spaceId: string,
  targetType: string,
  targetIds: readonly string[],
  context: SourceReadContext,
): Promise<Set<string>> {
  const ids = uniqueStrings(targetIds);
  const lineage = await loadSourceConnectionIdsForTargets(db, spaceId, targetType, ids);
  const sourceIds = uniqueStrings([...lineage.values()].flat());
  if (!sourceIds.length) return new Set(ids);
  const readable = await readableSourceConnectionIds(db, spaceId, sourceIds, context);
  return new Set(ids.filter((id) => (lineage.get(id) ?? []).every((sourceId) => readable.has(sourceId))));
}

/**
 * The connections of `connectionIds` the viewer reads, by the lineage rule above: a
 * connection without a readable policy snapshot (archived, deleted, unparseable) is not
 * read. Connections pinned when a derivation started (a frozen prompt's Sources, a
 * pinned lineage entry) are judged by this same rule, beside the live lineage.
 */
export async function readableSourceConnectionIds(
  db: Queryable,
  spaceId: string,
  connectionIds: readonly string[],
  context: SourceReadContext,
): Promise<Set<string>> {
  const ids = uniqueStrings(connectionIds);
  if (!ids.length) return new Set();
  const snapshots = await loadSourcePolicySnapshots(db, spaceId, ids);
  const role = context.viewerSpaceRole !== undefined ? context.viewerSpaceRole : await loadViewerSpaceRole(db, spaceId, context.viewerUserId);
  return new Set(ids.filter((id) => {
    const snapshot = snapshots.get(id);
    return !!snapshot && sourcePolicyAllowsRead(snapshot, { ...context, viewerSpaceRole: role });
  }));
}

export async function loadSourcePolicySnapshots(
  db: Queryable,
  spaceId: string,
  sourceConnectionIds: readonly string[],
): Promise<Map<string, SourcePolicySnapshot>> {
  const ids = uniqueStrings(sourceConnectionIds);
  if (ids.length === 0) return new Map();
  const result = await db.query<SourceConnectionPolicyRow>(
    `SELECT id, owner_user_id, consent_json, policy_json
       FROM source_connections
      WHERE space_id = $1
        AND id = ANY($2::varchar[])
        AND status <> 'archived'
        AND deleted_at IS NULL`,
    [spaceId, ids],
  );
  const out = new Map<string, SourcePolicySnapshot>();
  for (const row of result.rows) {
    const snapshot = parseSourcePolicySnapshot(row);
    if (snapshot) out.set(snapshot.id, snapshot);
  }
  return out;
}

export async function loadViewerSpaceRole(
  db: Queryable,
  spaceId: string,
  viewerUserId: string,
): Promise<string | null> {
  const result = await db.query<SpaceMembershipRoleRow>(
    `SELECT role
       FROM space_memberships
      WHERE space_id = $1
        AND user_id = $2
        AND status = 'active'
      LIMIT 1`,
    [spaceId, viewerUserId],
  );
  return result.rows[0]?.role ?? null;
}

export function sourcePolicyAllowsRead(
  snapshot: SourcePolicySnapshot,
  context: SourceReadContext,
): boolean {
  if (
    context.agentId &&
    snapshot.allowedAgentIds.length > 0 &&
    !snapshot.allowedAgentIds.includes(context.agentId)
  ) {
    return false;
  }
  if (context.viewerUserId === snapshot.ownerUserId) return true;
  if (snapshot.allowedReaderUserIds.includes(context.viewerUserId)) return true;
  return (
    snapshot.allowSpaceAdmins &&
    isSpaceOwnerOrAdmin(context.viewerSpaceRole)
  );
}

export function sourceEgressPoliciesForSnapshots(
  snapshots: ReadonlyMap<string, SourcePolicySnapshot>,
): Record<string, RetrievalSourceEgressPolicy> {
  const out: Record<string, RetrievalSourceEgressPolicy> = {};
  for (const snapshot of snapshots.values()) {
    out[snapshot.id] = {
      source_egress_class: snapshot.sourceEgressClass,
      allow_local_provider_egress: snapshot.allowLocalProviderEgress,
      allow_external_model_egress: snapshot.allowExternalModelEgress,
    };
  }
  return out;
}

function parseSourcePolicySnapshot(row: SourceConnectionPolicyRow): SourcePolicySnapshot | null {
  const consent = objectRecord(row.consent_json);
  const policy = objectRecord(row.policy_json);
  if (!consent || !policy) return null;
  if (consent.schema_version !== 1 || policy.schema_version !== 1) return null;
  const ownerUserId = stringValue(consent.owner_user_id);
  if (!ownerUserId || ownerUserId !== row.owner_user_id) return null;
  const sourceEgressClass = enumValue(policy.source_egress_class, SOURCE_EGRESS_CLASSES);
  if (!sourceEgressClass) return null;
  const allowLocalProviderEgress = booleanValue(consent.allow_local_provider_egress);
  const allowExternalModelEgress = booleanValue(consent.allow_external_model_egress);
  if (sourceEgressClass === "external_provider_allowed" && !allowExternalModelEgress) return null;
  if (
    sourceEgressClass === "local_provider_allowed" &&
    !allowLocalProviderEgress &&
    !allowExternalModelEgress
  ) {
    return null;
  }
  return {
    id: row.id,
    ownerUserId,
    allowedReaderUserIds: stringArray(consent.allowed_reader_user_ids),
    allowedAgentIds: stringArray(consent.allowed_agent_ids),
    allowSpaceAdmins: booleanValue(consent.allow_space_admins),
    allowLocalProviderEgress,
    allowExternalModelEgress,
    sourceEgressClass,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return uniqueStrings(Array.isArray(value) ? value : []);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
): Values[number] | null {
  const normalized = stringValue(value);
  return (allowed as readonly string[]).includes(normalized) ? normalized as Values[number] : null;
}
