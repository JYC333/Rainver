import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServerConfig } from "../../config";
import { HttpError, dateIso, objectValue, optionalString, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { normalizeSourceConnectionReadGovernance, enforceSourceDerivedImportTarget } from "../sources/sourceConsent";
import type { SourceItemRow } from "../sources/sourceRepositoryRows";
import { ITEM_COLUMNS } from "../sources/sourceRepositoryRows";
import { isSpaceOwnerOrAdmin } from "../access/roles";
import { contentReadSql } from "../access/contentAccessSql";
import { contentDecisionFromDb } from "../access/contentAccessQuery";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance";
import { insertProposalRow } from "../proposals/reviewPackets";
import { canAccessProject } from "../memory/projectAccess";
import { parseStructuredReaderContent, type ReaderPmDoc } from "../sources/contentParsing";
import { upsertCanonicalEvidence } from "../sources/evidenceIdentity";

/**
 * Normalizes raw plainText into the canonical form used by the Tiptap reader:
 * trim → split on double-newlines → trim each paragraph → rejoin with ' '.
 *
 * This is the same text the editor produces via `textBetween(0, size, ' ')`,
 * so text_range offsets, content_hash, before_context, and after_context must
 * all be computed from this normalized form.
 */
export function normalizeReaderText(text: string | null | undefined): string {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");
}

function plainTextToPmDoc(text: string | null | undefined): ReaderPmDoc {
  const trimmed = text?.trim();
  if (!trimmed) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    type: "doc",
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: [{ type: "text", text: p }],
    })),
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Safe artifact text reader ─────────────────────────────────────────────────

interface ArtifactTextRow {
  id: string;
  space_id: string;
  artifact_type: string;
  title: string;
  content: string | null;
  storage_path: string | null;
  mime_type: string | null;
  visibility: string;
  owner_user_id: string | null;
}

async function loadVisibleArtifactForReader(
  db: Queryable,
  spaceId: string,
  userId: string,
  artifactId: string,
): Promise<ArtifactTextRow | null> {
  const result = await db.query<ArtifactTextRow>(
    `SELECT a.id, a.space_id, a.artifact_type, a.title, a.content, a.storage_path, a.mime_type, a.visibility, a.owner_user_id
       FROM artifacts a
      WHERE a.id = $1 AND a.space_id = $2
        AND ${contentReadSql("artifact", "a", "$3")}`,
    [artifactId, spaceId, userId],
  );
  return result.rows[0] ?? null;
}

async function assertArtifactReadable(
  db: Queryable,
  identity: SpaceUserIdentity,
  artifactId: string,
  notFoundMessage: string,
): Promise<void> {
  const artifact = await loadVisibleArtifactForReader(db, identity.spaceId, identity.userId, artifactId);
  if (!artifact) throw new HttpError(404, notFoundMessage);
}

interface ArtifactReaderContent {
  text: string;
  title: string;
  contentJson?: ReaderPmDoc;
}

async function readArtifactForReader(
  db: Queryable,
  config: Pick<ServerConfig, "artifactStorageRoot" | "sandboxRoot">,
  spaceId: string,
  userId: string,
  artifactId: string,
): Promise<ArtifactReaderContent | null> {
  const row = await loadVisibleArtifactForReader(db, spaceId, userId, artifactId);
  if (!row) return null;

  if (row.mime_type !== "application/json") return null;

  const raw = row.content
    ? row.content
    : row.storage_path
      ? await safeReadTextFile(config, row.storage_path)
      : null;
  if (raw === null) return null;

  const structured = parseStructuredReaderContent(raw);
  if (structured) {
    return {
      text: structured.plain_text,
      title: structured.title ?? row.title,
      contentJson: structured.content_json,
    };
  }
  return null;
}

async function safeReadTextFile(
  config: Pick<ServerConfig, "artifactStorageRoot" | "sandboxRoot">,
  storagePath: string,
): Promise<string | null> {
  if (storagePath.startsWith("/") || storagePath.includes("\0")) return null;
  const root = resolve(config.artifactStorageRoot);
  const sandboxRoot = resolve(config.sandboxRoot);
  const candidate = resolve(root, storagePath);
  if (!candidate.startsWith(root + "/") && candidate !== root) return null;
  if (candidate.startsWith(sandboxRoot + "/") || candidate === sandboxRoot) return null;
  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) return null;
  return readFile(candidate, "utf8").catch(() => null);
}

// ── Source snapshot row ───────────────────────────────────────────────────────

interface SourceSnapshotRow {
  id: string;
  space_id: string;
  project_id: string | null;
  source_item_id: string | null;
  connection_id: string | null;
  snapshot_type: string;
  artifact_id: string | null;
  content_hash: string | null;
  source_uri: string | null;
}

// ── Reader document output ────────────────────────────────────────────────────

export interface ReaderDocumentOut {
  document_type: string;
  document_id: string;
  space_id: string;
  project_id: string | null;
  title: string;
  plain_text: string;
  /** Canonical form: trim → split on ≥2 newlines → trim paragraphs → join with ' '.
   *  All anchor text_range offsets, content_hash, and context windows must be
   *  computed from this field, not from plain_text. */
  normalized_text: string;
  content_hash: string;
  content_format: "tiptap_json";
  content_schema_version: 1;
  content_json: ReaderPmDoc;
  source_item_id: string | null;
  artifact_id: string | null;
  source_snapshot_id: string | null;
  raw_artifact_id: string | null;
  extracted_artifact_id: string | null;
  source_uri: string | null;
  content_state: string | null;
  retention_policy: string | null;
  can_annotate: true;
}

// ── Source consent check ──────────────────────────────────────────────────────

interface ConsentCheckInput {
  db: Queryable;
  identity: SpaceUserIdentity;
  item: SourceItemRow;
}

async function enforceConnectionReadConsent(
  db: Queryable,
  identity: SpaceUserIdentity,
  connectionId: string,
): Promise<void> {
  const conn = await db.query<{ project_id: string | null; consent_json: unknown; policy_json: unknown; owner_user_id: string }>(
    `SELECT project_id, consent_json, policy_json, owner_user_id
       FROM source_connections WHERE space_id = $1 AND id = $2`,
    [identity.spaceId, connectionId],
  );
  // Intentionally omits deleted_at IS NULL: soft-deleted connections still carry
  // consent_json and should continue to gate access to their derived snapshots.
  // A missing row (hard-deleted or wrong space) is treated as fail-closed.
  if (!conn.rows[0]) throw new HttpError(404, "Not found");
  const gov = normalizeSourceConnectionReadGovernance({
    ...conn.rows[0],
    id: connectionId,
    space_id: identity.spaceId,
    provider_connector_id: undefined,
    connector_key: null,
    name: "",
    status: "active",
    visibility: "private",
    access_level: "full",
    capture_policy: "reference_only",
    trust_level: "normal",
    topic_hints_json: null,
    config_json: null,
    credential_id: null,
    handler_kind: "built_in",
    active_handler_version_id: null,
    active_recipe_version_id: null,
    repair_status: "ok",
    last_handler_run_id: null,
    created_at: null,
    updated_at: null,
  });
  const consent = gov.consent;
  if (identity.userId === consent.owner_user_id) return;
  const subscription = await db.query<{ id: string }>(
    `SELECT scus.id
       FROM source_channel_user_subscriptions scus
       JOIN source_channels sch ON sch.id = scus.source_channel_id
      WHERE scus.space_id = $1
        AND sch.source_connection_id = $2
        AND scus.user_id = $3
        AND scus.status = 'subscribed'
      LIMIT 1`,
    [identity.spaceId, connectionId, identity.userId],
  );
  if (subscription.rows[0]) return;
  if (consent.allowed_reader_user_ids.includes(identity.userId)) return;
  if (consent.allow_space_admins) {
    const roleRow = await db.query<{ role: string }>(
      `SELECT role FROM space_memberships WHERE user_id = $1 AND space_id = $2 AND status = 'active' LIMIT 1`,
      [identity.userId, identity.spaceId],
    );
    if (isSpaceOwnerOrAdmin(roleRow.rows[0]?.role)) return;
  }
  throw new HttpError(404, "Not found");
}

async function enforceSourceItemReadConsent({ db, identity, item }: ConsentCheckInput): Promise<void> {
  if (item.space_id !== identity.spaceId) throw new HttpError(404, "Not found");
  if (item.connection_id) {
    await enforceConnectionReadConsent(db, identity, item.connection_id);
    return;
  }
  if (item.created_by_user_id !== identity.userId) throw new HttpError(404, "Not found");
}

async function markSourceItemOpened(
  db: Queryable,
  identity: SpaceUserIdentity,
  itemId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO source_item_user_states (
       id, space_id, source_item_id, user_id, library_status, read_status,
       first_opened_at, last_opened_at, progress_json, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'new', 'skimmed',
       $5, $5, '{}'::jsonb, $5, $5
     )
     ON CONFLICT (space_id, source_item_id, user_id) DO UPDATE SET
       first_opened_at = COALESCE(source_item_user_states.first_opened_at, $5::timestamptz),
       last_opened_at = $5::timestamptz,
       read_status = CASE
         WHEN source_item_user_states.read_status = 'unread' THEN 'skimmed'
         ELSE source_item_user_states.read_status
       END,
       updated_at = $5`,
    [randomUUID(), identity.spaceId, itemId, identity.userId, now],
  );
}

// ── Repository ────────────────────────────────────────────────────────────────

export class PgReaderRepository {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  async getDocument(
    identity: SpaceUserIdentity,
    documentType: string,
    documentId: string,
  ): Promise<ReaderDocumentOut | null> {
    if (documentType === "source_item") {
      return this.resolveSourceItem(identity, documentId);
    }
    if (documentType === "source_snapshot") {
      return this.resolveSourceSnapshot(identity, documentId);
    }
    if (documentType === "research_report") {
      return this.resolveResearchReport(identity, documentId);
    }
    if (documentType === "research_notebook") {
      return this.resolveResearchNotebookSection(identity, documentId);
    }
    throw new HttpError(400, `Unsupported document type: ${documentType}`);
  }

  // ── source_item resolver ────────────────────────────────────────────────────

  private async resolveSourceItem(
    identity: SpaceUserIdentity,
    itemId: string,
  ): Promise<ReaderDocumentOut | null> {
    if ((await contentDecisionFromDb(this.db, identity, "source_item", itemId)) !== "full") return null;
    const result = await this.db.query<SourceItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM source_items WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [identity.spaceId, itemId],
    );
    const item = result.rows[0];
    if (!item) return null;

    await enforceSourceItemReadConsent({ db: this.db, identity, item });
    await markSourceItemOpened(this.db, identity, itemId);

    // Priority 1: extracted_artifact_id
    if (item.extracted_artifact_id) {
      const text = await readArtifactForReader(this.db, this.config, identity.spaceId, identity.userId, item.extracted_artifact_id);
      if (text) {
        return this.buildDocOut({
          documentType: "source_item",
          documentId: itemId,
          spaceId: identity.spaceId,
          projectId: item.project_id,
          title: item.title,
          plainText: text.text,
          contentJson: text.contentJson,
          sourceItemId: itemId,
          artifactId: item.extracted_artifact_id,
          sourceSnapshotId: null,
          rawArtifactId: item.raw_artifact_id,
          extractedArtifactId: item.extracted_artifact_id,
          sourceUri: item.source_uri,
          contentState: item.content_state,
          retentionPolicy: item.retention_policy,
        });
      }
    }

    // Priority 2: latest extracted snapshot (by captured_at, not id)
    const snapResult = await this.db.query<SourceSnapshotRow>(
      `SELECT id, space_id, project_id, source_item_id, snapshot_type, artifact_id, content_hash, source_uri
         FROM source_snapshots
        WHERE space_id = $1 AND source_item_id = $2 AND snapshot_type = 'extracted' AND artifact_id IS NOT NULL
          AND ${contentReadSql("source_snapshot", "source_snapshots", "$3")}
        ORDER BY captured_at DESC LIMIT 1`,
      [identity.spaceId, itemId, identity.userId],
    );
    const snap = snapResult.rows[0];
    if (snap?.artifact_id) {
      const text = await readArtifactForReader(this.db, this.config, identity.spaceId, identity.userId, snap.artifact_id);
      if (text) {
        return this.buildDocOut({
          documentType: "source_item",
          documentId: itemId,
          spaceId: identity.spaceId,
          projectId: item.project_id,
          title: item.title,
          plainText: text.text,
          contentJson: text.contentJson,
          sourceItemId: itemId,
          artifactId: snap.artifact_id,
          sourceSnapshotId: snap.id,
          rawArtifactId: item.raw_artifact_id,
          extractedArtifactId: item.extracted_artifact_id,
          sourceUri: item.source_uri,
          contentState: item.content_state,
          retentionPolicy: item.retention_policy,
        });
      }
    }

    // Priority 3: excerpt fallback
    if (item.excerpt) {
      return this.buildDocOut({
        documentType: "source_item",
        documentId: itemId,
        spaceId: identity.spaceId,
        projectId: item.project_id,
        title: item.title,
        plainText: item.excerpt,
        sourceItemId: itemId,
        artifactId: null,
        sourceSnapshotId: null,
        rawArtifactId: item.raw_artifact_id,
        extractedArtifactId: item.extracted_artifact_id,
        sourceUri: item.source_uri,
        contentState: item.content_state,
        retentionPolicy: item.retention_policy,
      });
    }

    return null;
  }

  // ── source_snapshot resolver ────────────────────────────────────────────────

  private async resolveSourceSnapshot(
    identity: SpaceUserIdentity,
    snapshotId: string,
  ): Promise<ReaderDocumentOut | null> {
    if ((await contentDecisionFromDb(this.db, identity, "source_snapshot", snapshotId)) !== "full") return null;
    const result = await this.db.query<SourceSnapshotRow>(
      `SELECT id, space_id, project_id, source_item_id, connection_id, snapshot_type, artifact_id, content_hash, source_uri
         FROM source_snapshots WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, snapshotId],
    );
    const snap = result.rows[0];
    if (!snap) return null;

    // Enforce source consent: source-item consent covers the connection gate;
    // connection-only snapshots are gated directly against the connection's consent_json.
    if (snap.source_item_id) {
      const itemResult = await this.db.query<SourceItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM source_items WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [identity.spaceId, snap.source_item_id],
      );
      if (itemResult.rows[0]) {
        await enforceSourceItemReadConsent({ db: this.db, identity, item: itemResult.rows[0] });
      } else if (snap.connection_id) {
        // Item soft-deleted: fall back to connection gate rather than opening access.
        await enforceConnectionReadConsent(this.db, identity, snap.connection_id);
      } else {
        throw new HttpError(404, "Not found");
      }
    } else if (snap.connection_id) {
      await enforceConnectionReadConsent(this.db, identity, snap.connection_id);
    }

    if (!snap.artifact_id) return null;

    const text = await readArtifactForReader(this.db, this.config, identity.spaceId, identity.userId, snap.artifact_id);
    if (!text) return null;

    return this.buildDocOut({
      documentType: "source_snapshot",
      documentId: snapshotId,
      spaceId: identity.spaceId,
      projectId: snap.project_id,
      title: text.title,
      plainText: text.text,
      contentJson: text.contentJson,
      sourceItemId: snap.source_item_id,
      artifactId: snap.artifact_id,
      sourceSnapshotId: snapshotId,
      rawArtifactId: null,
      extractedArtifactId: null,
      sourceUri: snap.source_uri,
      contentState: null,
      retentionPolicy: null,
    });
  }

  private async resolveResearchReport(
    identity: SpaceUserIdentity,
    reportId: string,
  ): Promise<ReaderDocumentOut | null> {
    const result = await this.db.query<{
      project_id: string;
      research_question: string;
      reader_document_json: ReaderPmDoc;
      normalized_text: string;
      content_hash: string;
    }>(
      `SELECT project_id, research_question, reader_document_json, normalized_text, content_hash
         FROM project_research_reports
        WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, reportId],
    );
    const report = result.rows[0];
    if (!report || !(await canAccessProject(this.db, identity.spaceId, report.project_id, identity.userId))) return null;
    return {
      document_type: "research_report",
      document_id: reportId,
      space_id: identity.spaceId,
      project_id: report.project_id,
      title: report.research_question,
      plain_text: report.normalized_text,
      normalized_text: report.normalized_text,
      content_hash: report.content_hash,
      content_format: "tiptap_json",
      content_schema_version: 1,
      content_json: report.reader_document_json,
      source_item_id: null,
      artifact_id: null,
      source_snapshot_id: null,
      raw_artifact_id: null,
      extracted_artifact_id: null,
      source_uri: null,
      content_state: null,
      retention_policy: null,
      can_annotate: true,
    };
  }

  // A project's notebook notes are ordinary Notes (tagged with
  // primary_project_id); this resolver serves the "research_notebook"
  // Reader document type against that table.
  private async resolveResearchNotebookSection(identity: SpaceUserIdentity, noteId: string): Promise<ReaderDocumentOut | null> {
    const result = await this.db.query<{ project_id: string | null; title: string; content_json: ReaderPmDoc; plain_text: string | null; content_hash: string | null }>(
      `SELECT so.primary_project_id AS project_id, so.title, n.content_json, n.plain_text, n.content_hash
         FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
        WHERE n.space_id=$1 AND n.object_id=$2 AND n.status='active'`,
      [identity.spaceId, noteId],
    );
    const note = result.rows[0];
    if (!note?.project_id || !(await canAccessProject(this.db, identity.spaceId, note.project_id, identity.userId))) return null;
    return { document_type: "research_notebook", document_id: noteId, space_id: identity.spaceId, project_id: note.project_id, title: `Research notebook · ${note.title}`,
      plain_text: note.plain_text ?? "", normalized_text: note.plain_text ?? "", content_hash: note.content_hash ?? "",
      content_format: "tiptap_json", content_schema_version: 1, content_json: note.content_json, source_item_id: null,
      artifact_id: null, source_snapshot_id: null, raw_artifact_id: null, extracted_artifact_id: null, source_uri: null,
      content_state: null, retention_policy: null, can_annotate: true };
  }

  // ── builder ─────────────────────────────────────────────────────────────────

  private buildDocOut(args: {
    documentType: string;
    documentId: string;
    spaceId: string;
    projectId: string | null;
    title: string;
    plainText: string;
    contentJson?: ReaderPmDoc;
    sourceItemId: string | null;
    artifactId: string | null;
    sourceSnapshotId: string | null;
    rawArtifactId: string | null;
    extractedArtifactId: string | null;
    sourceUri: string | null;
    contentState: string | null;
    retentionPolicy: string | null;
  }): ReaderDocumentOut {
    const normalizedText = normalizeReaderText(args.plainText);
    const contentJson = args.contentJson ?? plainTextToPmDoc(args.plainText);
    const contentHash = sha256Hex(normalizedText);
    return {
      document_type: args.documentType,
      document_id: args.documentId,
      space_id: args.spaceId,
      project_id: args.projectId,
      title: args.title,
      plain_text: args.plainText,
      normalized_text: normalizedText,
      content_hash: contentHash,
      content_format: "tiptap_json",
      content_schema_version: 1,
      content_json: contentJson,
      source_item_id: args.sourceItemId,
      artifact_id: args.artifactId,
      source_snapshot_id: args.sourceSnapshotId,
      raw_artifact_id: args.rawArtifactId,
      extracted_artifact_id: args.extractedArtifactId,
      source_uri: args.sourceUri,
      content_state: args.contentState,
      retention_policy: args.retentionPolicy,
      can_annotate: true,
    };
  }
}

// ── Annotation repository ─────────────────────────────────────────────────────

const ANNOTATION_TYPES = new Set(["highlight", "comment", "excerpt", "bookmark"]);
function persistedVisibility(value: string): "private" | "space_shared" | "selected_users" {
  if (value === "private" || value === "space_shared" || value === "selected_users") return value;
  throw new Error(`Invalid persisted Reader visibility: ${value}`);
}

export interface ReaderAnnotationRow {
  id: string;
  space_id: string;
  project_id: string | null;
  document_type: string;
  document_id: string;
  annotation_type: string;
  quote_text: string;
  anchor_json: unknown;
  color: string | null;
  label: string | null;
  visibility: string;
  access_level: string;
  owner_user_id: string;
  status: string;
  anchor_state: string;
  created_by_user_id: string;
  created_at: unknown;
  updated_at: unknown;
}

const ANNOTATION_COLUMNS = `id, space_id, project_id, document_type, document_id,
  annotation_type, quote_text, anchor_json, color, label, visibility, access_level, status, anchor_state,
  created_by_user_id, owner_user_id, created_at, updated_at`;

async function assertAnnotationReadable(
  db: Queryable,
  identity: SpaceUserIdentity,
  annotation: ReaderAnnotationRow,
): Promise<void> {
  if ((await contentDecisionFromDb(db, identity, "reader_annotation", annotation.id)) === "deny") {
    throw new HttpError(404, "Not found");
  }
}

export interface ReaderAnnotationOut {
  id: string;
  space_id: string;
  project_id: string | null;
  document_type: string;
  document_id: string;
  annotation_type: string;
  quote_text: string;
  anchor_json: Record<string, unknown>;
  color: string | null;
  label: string | null;
  visibility: string;
  access_level: string;
  owner_user_id: string;
  status: string;
  anchor_state: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

function annotationOut(row: ReaderAnnotationRow): ReaderAnnotationOut {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    document_type: row.document_type,
    document_id: row.document_id,
    annotation_type: row.annotation_type,
    quote_text: row.quote_text,
    anchor_json: objectValue(row.anchor_json),
    color: row.color,
    label: row.label,
    visibility: row.visibility,
    access_level: row.access_level,
    owner_user_id: row.owner_user_id,
    status: row.status,
    anchor_state: row.anchor_state,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

// ── Document gate helpers ─────────────────────────────────────────────────────

function annotationDocumentTarget(
  ann: ReaderAnnotationRow,
): { documentType: string; documentId: string } | null {
  return { documentType: ann.document_type, documentId: ann.document_id };
}

// ── Document read gate (lightweight, no file I/O) ────────────────────────────

interface DocumentAccessContext {
  projectId: string | null;
  visibility: "private" | "space_shared" | "selected_users";
  accessLevel: "full" | "summary";
}

function persistedAccessLevel(value: string): "full" | "summary" {
  if (value === "full" || value === "summary") return value;
  throw new Error(`Invalid persisted Reader access level: ${value}`);
}

const ANNOTATION_VISIBILITY_RANK: Record<"private" | "space_shared" | "selected_users", number> = {
  private: 0,
  selected_users: 1,
  space_shared: 2,
};

function annotationVisibility(
  requested: string | null,
  documentVisibility: "private" | "space_shared" | "selected_users",
): "private" | "space_shared" | "selected_users" {
  if (requested === null) return "private";
  if (requested !== "private" && requested !== "space_shared" && requested !== "selected_users") {
    throw new HttpError(422, "visibility must be private, space_shared, or selected_users");
  }
  if (ANNOTATION_VISIBILITY_RANK[requested] > ANNOTATION_VISIBILITY_RANK[documentVisibility]) {
    throw new HttpError(422, "An annotation cannot be more widely visible than its document");
  }
  return requested;
}

async function assertDocumentReadable(
  db: Queryable,
  identity: SpaceUserIdentity,
  documentType: string,
  documentId: string,
): Promise<DocumentAccessContext> {
  if (documentType === "source_item") {
    if ((await contentDecisionFromDb(db, identity, "source_item", documentId)) !== "full") {
      throw new HttpError(404, "Document not found");
    }
    const r = await db.query<SourceItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM source_items WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [identity.spaceId, documentId],
    );
    if (!r.rows[0]) throw new HttpError(404, "Document not found");
    await enforceSourceItemReadConsent({ db, identity, item: r.rows[0] });
    return {
      projectId: r.rows[0].project_id,
      visibility: persistedVisibility(r.rows[0].visibility),
      accessLevel: persistedAccessLevel(r.rows[0].access_level),
    };
  }
  if (documentType === "source_snapshot") {
    if ((await contentDecisionFromDb(db, identity, "source_snapshot", documentId)) !== "full") {
      throw new HttpError(404, "Document not found");
    }
    const r = await db.query<{ project_id: string | null; visibility: string; access_level: string; source_item_id: string | null; connection_id: string | null; artifact_id: string | null }>(
      `SELECT project_id, visibility, access_level, source_item_id, connection_id, artifact_id FROM source_snapshots WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, documentId],
    );
    if (!r.rows[0]) throw new HttpError(404, "Document not found");
    if (r.rows[0].source_item_id) {
      const itemR = await db.query<SourceItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM source_items WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [identity.spaceId, r.rows[0].source_item_id],
      );
      if (itemR.rows[0]) {
        await enforceSourceItemReadConsent({ db, identity, item: itemR.rows[0] });
      } else if (r.rows[0].connection_id) {
        // Item soft-deleted: fall back to connection gate so access is not silently opened.
        await enforceConnectionReadConsent(db, identity, r.rows[0].connection_id);
      } else {
        // Source item referenced but no longer exists and no connection fallback: fail closed.
        throw new HttpError(404, "Not found");
      }
    } else if (r.rows[0].connection_id) {
      // Connection-only snapshot: enforce the connection's own consent gate.
      await enforceConnectionReadConsent(db, identity, r.rows[0].connection_id);
    }
    // Snapshot content comes from its artifact; verify the caller can read it.
    // This mirrors resolveSourceSnapshot so annotation gate matches document gate.
    if (r.rows[0].artifact_id) {
      await assertArtifactReadable(db, identity, r.rows[0].artifact_id, "Not found");
    }
    return {
      projectId: r.rows[0].project_id,
      visibility: persistedVisibility(r.rows[0].visibility),
      accessLevel: persistedAccessLevel(r.rows[0].access_level),
    };
  }
  if (documentType === "research_report") {
    const r = await db.query<{ project_id: string }>(
      `SELECT project_id FROM project_research_reports WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, documentId],
    );
    if (!r.rows[0] || !(await canAccessProject(db, identity.spaceId, r.rows[0].project_id, identity.userId))) {
      throw new HttpError(404, "Document not found");
    }
    return { projectId: r.rows[0].project_id, visibility: "space_shared", accessLevel: "full" };
  }
  if (documentType === "research_notebook") {
    const r = await db.query<{ project_id: string | null; visibility: string; access_level: string }>(
      `SELECT so.primary_project_id AS project_id, so.visibility, so.access_level FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id WHERE n.space_id=$1 AND n.object_id=$2`,
      [identity.spaceId, documentId],
    );
    if (!r.rows[0]?.project_id || !(await canAccessProject(db, identity.spaceId, r.rows[0].project_id, identity.userId))) throw new HttpError(404, "Document not found");
    return {
      projectId: r.rows[0].project_id,
      visibility: persistedVisibility(r.rows[0].visibility),
      accessLevel: persistedAccessLevel(r.rows[0].access_level),
    };
  }
  throw new HttpError(400, `Unsupported document type: ${documentType}`);
}

/**
 * Tries to verify that normalizedText.slice(start, end) === quoteText using only
 * inline artifact content (no file I/O). Returns 'verified' on match, 'unverified'
 * if content is unavailable or the slice doesn't match.
 */
async function tryVerifyAnchorRange(
  db: Queryable,
  identity: SpaceUserIdentity,
  documentType: string,
  documentId: string,
  start: number,
  end: number,
  quoteText: string,
): Promise<"verified" | "unverified"> {
  try {
    let artifactId: string | null = null;
    let inlineText: string | null = null;

    if (documentType === "source_item") {
      const r = await db.query<{ extracted_artifact_id: string | null; excerpt: string | null }>(
        `SELECT extracted_artifact_id, excerpt FROM source_items WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [identity.spaceId, documentId],
      );
      if (!r.rows[0]) return "unverified";
      if (r.rows[0].extracted_artifact_id) {
        artifactId = r.rows[0].extracted_artifact_id;
      } else if (r.rows[0].excerpt) {
        inlineText = r.rows[0].excerpt;
      }
    } else if (documentType === "source_snapshot") {
      const r = await db.query<{ artifact_id: string | null }>(
        `SELECT artifact_id FROM source_snapshots WHERE space_id = $1 AND id = $2`,
        [identity.spaceId, documentId],
      );
      artifactId = r.rows[0]?.artifact_id ?? null;
    } else if (documentType === "research_report") {
      const r = await db.query<{ normalized_text: string }>(
        `SELECT normalized_text FROM project_research_reports WHERE space_id = $1 AND id = $2`,
        [identity.spaceId, documentId],
      );
      inlineText = r.rows[0]?.normalized_text ?? null;
    } else if (documentType === "research_notebook") {
      const r = await db.query<{ plain_text: string | null }>(`SELECT plain_text FROM notes WHERE space_id=$1 AND object_id=$2`, [identity.spaceId, documentId]);
      inlineText = r.rows[0]?.plain_text ?? null;
    }

    if (artifactId && !inlineText) {
      const r = await db.query<{ content: string | null; mime_type: string | null }>(
        `SELECT content, mime_type FROM artifacts WHERE id = $1 AND space_id = $2`,
        [artifactId, identity.spaceId],
      );
      if (!r.rows[0]?.content) return "unverified";
      const mimeType = r.rows[0].mime_type;
      if (mimeType !== "application/json") return "unverified";
      const structured = parseStructuredReaderContent(r.rows[0].content);
      if (!structured) return "unverified";
      inlineText = structured.plain_text;
    }

    if (!inlineText) return "unverified";
    const normalizedText = normalizeReaderText(inlineText);
    // JS string indexing is UTF-16 code units, matching the anchor text_range.unit='utf16' contract.
    return normalizedText.slice(start, end) === quoteText ? "verified" : "unverified";
  } catch {
    return "unverified";
  }
}

export class PgAnnotationRepository {
  constructor(
    private readonly db: Queryable,
  ) {}

  async listAnnotations(
    identity: SpaceUserIdentity,
    documentType: string,
    documentId: string,
  ): Promise<ReaderAnnotationOut[]> {
    // Verify caller can read the underlying document before returning any annotations.
    await assertDocumentReadable(this.db, identity, documentType, documentId);

    const result = await this.db.query<ReaderAnnotationRow>(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM reader_annotations ra
        WHERE space_id = $1
          AND document_type = $2
          AND document_id = $3
          AND status = 'active'
          AND ${contentReadSql("reader_annotation", "ra", "$4")}
        ORDER BY created_at ASC`,
      [identity.spaceId, documentType, documentId, identity.userId],
    );
    return result.rows.map(annotationOut);
  }

  async createAnnotation(
    identity: SpaceUserIdentity,
    body: Record<string, unknown>,
  ): Promise<ReaderAnnotationOut> {
    const annotationType = optionalString(body.annotation_type);
    if (!annotationType || !ANNOTATION_TYPES.has(annotationType)) {
      throw new HttpError(422, "annotation_type must be one of: highlight, comment, excerpt, bookmark");
    }
    const quoteText = optionalString(body.quote_text);
    if (!quoteText) throw new HttpError(422, "quote_text is required");

    const anchor = body.anchor_json;
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
      throw new HttpError(422, "anchor_json must be an object");
    }
    const anchorObj = anchor as Record<string, unknown>;
    if (anchorObj.schema_version !== 1) {
      throw new HttpError(422, "anchor_json.schema_version must be 1");
    }
    if (anchorObj.quote_text !== quoteText) {
      throw new HttpError(422, "anchor_json.quote_text must match quote_text");
    }
    const textRange = anchorObj.text_range as Record<string, unknown> | null | undefined;
    if (!textRange || typeof textRange.start !== "number" || typeof textRange.end !== "number" || textRange.unit !== "utf16") {
      throw new HttpError(422, "anchor_json.text_range must include start, end (numbers), and unit='utf16'");
    }
    const rangeStart = textRange.start as number;
    const rangeEnd = textRange.end as number;
    if (rangeStart < 0) throw new HttpError(422, "anchor_json.text_range.start must be >= 0");
    if (rangeEnd <= rangeStart) throw new HttpError(422, "anchor_json.text_range.end must be > start");

    if (anchorObj.before_context === undefined || anchorObj.after_context === undefined) {
      throw new HttpError(422, "anchor_json.before_context and after_context are required");
    }

    const documentType = optionalString(body.document_type);
    const documentId = optionalString(body.document_id);
    if (!documentType || !["source_item", "source_snapshot", "research_report", "research_notebook"].includes(documentType)) {
      throw new HttpError(422, "document_type must be source_item, source_snapshot, research_report, or research_notebook");
    }
    if (!documentId) throw new HttpError(422, "document_id is required");
    if (body.project_id !== undefined) {
      throw new HttpError(422, "Annotation Project scope is inherited from its document");
    }
    const documentAccess = await assertDocumentReadable(this.db, identity, documentType, documentId);

    // Attempt lightweight text verification using inline artifact content only (no file I/O).
    // Falls through to 'unverified' if content is not stored inline or doesn't match.
    const anchorState = await tryVerifyAnchorRange(
      this.db, identity, documentType, documentId, rangeStart, rangeEnd, quoteText,
    );

    // ADR 0013 decision 3a: an annotation is personal marginalia. Its Project
    // scope is the document's, but its visibility defaults to `private` even on
    // a shared document. Sharing is opt-in and can never exceed the document's
    // own visibility, so an annotation cannot out-share what it annotates.
    const visibility = annotationVisibility(
      optionalString(body.visibility),
      documentAccess.visibility,
    );

    const color = optionalString(body.color);
    const label = optionalString(body.label);
    const now = new Date().toISOString();
    const id = randomUUID();

    const result = await this.db.query<ReaderAnnotationRow>(
      `INSERT INTO reader_annotations (
         id, space_id, project_id, document_type, document_id,
         annotation_type, quote_text, anchor_json, color, label,
         visibility, access_level, status, anchor_state, created_by_user_id, owner_user_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::jsonb, $9, $10,
         $11, $12, 'active', $13, $14, $14, $15, $15
       ) RETURNING ${ANNOTATION_COLUMNS}`,
      [
        id, identity.spaceId, documentAccess.projectId, documentType, documentId,
        annotationType, quoteText, JSON.stringify(anchorObj), color, label,
        visibility, documentAccess.accessLevel, anchorState, identity.userId, now,
      ],
    );
    const annotation = result.rows[0]!;
    if (visibility === "selected_users") {
      const sourceResourceType = documentType === "research_notebook" ? "space_object" : documentType;
      await inheritContentAccessGrants(this.db, {
        spaceId: identity.spaceId,
        sourceResourceType,
        sourceResourceId: documentId,
        targetResourceType: "reader_annotation",
        targetResourceId: annotation.id,
        inheritedAt: now,
      });
    }
    return annotationOut(annotation);
  }

  async updateAnnotation(
    identity: SpaceUserIdentity,
    annotationId: string,
    body: Record<string, unknown>,
  ): Promise<ReaderAnnotationOut> {
    const row = await this.getAnnotationRow(identity.spaceId, annotationId);
    if (!row) throw new HttpError(404, "Annotation not found");
    if (row.created_by_user_id !== identity.userId) throw new HttpError(404, "Not found");

    const sets: string[] = [];
    const params: unknown[] = [identity.spaceId, annotationId];
    if (body.visibility !== undefined || body.access_level !== undefined || body.grants !== undefined) {
      throw new HttpError(422, "Use the content-access API to update annotation permissions");
    }

    const color = optionalString(body.color);
    if (body.color !== undefined) { params.push(color); sets.push(`color = $${params.length}`); }

    const label = optionalString(body.label);
    if (body.label !== undefined) { params.push(label); sets.push(`label = $${params.length}`); }

    const status = optionalString(body.status);
    if (status !== null && status !== undefined) {
      if (status !== "active" && status !== "archived") throw new HttpError(422, "Invalid status");
      params.push(status); sets.push(`status = $${params.length}`);
    }

    if (sets.length === 0) throw new HttpError(422, "No fields to update");

    params.push(new Date().toISOString());
    sets.push(`updated_at = $${params.length}`);

    const result = await this.db.query<ReaderAnnotationRow>(
      `UPDATE reader_annotations SET ${sets.join(", ")}
        WHERE space_id = $1 AND id = $2 RETURNING ${ANNOTATION_COLUMNS}`,
      params,
    );
    return annotationOut(result.rows[0]!);
  }

  async archiveAnnotation(
    identity: SpaceUserIdentity,
    annotationId: string,
  ): Promise<void> {
    const row = await this.getAnnotationRow(identity.spaceId, annotationId);
    if (!row) throw new HttpError(404, "Annotation not found");
    if (row.created_by_user_id !== identity.userId) throw new HttpError(404, "Not found");
    await this.db.query(
      `UPDATE reader_annotations SET status = 'archived', updated_at = $3 WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, annotationId, new Date().toISOString()],
    );
  }

  private async getAnnotationRow(spaceId: string, annotationId: string): Promise<ReaderAnnotationRow | null> {
    const result = await this.db.query<ReaderAnnotationRow>(
      `SELECT ${ANNOTATION_COLUMNS} FROM reader_annotations WHERE space_id = $1 AND id = $2`,
      [spaceId, annotationId],
    );
    return result.rows[0] ?? null;
  }
}

// ── Comment/Thread repository ─────────────────────────────────────────────────

export interface ReaderCommentThreadRow {
  id: string;
  space_id: string;
  annotation_id: string;
  status: string;
  created_by_user_id: string;
  created_at: unknown;
  updated_at: unknown;
}

export interface ReaderCommentRow {
  id: string;
  space_id: string;
  thread_id: string;
  body: string;
  status: string;
  created_by_user_id: string;
  created_at: unknown;
  updated_at: unknown;
}

export interface ReaderCommentThreadOut {
  id: string;
  space_id: string;
  annotation_id: string;
  status: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  comments: ReaderCommentOut[];
}

export interface ReaderCommentOut {
  id: string;
  space_id: string;
  thread_id: string;
  body: string;
  status: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

const THREAD_COLUMNS = `id, space_id, annotation_id, status, created_by_user_id, created_at, updated_at`;
const COMMENT_COLUMNS = `id, space_id, thread_id, body, status, created_by_user_id, created_at, updated_at`;
const THREAD_STATUSES = new Set(["open", "resolved", "archived"]);

function threadOut(row: ReaderCommentThreadRow, comments: ReaderCommentOut[]): ReaderCommentThreadOut {
  return {
    id: row.id,
    space_id: row.space_id,
    annotation_id: row.annotation_id,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
    comments,
  };
}

function commentOut(row: ReaderCommentRow): ReaderCommentOut {
  return {
    id: row.id,
    space_id: row.space_id,
    thread_id: row.thread_id,
    body: row.body,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export class PgCommentRepository {
  constructor(
    private readonly db: Queryable,
  ) {}

  async listThreads(
    identity: SpaceUserIdentity,
    annotationId: string,
  ): Promise<ReaderCommentThreadOut[]> {
    // Verify annotation is visible to caller before exposing its threads.
    const annResult = await this.db.query<ReaderAnnotationRow>(
      `SELECT ${ANNOTATION_COLUMNS} FROM reader_annotations WHERE space_id = $1 AND id = $2 AND status = 'active'`,
      [identity.spaceId, annotationId],
    );
    const ann = annResult.rows[0];
    if (!ann) throw new HttpError(404, "Annotation not found");
    await assertAnnotationReadable(this.db, identity, ann);
    // Also verify the caller can still read the underlying document (e.g. space_shared
    // annotations remain accessible only while the document itself is accessible).
    const annDoc = annotationDocumentTarget(ann);
    if (annDoc) {
      await assertDocumentReadable(this.db, identity, annDoc.documentType, annDoc.documentId);
    }

    const threadResult = await this.db.query<ReaderCommentThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM reader_comment_threads
        WHERE space_id = $1 AND annotation_id = $2 AND status != 'archived'
        ORDER BY created_at ASC`,
      [identity.spaceId, annotationId],
    );
    const threads = threadResult.rows;
    if (threads.length === 0) return [];

    const threadIds = threads.map((t) => t.id);
    const placeholders = threadIds.map((_, i) => `$${i + 2}`).join(", ");
    const commentResult = await this.db.query<ReaderCommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM reader_comments
        WHERE space_id = $1 AND thread_id IN (${placeholders}) AND status = 'active'
        ORDER BY created_at ASC`,
      [identity.spaceId, ...threadIds],
    );

    const byThread = new Map<string, ReaderCommentOut[]>();
    for (const c of commentResult.rows) {
      const list = byThread.get(c.thread_id) ?? [];
      list.push(commentOut(c));
      byThread.set(c.thread_id, list);
    }

    return threads.map((t) => threadOut(t, byThread.get(t.id) ?? []));
  }

  async createComment(
    identity: SpaceUserIdentity,
    annotationId: string,
    body: Record<string, unknown>,
  ): Promise<{ thread: ReaderCommentThreadOut }> {
    const annotation = await this.db.query<ReaderAnnotationRow>(
      `SELECT ${ANNOTATION_COLUMNS} FROM reader_annotations WHERE space_id = $1 AND id = $2 AND status = 'active'`,
      [identity.spaceId, annotationId],
    );
    const ann = annotation.rows[0];
    if (!ann) throw new HttpError(404, "Annotation not found");

    await assertAnnotationReadable(this.db, identity, ann);
    const annDoc = annotationDocumentTarget(ann);
    if (annDoc) {
      await assertDocumentReadable(this.db, identity, annDoc.documentType, annDoc.documentId);
    }

    const commentBody = optionalString(body.body);
    if (!commentBody) throw new HttpError(422, "body is required");

    const now = new Date().toISOString();

    // Create or reuse open thread
    let threadRow: ReaderCommentThreadRow;
    const existingThread = await this.db.query<ReaderCommentThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM reader_comment_threads
        WHERE space_id = $1 AND annotation_id = $2 AND status = 'open' LIMIT 1`,
      [identity.spaceId, annotationId],
    );
    if (existingThread.rows[0]) {
      threadRow = existingThread.rows[0];
    } else {
      const threadResult = await this.db.query<ReaderCommentThreadRow>(
        `INSERT INTO reader_comment_threads (id, space_id, annotation_id, status, created_by_user_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'open', $4, $5, $5) RETURNING ${THREAD_COLUMNS}`,
        [randomUUID(), identity.spaceId, annotationId, identity.userId, now],
      );
      threadRow = threadResult.rows[0]!;
    }

    await this.db.query(
      `INSERT INTO reader_comments (id, space_id, thread_id, body, status, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $6)`,
      [randomUUID(), identity.spaceId, threadRow.id, commentBody, identity.userId, now],
    );

    await this.db.query(
      `UPDATE reader_comment_threads SET updated_at = $3 WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, threadRow.id, now],
    );

    const allComments = await this.db.query<ReaderCommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM reader_comments WHERE space_id = $1 AND thread_id = $2 AND status = 'active' ORDER BY created_at ASC`,
      [identity.spaceId, threadRow.id],
    );

    return { thread: threadOut(threadRow, allComments.rows.map(commentOut)) };
  }

  async updateComment(
    identity: SpaceUserIdentity,
    commentId: string,
    body: Record<string, unknown>,
  ): Promise<ReaderCommentOut> {
    const result = await this.db.query<ReaderCommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM reader_comments WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, commentId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Comment not found");
    if (row.created_by_user_id !== identity.userId) throw new HttpError(404, "Not found");

    const newBody = optionalString(body.body);
    const status = optionalString(body.status);

    const sets: string[] = [];
    const params: unknown[] = [identity.spaceId, commentId];
    if (newBody !== null && newBody !== undefined) {
      params.push(newBody); sets.push(`body = $${params.length}`);
    }
    if (status !== null && status !== undefined) {
      if (status !== "active" && status !== "archived") throw new HttpError(422, "Invalid status");
      params.push(status); sets.push(`status = $${params.length}`);
    }
    if (sets.length === 0) throw new HttpError(422, "No fields to update");
    params.push(new Date().toISOString()); sets.push(`updated_at = $${params.length}`);

    const updated = await this.db.query<ReaderCommentRow>(
      `UPDATE reader_comments SET ${sets.join(", ")} WHERE space_id = $1 AND id = $2 RETURNING ${COMMENT_COLUMNS}`,
      params,
    );
    return commentOut(updated.rows[0]!);
  }

  async updateThread(
    identity: SpaceUserIdentity,
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<ReaderCommentThreadOut> {
    const result = await this.db.query<ReaderCommentThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM reader_comment_threads WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, threadId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Thread not found");

    // Load full annotation to enforce visibility + document read gate.
    const annResult = await this.db.query<ReaderAnnotationRow>(
      `SELECT ${ANNOTATION_COLUMNS} FROM reader_annotations WHERE space_id = $1 AND id = $2 AND status = 'active'`,
      [identity.spaceId, row.annotation_id],
    );
    const ann = annResult.rows[0];
    if (!ann) throw new HttpError(404, "Not found");
    await assertAnnotationReadable(this.db, identity, ann);
    const annDoc = annotationDocumentTarget(ann);
    if (annDoc) {
      await assertDocumentReadable(this.db, identity, annDoc.documentType, annDoc.documentId);
    }
    // Only thread creator or annotation creator may change thread status.
    if (row.created_by_user_id !== identity.userId && ann.created_by_user_id !== identity.userId) {
      throw new HttpError(404, "Not found");
    }

    const status = optionalString(body.status);
    if (!status || !THREAD_STATUSES.has(status)) throw new HttpError(422, "status must be open, resolved, or archived");

    const now = new Date().toISOString();
    const updated = await this.db.query<ReaderCommentThreadRow>(
      `UPDATE reader_comment_threads SET status = $3, updated_at = $4 WHERE space_id = $1 AND id = $2 RETURNING ${THREAD_COLUMNS}`,
      [identity.spaceId, threadId, status, now],
    );

    const comments = await this.db.query<ReaderCommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM reader_comments WHERE space_id = $1 AND thread_id = $2 AND status = 'active' ORDER BY created_at ASC`,
      [identity.spaceId, threadId],
    );

    return threadOut(updated.rows[0]!, comments.rows.map(commentOut));
  }
}

// ── Reader action result types ─────────────────────────────────────────────────

export interface ReaderEvidenceResult {
  id: string;
  title: string;
  status: string;
  evidence_type: string;
  source_item_id: string | null;
  source_object_type: string;
  source_object_id: string;
}

export interface ReaderProposalResult {
  id: string;
  proposal_type: string;
  status: string;
  title: string;
}

// ── Reader action helpers ──────────────────────────────────────────────────────

async function loadAnnotationConnectionPolicy(
  db: Queryable,
  spaceId: string,
  ann: ReaderAnnotationRow,
): Promise<Record<string, unknown> | null> {
  if (ann.document_type === "source_item") {
    const r = await db.query<{ policy_json: unknown }>(
      `SELECT sc.policy_json
         FROM source_items ii
         JOIN source_connections sc ON sc.id = ii.connection_id
        WHERE ii.space_id = $1 AND ii.id = $2 AND ii.deleted_at IS NULL`,
      [spaceId, ann.document_id],
    );
    return (r.rows[0]?.policy_json as Record<string, unknown>) ?? null;
  }
  if (ann.document_type === "source_snapshot") {
    const r = await db.query<{ policy_json: unknown }>(
      `SELECT sc.policy_json
         FROM source_snapshots ss
         JOIN source_connections sc ON sc.id = ss.connection_id
        WHERE ss.space_id = $1 AND ss.id = $2`,
      [spaceId, ann.document_id],
    );
    return (r.rows[0]?.policy_json as Record<string, unknown>) ?? null;
  }
  return null;
}

// ── Reader actions and project summaries ───────────────────────────────────────

export class PgReaderActionRepository {
  constructor(private readonly db: Queryable) {}

  async createEvidence(
    identity: SpaceUserIdentity,
    annotationId: string,
    body: Record<string, unknown>,
  ): Promise<ReaderEvidenceResult> {
    const annResult = await this.db.query<ReaderAnnotationRow>(
      `SELECT ${ANNOTATION_COLUMNS} FROM reader_annotations WHERE space_id = $1 AND id = $2 AND status = 'active'`,
      [identity.spaceId, annotationId],
    );
    const ann = annResult.rows[0];
    if (!ann) throw new HttpError(404, "Not found");
    await assertAnnotationReadable(this.db, identity, ann);
    const doc = annotationDocumentTarget(ann);
    if (doc) await assertDocumentReadable(this.db, identity, doc.documentType, doc.documentId);

    const policyJson = await loadAnnotationConnectionPolicy(this.db, identity.spaceId, ann);
    if (policyJson) enforceSourceDerivedImportTarget(policyJson, "source_artifact");

    const title = optionalString(body.title) || ann.quote_text.slice(0, 80);
    const now = new Date().toISOString();
    const contentHash = sha256Hex(ann.quote_text);
    const originSourceItemId = doc?.documentType === "source_item"
      ? doc.documentId
      : doc?.documentType === "source_snapshot"
        ? (await this.db.query<{ source_item_id: string | null }>(
            `SELECT source_item_id FROM source_snapshots WHERE space_id=$1 AND id=$2`,
            [identity.spaceId, doc.documentId],
          )).rows[0]?.source_item_id ?? null
        : null;

    interface EvidenceRow {
      id: string; title: string; status: string; evidence_type: string;
      source_item_id: string | null; source_object_type: string; source_object_id: string;
    }
    const metadata = {
      annotation_id: ann.id,
      annotation_type: ann.annotation_type,
      document_type: doc?.documentType ?? null,
      document_id: doc?.documentId ?? null,
    };
    const evidenceId = await upsertCanonicalEvidence(this.db, {
      spaceId: identity.spaceId,
      projectId: ann.project_id,
      ownerUserId: ann.owner_user_id,
      visibility: ann.visibility,
      accessLevel: ann.access_level,
      // Annotation-derived Evidence is an ACL-bearing human observation, not
      // canonical Source content. Keeping it outside the SourceItem/hash
      // collision domain prevents private annotation provenance from being
      // merged into a differently visible canonical Evidence row.
      sourceItemId: null,
      originSourceItemId,
      sourceSnapshotId: doc?.documentType === "source_snapshot" ? doc.documentId : null,
      sourceObjectType: "reader_annotation",
      sourceObjectId: annotationId,
      evidenceType: "excerpt",
      title,
      contentExcerpt: ann.quote_text,
      contentHash,
      trustLevel: "normal",
      extractionMethod: "manual",
      status: "candidate",
      metadata,
      createdByUserId: identity.userId,
      observedAt: now,
    });
    const r = await this.db.query<EvidenceRow>(
      `SELECT id, title, status, evidence_type, source_item_id, source_object_type, source_object_id
         FROM extracted_evidence WHERE space_id=$1 AND id=$2`,
      [identity.spaceId, evidenceId],
    );
    if (ann.visibility === "selected_users") {
      await inheritContentAccessGrants(this.db, {
        spaceId: identity.spaceId,
        sourceResourceType: "reader_annotation",
        sourceResourceId: ann.id,
        targetResourceType: "extracted_evidence",
        targetResourceId: r.rows[0]!.id,
        inheritedAt: now,
      });
    }
    return r.rows[0]!;
  }

  async createProposal(
    identity: SpaceUserIdentity,
    annotationId: string,
    body: Record<string, unknown>,
  ): Promise<ReaderProposalResult> {
    const annResult = await this.db.query<ReaderAnnotationRow>(
      `SELECT ${ANNOTATION_COLUMNS} FROM reader_annotations WHERE space_id = $1 AND id = $2 AND status = 'active'`,
      [identity.spaceId, annotationId],
    );
    const ann = annResult.rows[0];
    if (!ann) throw new HttpError(404, "Not found");
    await assertAnnotationReadable(this.db, identity, ann);
    const doc = annotationDocumentTarget(ann);
    if (doc) await assertDocumentReadable(this.db, identity, doc.documentType, doc.documentId);

    const proposalType = optionalString(body.proposal_type);
    if (proposalType !== "memory_create" && proposalType !== "knowledge_create") {
      throw new HttpError(422, "proposal_type must be memory_create or knowledge_create");
    }

    const policyJson = await loadAnnotationConnectionPolicy(this.db, identity.spaceId, ann);
    if (policyJson) {
      const target = proposalType === "memory_create" ? "memory_proposal" : "knowledge";
      enforceSourceDerivedImportTarget(policyJson, target as "memory_proposal" | "knowledge");
    }

    const title = optionalString(body.title) || ann.quote_text.slice(0, 80);
    const rationale = optionalString(body.rationale) ?? "Created from reader annotation.";
    const sourceRefs = [
      { source_type: "reader_annotation", source_id: ann.id, source_trust: "untrusted_external" },
      ...(doc ? [{ source_type: doc.documentType, source_id: doc.documentId, source_trust: "untrusted_external" }] : []),
    ];

    const payload = proposalType === "knowledge_create"
      ? {
          operation: "create",
          knowledge_kind: "summary",
          title,
          content: ann.quote_text,
          content_format: "plain",
          visibility: "private",
          source_refs: sourceRefs,
        }
      : {
          operation: "create",
          proposed_content: ann.quote_text,
          memory_type: "experience",
          target_scope: "user",
          target_namespace: "source.annotation",
          provenance_entries: sourceRefs,
        };

    const row = await insertProposalRow(this.db, {
      spaceId: identity.spaceId,
      proposalType,
      title,
      payload,
      rationale,
      createdByUserId: identity.userId,
      visibility: ann.visibility,
      accessLevel: ann.access_level === "summary" ? "summary" : "full",
      riskLevel: "low",
    });
    if (ann.visibility === "selected_users") {
      await inheritContentAccessGrants(this.db, {
        spaceId: identity.spaceId,
        sourceResourceType: "reader_annotation",
        sourceResourceId: ann.id,
        targetResourceType: "proposal",
        targetResourceId: row.id,
        inheritedAt: new Date().toISOString(),
      });
    }

    return { id: row.id, proposal_type: row.proposal_type, status: row.status, title: row.title };
  }

  async listProjectAnnotations(
    identity: SpaceUserIdentity,
    projectId: string,
    limit: number,
  ): Promise<ReaderAnnotationOut[]> {
    if (!(await canAccessProject(this.db, identity.spaceId, projectId, identity.userId))) {
      throw new HttpError(404, "Project not found");
    }
    // Prefix all annotation columns with ra. to avoid ambiguity with joined tables.
    const cols = `ra.id, ra.space_id, ra.document_type, ra.document_id,
  ra.annotation_type, ra.quote_text, ra.anchor_json, ra.color, ra.label, ra.visibility, ra.access_level,
  ra.status, ra.anchor_state, ra.created_by_user_id, ra.owner_user_id, ra.created_at, ra.updated_at`;
    const r = await this.db.query<ReaderAnnotationRow>(
      `SELECT ${cols}
         FROM reader_annotations ra
         JOIN source_items ii ON ii.id = ra.document_id AND ra.document_type = 'source_item'
              AND ii.space_id = $1 AND ii.deleted_at IS NULL
         JOIN source_connections sc ON sc.id = ii.connection_id
         JOIN project_source_item_links psil
              ON psil.space_id = ii.space_id
             AND psil.source_item_id = ii.id
             AND psil.project_id = $2
             AND psil.status = 'active'
         JOIN project_source_bindings psb
              ON psb.space_id = psil.space_id
             AND psb.id = psil.project_source_binding_id
             AND psb.status = 'active'
        WHERE ra.space_id = $1
          AND ra.status = 'active'
          AND ${contentReadSql("reader_annotation", "ra", "$3")}
          AND ${contentReadSql("source_item", "ii", "$3")}
          AND (
            sc.consent_json->>'owner_user_id' = $3
            OR sc.consent_json->'allowed_reader_user_ids' @> to_jsonb($3::text)
            OR (
              (sc.consent_json->>'allow_space_admins')::boolean = true
              AND EXISTS (
                SELECT 1 FROM space_memberships sm
                 WHERE sm.user_id = $3 AND sm.space_id = $1
                   AND sm.status = 'active' AND sm.role IN ('owner', 'admin')
              )
            )
          )
        ORDER BY ra.created_at DESC
        LIMIT $4`,
      [identity.spaceId, projectId, identity.userId, limit],
    );
    return r.rows.map(annotationOut);
  }
}
