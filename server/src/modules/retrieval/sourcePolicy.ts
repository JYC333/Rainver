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
            COALESCE(ii.connection_id, ss.connection_id, ii_ev.connection_id, ss_ev.connection_id) AS source_connection_id
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
    [spaceId, targetType, ids, ["source_item", "source_snapshot", "extracted_evidence"]],
  );
  for (const row of result.rows) {
    const sourceId = stringValue(row.source_connection_id);
    if (!sourceId) continue;
    const current = out.get(row.target_id) ?? [];
    if (!current.includes(sourceId)) current.push(sourceId);
    out.set(row.target_id, current);
  }
  return out;
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
