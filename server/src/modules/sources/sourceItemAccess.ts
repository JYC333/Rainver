import { registeredEntities } from "../ontology/entities.js";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";

const SOURCE_SNAPSHOT_ACCESS = contentResourceDefinition("source_snapshot")!;
const SOURCE_ITEM_ACCESS = contentResourceDefinition("source_item")!;
const EVIDENCE_ACCESS = contentResourceDefinition("extracted_evidence")!;
const SPACE_OBJECT_ACCESS = contentResourceDefinition("space_object")!;

export function sourceItemReadableClause(
  itemAlias: string,
  userParam: string,
  libraryOnly: boolean,
  options?: { includeOversight?: boolean },
): string {
  return `(
    ${contentReadSql("source_item", itemAlias, userParam, options)}
    AND ${sourceItemConnectionGateClause(itemAlias, userParam, libraryOnly)}
  )`;
}

/**
 * The one read for a Source item whose *content* is about to be used —
 * republished into a Proposal or Evidence, put in a prompt, or shown in a
 * briefing.
 *
 * Readable is not enough: a `summary`-level reader is served the item without
 * its body. Do not read the row and copy `excerpt` back out at `space_shared`
 * visibility. That would undo the withholding. Full access or nothing.
 *
 * The ordinary item gate, connection consent included, plus the level — not a
 * second shape of it. Oversight is excluded: a Space owner or admin may read a
 * member's item to supervise, and that does not extend to republishing it as
 * Evidence or as a Proposal (Decision Matrix #4).
 */
export function sourceItemFullContentReadClause(itemAlias: string, userParam: string): string {
  return `(
    ${sourceItemReadableClause(itemAlias, userParam, false, { includeOversight: false })}
    AND ${contentAccessLevelSql({ definition: SOURCE_ITEM_ACCESS, alias: itemAlias, userExpr: userParam })} = 'full'
  )`;
}

/**
 * Whether this reader is entitled to a connection's item: a live subscription
 * (with Library enabled, when the read is a Library read), or historical
 * eligibility — the item was first seen inside a window in which the reader
 * was subscribed, and the connection still admits them. Unsubscribing stops
 * new items and automatic profile facts, never the right to re-read what was
 * delivered; losing the connection itself (archived, deleted, visibility
 * narrowed, membership gone) ends both.
 */
export function sourceItemConnectionGateClause(itemAlias: string, userParam: string, libraryOnly: boolean): string {
  return `(
    ${itemAlias}.connection_id IS NULL
    OR EXISTS (
      SELECT 1
        FROM source_channel_user_subscriptions scus_read
        JOIN source_channels sch_read ON sch_read.id = scus_read.source_channel_id
       WHERE scus_read.space_id = ${itemAlias}.space_id
         AND sch_read.source_connection_id = ${itemAlias}.connection_id
         AND scus_read.user_id = ${userParam}
         AND scus_read.status = 'subscribed'
         ${libraryOnly ? "AND scus_read.library_enabled = true" : ""}
    )
    OR ${sourceItemHistoricalEligibilityClause(itemAlias, userParam)}
  )`;
}

/** The historical half of the gate above, on its own for callers that reason about it. */
export function sourceItemHistoricalEligibilityClause(itemAlias: string, userParam: string): string {
  return `EXISTS (
    SELECT 1
      FROM source_channel_user_subscriptions scus_hist
      JOIN source_channels sch_hist
        ON sch_hist.id = scus_hist.source_channel_id AND sch_hist.space_id = scus_hist.space_id
      JOIN source_connections sc_hist
        ON sc_hist.id = sch_hist.source_connection_id AND sc_hist.space_id = sch_hist.space_id
     WHERE scus_hist.space_id = ${itemAlias}.space_id
       AND sch_hist.source_connection_id = ${itemAlias}.connection_id
       AND scus_hist.user_id = ${userParam}
       AND scus_hist.status <> 'subscribed'
       AND scus_hist.subscribed_at IS NOT NULL
       AND scus_hist.unsubscribed_at IS NOT NULL
       AND ${itemAlias}.first_seen_at >= scus_hist.subscribed_at
       AND ${itemAlias}.first_seen_at < scus_hist.unsubscribed_at
       AND sc_hist.deleted_at IS NULL
       AND sc_hist.status <> 'archived'
       AND sch_hist.status <> 'archived'
       AND ${contentReadSql("source_connection", "sc_hist", userParam, { includeOversight: false })}
  )`;
}

/**
 * Whether an item may count as this reader's *interest evidence*: their own
 * saved URL, or a connection they are subscribed to right now. Historical
 * eligibility keeps the text readable; it does not keep feeding the profile.
 */
export function sourceItemProfileEvidenceClause(itemAlias: string, userParam: string): string {
  return `(
    ${itemAlias}.connection_id IS NULL
    OR EXISTS (
      SELECT 1 FROM source_connections sc_own
       WHERE sc_own.space_id = ${itemAlias}.space_id AND sc_own.id = ${itemAlias}.connection_id
         AND sc_own.owner_user_id = ${userParam}
         AND sc_own.deleted_at IS NULL AND sc_own.status <> 'archived'
    )
    OR EXISTS (
      SELECT 1
        FROM source_channel_user_subscriptions scus_fact
        JOIN source_channels sch_fact ON sch_fact.id = scus_fact.source_channel_id
       WHERE scus_fact.space_id = ${itemAlias}.space_id
         AND sch_fact.source_connection_id = ${itemAlias}.connection_id
         AND scus_fact.user_id = ${userParam}
         AND scus_fact.status = 'subscribed'
    )
  )`;
}

/** SQL form of the Reader connection-consent gate for Source-derived content. */
function sourceConnectionReaderConsentClause(connectionAlias: string, userParam: string): string {
  return `(
    ${connectionAlias}.owner_user_id = ${userParam}
    OR ${connectionAlias}.consent_json->>'owner_user_id' = ${userParam}
    OR ${connectionAlias}.consent_json->'allowed_reader_user_ids' @> to_jsonb(${userParam}::text)
    OR EXISTS (
      SELECT 1
        FROM source_channel_user_subscriptions consent_subscription
        JOIN source_channels consent_channel
          ON consent_channel.id = consent_subscription.source_channel_id
       WHERE consent_subscription.space_id = ${connectionAlias}.space_id
         AND consent_channel.source_connection_id = ${connectionAlias}.id
         AND consent_subscription.user_id = ${userParam}
         AND consent_subscription.status = 'subscribed'
    )
    OR (
      COALESCE((${connectionAlias}.consent_json->>'allow_space_admins')::boolean, true)
      AND EXISTS (
        SELECT 1 FROM space_memberships consent_membership
         WHERE consent_membership.space_id = ${connectionAlias}.space_id
           AND consent_membership.user_id = ${userParam}
           AND consent_membership.status = 'active'
           AND consent_membership.role IN ('owner','admin')
      )
    )
  )`;
}

export function sourceSnapshotReadableForEvidenceClause(evidenceAlias: string, userParam: string, requireFull = false): string {
  return `(
    ${evidenceAlias}.source_snapshot_id IS NULL
    OR EXISTS (
      SELECT 1
        FROM source_snapshots evidence_snapshot
        LEFT JOIN source_connections evidence_snapshot_connection
          ON evidence_snapshot_connection.space_id = evidence_snapshot.space_id
         AND evidence_snapshot_connection.id = evidence_snapshot.connection_id
         AND evidence_snapshot_connection.status <> 'archived'
         AND evidence_snapshot_connection.deleted_at IS NULL
       WHERE evidence_snapshot.space_id = ${evidenceAlias}.space_id
         AND evidence_snapshot.id = ${evidenceAlias}.source_snapshot_id
         AND ${contentReadSql("source_snapshot", "evidence_snapshot", userParam)}
         ${requireFull ? `AND ${contentAccessLevelSql({ definition: SOURCE_SNAPSHOT_ACCESS, alias: "evidence_snapshot", userExpr: userParam })} = 'full'` : ""}
         AND (
           evidence_snapshot.connection_id IS NULL
           OR (
             evidence_snapshot_connection.id IS NOT NULL
             AND ${sourceConnectionReaderConsentClause("evidence_snapshot_connection", userParam)}
           )
         )
    )
  )`;
}

/**
 * Evidence provenance is readable only through a readable origin SourceItem,
 * SourceSnapshot, and any canonical SpaceObject explicitly named as source.
 * Non-SpaceObject source kinds (for example reader_annotation or run_event)
 * retain their owning Evidence/Source gates and are not resolved here.
 */
export function evidenceProvenanceReadableClause(evidenceAlias: string, userParam: string, requireFull = false): string {
  return `(
    (
      COALESCE(${evidenceAlias}.source_item_id, ${evidenceAlias}.origin_source_item_id) IS NULL
      OR EXISTS (
        SELECT 1
          FROM source_items evidence_provenance_source_item
         WHERE evidence_provenance_source_item.space_id = ${evidenceAlias}.space_id
           AND evidence_provenance_source_item.id = COALESCE(${evidenceAlias}.source_item_id, ${evidenceAlias}.origin_source_item_id)
           AND evidence_provenance_source_item.deleted_at IS NULL
           AND ${sourceItemReadableClause("evidence_provenance_source_item", userParam, false)}
           ${requireFull ? `AND ${contentAccessLevelSql({ definition: SOURCE_ITEM_ACCESS, alias: "evidence_provenance_source_item", userExpr: userParam })} = 'full'` : ""}
      )
    )
    AND ${sourceSnapshotReadableForEvidenceClause(evidenceAlias, userParam, requireFull)}
    AND (
      ${evidenceAlias}.source_object_id IS NULL
      OR ${evidenceAlias}.source_object_type NOT IN (${ontologyObjectTypeLiterals()})
      OR EXISTS (
        SELECT 1
          FROM space_objects evidence_provenance_object
         WHERE evidence_provenance_object.space_id = ${evidenceAlias}.space_id
           AND evidence_provenance_object.id = ${evidenceAlias}.source_object_id
           AND evidence_provenance_object.deleted_at IS NULL
           AND ${contentReadSql("space_object", "evidence_provenance_object", userParam)}
           ${requireFull ? `AND ${contentAccessLevelSql({ definition: SPACE_OBJECT_ACCESS, alias: "evidence_provenance_object", userExpr: userParam })} = 'full'` : ""}
      )
    )
  )`;
}

/**
 * Effective Evidence access is the narrowest access granted by the Evidence
 * row and every Source object from which its content was derived.
 */
export function evidenceEffectiveAccessLevelSql(evidenceAlias: string, userParam: string): string {
  return `(CASE WHEN
    ${contentAccessLevelSql({ definition: EVIDENCE_ACCESS, alias: evidenceAlias, userExpr: userParam })} = 'full'
    AND ${evidenceProvenanceReadableClause(evidenceAlias, userParam, true)}
    THEN 'full' ELSE 'summary' END)`;
}

/**
 * The ontology object types, as SQL literals, for the fail-closed guard below:
 * if an evidence row points at an ontology object, that object must be readable.
 * Derived from the registry. Do not restate it: a copy can name a type with
 * no entity, no table, and no writer.
 */
function ontologyObjectTypeLiterals(): string {
  return registeredEntities()
    .filter((entity) => entity.rootEntity === "space_object")
    .map((entity) => `'${entity.entityType}'`)
    .join(", ");
}
