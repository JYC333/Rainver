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
 * was subscribed. Either way the connection must still admit the reader:
 * unsubscribing stops new items and automatic profile facts, never the right
 * to re-read what was delivered, while losing the connection itself
 * (archived, deleted, visibility or grants narrowed, membership gone, its
 * channel archived) ends both. The connection's owner reads its items
 * directly while the connection is live, even with every monitor archived;
 * only their Library listing follows subscriptions.
 */
export function sourceItemConnectionGateClause(itemAlias: string, userParam: string, libraryOnly: boolean): string {
  return `(
    ${itemAlias}.connection_id IS NULL
    OR EXISTS (
      SELECT 1 FROM source_connections gate_connection
       WHERE gate_connection.space_id = ${itemAlias}.space_id
         AND gate_connection.id = ${itemAlias}.connection_id
         AND (
           ${sourceConnectionLiveSubscriberClause("gate_connection", userParam, libraryOnly)}
           OR ${sourceConnectionDeliveredToReaderClause("gate_connection", userParam, `${itemAlias}.first_seen_at`)}
           ${libraryOnly ? "" : `OR ${sourceConnectionOwnerClause("gate_connection", userParam)}`}
         )
    )
  )`;
}

/**
 * The connection's owner reads its items directly (Reader, artifacts,
 * evidence) while the connection is live (not deleted or archived),
 * whatever happens to its monitors. What the
 * owner's Library lists still follows their own subscriptions.
 */
function sourceConnectionOwnerClause(connectionAlias: string, userParam: string): string {
  return `(${connectionAlias}.owner_user_id = ${userParam} AND ${connectionAlias}.deleted_at IS NULL AND ${connectionAlias}.status <> 'archived')`;
}

/** The historical half of the gate above, on its own for callers that reason about it. */
export function sourceItemHistoricalEligibilityClause(itemAlias: string, userParam: string): string {
  return `EXISTS (
    SELECT 1 FROM source_connections hist_connection
     WHERE hist_connection.space_id = ${itemAlias}.space_id
       AND hist_connection.id = ${itemAlias}.connection_id
       AND ${sourceConnectionDeliveredToReaderClause("hist_connection", userParam, `${itemAlias}.first_seen_at`)}
  )`;
}

/**
 * The connection still admits this reader as it stands today: not deleted or
 * archived, and readable to them under its current visibility and grants.
 * Oversight does not count: an admin may supervise, not subscribe.
 */
function connectionAdmitsReaderClause(connectionAlias: string, userParam: string): string {
  return `(
    ${connectionAlias}.deleted_at IS NULL
    AND ${connectionAlias}.status <> 'archived'
    AND ${contentReadSql("source_connection", connectionAlias, userParam, { includeOversight: false })}
  )`;
}

/** The reader subscribes right now to a live channel of this connection, which still admits them. */
export function sourceConnectionLiveSubscriberClause(connectionAlias: string, userParam: string, libraryOnly = false): string {
  return `(
    EXISTS (
      SELECT 1
        FROM source_channel_user_subscriptions live_subscription
        JOIN source_channels live_channel
          ON live_channel.id = live_subscription.source_channel_id AND live_channel.space_id = live_subscription.space_id
       WHERE live_subscription.space_id = ${connectionAlias}.space_id
         AND live_channel.source_connection_id = ${connectionAlias}.id
         AND live_subscription.user_id = ${userParam}
         AND live_subscription.status = 'subscribed'
         AND live_channel.status <> 'archived'
         ${libraryOnly ? "AND live_subscription.library_enabled = true" : ""}
    )
    AND ${connectionAdmitsReaderClause(connectionAlias, userParam)}
  )`;
}

/**
 * The reader received this connection's items when one delivered at
 * `deliveredAtExpr` arrived: a closed subscription window of one of its live
 * channels covers that moment, and the connection still admits the reader.
 * Each subscription period is its own window, so leaving and rejoining keeps
 * every earlier period readable.
 */
export function sourceConnectionDeliveredToReaderClause(connectionAlias: string, userParam: string, deliveredAtExpr: string): string {
  return `(
    EXISTS (
      SELECT 1
        FROM source_channel_subscription_windows delivered_window
        JOIN source_channels delivered_channel
          ON delivered_channel.id = delivered_window.source_channel_id AND delivered_channel.space_id = delivered_window.space_id
       WHERE delivered_window.space_id = ${connectionAlias}.space_id
         AND delivered_channel.source_connection_id = ${connectionAlias}.id
         AND delivered_window.user_id = ${userParam}
         AND delivered_window.unsubscribed_at IS NOT NULL
         AND ${deliveredAtExpr} >= delivered_window.subscribed_at
         AND ${deliveredAtExpr} < delivered_window.unsubscribed_at
         AND delivered_channel.status <> 'archived'
    )
    AND ${connectionAdmitsReaderClause(connectionAlias, userParam)}
  )`;
}

/**
 * Whether one Source item's own document (its Reader text, extracted or raw
 * artifact, export) may be opened: the item is readable to the viewer and
 * the connection's consent admits them — the same single-document rule the
 * Reader applies (owner, named reader, live or historical subscriber, or a
 * Space owner/admin reviewing where the consent allows). A personal Library
 * listing is narrower and follows subscriptions only
 * (`sourceItemReadableClause`).
 */
export function sourceItemDocumentReadableClause(itemAlias: string, userParam: string, options?: { includeOversight?: boolean }): string {
  return `(
    ${contentReadSql("source_item", itemAlias, userParam, options)}
    AND (
      ${itemAlias}.connection_id IS NULL
      OR EXISTS (
        SELECT 1 FROM source_connections document_connection
         WHERE document_connection.space_id = ${itemAlias}.space_id
           AND document_connection.id = ${itemAlias}.connection_id
           AND ${sourceConnectionReaderConsentClause("document_connection", userParam, `${itemAlias}.first_seen_at`, options)}
      )
    )
  )`;
}

/** Artifact types that carry a Source item's own text and stay behind its gate. */
export const SOURCE_DERIVED_ARTIFACT_TYPES = ["source_reader_document", "source_raw_snapshot"] as const;

/**
 * A Source-derived artifact (the extracted Reader document or the raw
 * snapshot) is readable only while the content it copies is: through a
 * readable item that references it, or through a snapshot whose connection
 * still admits the reader. Its own visibility, copied from the item at
 * capture, is not enough — it would outlive an unsubscribe window or a
 * revoked connection. Other artifacts are unaffected.
 */
export function sourceDerivedArtifactReadableClause(artifactAlias: string, userParam: string): string {
  return `(
    ${artifactAlias}.artifact_type NOT IN (${SOURCE_DERIVED_ARTIFACT_TYPES.map((type) => `'${type}'`).join(", ")})
    OR EXISTS (
      SELECT 1 FROM source_items artifact_item
       WHERE artifact_item.space_id = ${artifactAlias}.space_id
         AND artifact_item.deleted_at IS NULL
         AND ${artifactAlias}.id IN (artifact_item.raw_artifact_id, artifact_item.extracted_artifact_id)
         AND ${sourceItemDocumentReadableClause("artifact_item", userParam)}
    )
    OR EXISTS (
      SELECT 1
        FROM source_snapshots artifact_snapshot
        LEFT JOIN source_items artifact_snapshot_item
          ON artifact_snapshot_item.space_id = artifact_snapshot.space_id
         AND artifact_snapshot_item.id = artifact_snapshot.source_item_id
         AND artifact_snapshot_item.deleted_at IS NULL
        LEFT JOIN source_connections artifact_snapshot_connection
          ON artifact_snapshot_connection.space_id = artifact_snapshot.space_id
         AND artifact_snapshot_connection.id = artifact_snapshot.connection_id
       WHERE artifact_snapshot.space_id = ${artifactAlias}.space_id
         AND artifact_snapshot.artifact_id = ${artifactAlias}.id
         AND (
           (artifact_snapshot_item.id IS NOT NULL AND ${sourceItemReadableClause("artifact_snapshot_item", userParam, false)})
           OR (
             artifact_snapshot.source_item_id IS NULL
             AND (
               artifact_snapshot.connection_id IS NULL
               OR (
                 artifact_snapshot_connection.deleted_at IS NULL
                 AND artifact_snapshot_connection.status <> 'archived'
                 AND ${sourceConnectionReaderConsentClause("artifact_snapshot_connection", userParam, "artifact_snapshot.captured_at")}
               )
             )
           )
         )
    )
  )`;
}

/**
 * Whether an item may count as this reader's *interest evidence*: their own
 * saved URL, or a connection they are subscribed to right now. Historical
 * eligibility keeps the text readable; it does not keep feeding the profile.
 */
export function sourceItemProfileEvidenceClause(itemAlias: string, userParam: string): string {
  return `(
    (${itemAlias}.connection_id IS NULL AND ${itemAlias}.project_id IS NULL AND ${itemAlias}.owner_user_id = ${userParam})
    OR EXISTS (
      SELECT 1 FROM source_connections sc_own
       WHERE sc_own.space_id = ${itemAlias}.space_id AND sc_own.id = ${itemAlias}.connection_id
         AND sc_own.owner_user_id = ${userParam}
         AND sc_own.deleted_at IS NULL AND sc_own.status <> 'archived'
    )
    OR EXISTS (
      SELECT 1 FROM source_connections fact_connection
       WHERE fact_connection.space_id = ${itemAlias}.space_id
         AND fact_connection.id = ${itemAlias}.connection_id
         AND ${sourceConnectionLiveSubscriberClause("fact_connection", userParam)}
    )
  )`;
}

/**
 * SQL form of the Reader connection-consent gate for Source-derived content
 * delivered at `deliveredAtExpr`: the connection's owner or a named reader, a
 * live subscriber, a reader it was delivered to inside a subscription window,
 * or a Space owner/admin when the consent allows them.
 */
export function sourceConnectionReaderConsentClause(connectionAlias: string, userParam: string, deliveredAtExpr: string, options?: { includeOversight?: boolean }): string {
  // A withdrawn connection (archived or soft-deleted) admits nobody through
  // any of the branches below, its owner and consent-listed readers included.
  return `(
    ${connectionAlias}.deleted_at IS NULL
    AND ${connectionAlias}.status <> 'archived'
    AND (
    ${connectionAlias}.owner_user_id = ${userParam}
    OR ${connectionAlias}.consent_json->>'owner_user_id' = ${userParam}
    OR ${connectionAlias}.consent_json->'allowed_reader_user_ids' @> to_jsonb(${userParam}::text)
    OR ${sourceConnectionLiveSubscriberClause(connectionAlias, userParam)}
    OR ${sourceConnectionDeliveredToReaderClause(connectionAlias, userParam, deliveredAtExpr)}
    OR (
      ${options?.includeOversight === false ? 'false' : 'true'}
      AND COALESCE((${connectionAlias}.consent_json->>'allow_space_admins')::boolean, true)
      AND EXISTS (
        SELECT 1 FROM space_memberships consent_membership
         WHERE consent_membership.space_id = ${connectionAlias}.space_id
           AND consent_membership.user_id = ${userParam}
           AND consent_membership.status = 'active'
           AND consent_membership.role IN ('owner','admin')
      )
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
             AND ${sourceConnectionReaderConsentClause("evidence_snapshot_connection", userParam, `COALESCE((SELECT evidence_snapshot_item.first_seen_at FROM source_items evidence_snapshot_item WHERE evidence_snapshot_item.space_id = evidence_snapshot.space_id AND evidence_snapshot_item.id = evidence_snapshot.source_item_id), evidence_snapshot.captured_at)`)}
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
