import { checkLinkTypeAllowed } from "../ontology/validation";
import { hasDeclaration } from "../ontology/linkTypes";
import { buildSpaceObjectInsert } from "../../db/spaceObjectWriter";
import { objectStatusScalarSql } from "../../db/objectStatusSql";
import { createHash, randomUUID } from "node:crypto";
import type {
  ProposalApplyContext,
  ProposalApplyResult,
} from "../proposals/applierRegistry";
import {
  writeProvenanceLinks,
  type Queryable,
} from "../memory/memoryApplyProvenance";
import { PgJobQueueRepository } from "../jobs/repository";
import { RetrievalProjectionService } from "../retrieval";
import { enqueueRetrievalEmbeddingBackfillWithQueue } from "../retrieval/embedding/job";
import { knowledgeRetrievalRegistry } from "./retrievalAdapter";
import {
  RELATION_CREATE_STATUSES,
  claimCreateStatusError,
  claimResolutionStateError,
  claimStatusTransitionError,
} from "./claimStatusRules";
import {
  isKnowledgeRetrievalObjectType,
  isKnowledgeRetrievalProjectedRelation,
} from "./retrievalObjectTypes";
import { RETRIEVAL_OBJECT_TYPE_VALUES } from "../retrieval/objectTypes";
import { allowedObjectProfileKeys } from "../ontology/objectProfileSubtypeKeys";
import { isContentOwner } from "../access/contentAccessPolicy";
import { contentDecisionFromDb } from "../access/contentAccessQuery";
import { isProvenanceSourceType } from "../ontology/entities";

// The retrieval projection is a derived index. A projection failure must not
// roll back an accepted canonical Knowledge mutation, but the reindex runs
// inside the apply transaction, so a thrown query would otherwise abort it. We
// isolate the reindex in a SAVEPOINT: on failure we roll back only the
// projection work and let the canonical apply commit.
async function reindexWithinApply(
  context: ProposalApplyContext,
  run: (projection: RetrievalProjectionService) => Promise<void>,
): Promise<void> {
  const db = context.db;
  await db.query("SAVEPOINT retrieval_reindex");
  try {
    await run(new RetrievalProjectionService(db, knowledgeRetrievalRegistry));
    await db.query("RELEASE SAVEPOINT retrieval_reindex");
    // Only create/update add or change chunk text. Archive and relation
    // changes either drop chunks or touch only edges, so there is nothing new
    // to embed — skip the backfill enqueue for those.
    if (
      context.proposal.proposal_type === "knowledge_create" ||
      context.proposal.proposal_type === "knowledge_update" ||
      context.proposal.proposal_type === "claim_create" ||
      context.proposal.proposal_type === "claim_update"
    ) {
      await enqueueKnowledgeRetrievalEmbeddingBackfill(context);
    }
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT retrieval_reindex").catch(() => undefined);
    await db.query("RELEASE SAVEPOINT retrieval_reindex").catch(() => undefined);
    process.stderr.write(
      `[knowledge.retrieval] reindex failed during proposal apply: ${String((error as Error)?.message ?? error)}\n`,
    );
  }
}

async function enqueueKnowledgeRetrievalEmbeddingBackfill(
  context: ProposalApplyContext,
): Promise<void> {
  let savepointStarted = false;
  try {
    await context.db.query("SAVEPOINT retrieval_embedding_enqueue");
    savepointStarted = true;
    await enqueueRetrievalEmbeddingBackfillWithQueue(new PgJobQueueRepository(context.db), {
      spaceId: context.proposal.space_id,
      userId: context.userId,
      trigger: "knowledge_proposal_apply",
      proposalId: context.proposal.id,
    });
    await context.db.query("RELEASE SAVEPOINT retrieval_embedding_enqueue");
    savepointStarted = false;
  } catch (error) {
    if (savepointStarted) {
      await context.db.query("ROLLBACK TO SAVEPOINT retrieval_embedding_enqueue").catch(() => undefined);
      await context.db.query("RELEASE SAVEPOINT retrieval_embedding_enqueue").catch(() => undefined);
    }
    process.stderr.write(
      `[knowledge.retrieval] embedding backfill enqueue failed during proposal apply: ${String((error as Error)?.message ?? error)}\n`,
    );
  }
}

interface ProposalApplierRegistrar {
  register(
    proposalType: string,
    applier: (context: ProposalApplyContext) => Promise<ProposalApplyResult>,
  ): void;
}

interface KnowledgeItemRow {
  id: string;
  space_id: string;
  project_id: string | null;
  project_folder_id: string | null;
  root_item_id: string | null;
  supersedes_item_id: string | null;
  redirect_to_item_id: string | null;
  knowledge_kind: string;
  slug: string | null;
  aliases_json: unknown;
  title: string;
  content: string;
  content_json: unknown | null;
  content_format: string;
  content_schema_version: string | number;
  plain_text: string | null;
  excerpt: string | null;
  status: string;
  visibility: string;
  verification_status: string;
  reflection_status: string;
  tags_json: unknown;
  confidence: number | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_run_id: string | null;
  created_from_proposal_id: string | null;
  approved_by_user_id: string | null;
  version: string | number;
  pinned_source_ref_json: unknown;
  archived_at: string | null;
  deprecated_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ClaimRow {
  id: string;
  space_id: string;
  subject_object_id: string | null;
  subject_text: string | null;
  claim_kind: string;
  claim_text: string;
  normalized_claim_hash: string;
  holder_object_id: string | null;
  holder_type: string | null;
  holder_id: string | null;
  confidence: number | null;
  confidence_method: string;
  resolution_state: string;
  valid_from: string | null;
  valid_until: string | null;
  observed_at: string | null;
  metadata_json: unknown;
  status: string;
  visibility: string;
  title: string;
  excerpt: string | null;
  owner_user_id: string | null;
  project_id: string | null;
  project_folder_id: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_run_id: string | null;
  created_from_proposal_id: string | null;
  approved_by_user_id: string | null;
  archived_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ClaimSourceRow {
  id: string;
  space_id: string;
  claim_id: string;
  source_object_id: string | null;
  source_ref_type: string | null;
  source_ref_id: string | null;
  source_connection_id: string | null;
  source_policy_snapshot_json: unknown;
  locator: string | null;
  quote_excerpt: string | null;
  evidence_role: string;
  source_trust: string | null;
  confidence: number | null;
  metadata_json: unknown;
  created_by_user_id: string | null;
  created_at: string | null;
}

interface ObjectRelationRow {
  id: string;
  space_id: string;
  from_object_id: string;
  from_object_type: string | null;
  to_object_id: string;
  to_object_type: string | null;
  link_type: string;
  status: string;
  confidence: number | null;
  evidence_summary: string | null;
  source_claim_id: string | null;
  source_object_id: string | null;
  source_proposal_id: string | null;
  metadata_json: unknown;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SpaceObjectProfileRow {
  id: string;
  space_id: string;
  key: string;
  label: string;
  description: string | null;
  base_object_type: string;
  status: string;
  version: string | number;
  field_schema_json: unknown;
  extraction_policy_json: unknown;
  retrieval_policy_json: unknown;
  ui_config_json: unknown;
  created_by_user_id: string | null;
  created_from_proposal_id: string | null;
  updated_from_proposal_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SpaceObjectRow {
  id: string;
  space_id: string;
  object_type: string;
  title: string;
  status: string;
  visibility: string;
  owner_user_id: string | null;
  primary_project_id: string | null;
  project_folder_id: string | null;
  created_by_user_id: string | null;
}

interface ProvenanceEntry {
  source_type: string;
  source_id: string;
  source_trust?: string;
  evidence_json?: Record<string, unknown>;
}

const VALID_KNOWLEDGE_KINDS = new Set([
  "concept",
  "lesson",
  "procedure",
  "decision",
  "question",
  "answer",
  "summary",
]);

const VALID_CONTENT_FORMATS = new Set(["markdown", "plain", "prosemirror_json"]);

const VALID_VISIBILITIES = new Set([
  "private",
  "space_shared",
  "selected_users",
]);

const VALID_VERIFICATION_STATUSES = new Set(["unverified", "needs_review", "verified"]);

const VALID_REFLECTION_STATUSES = new Set(["unreviewed", "reviewed", "distilled"]);


const VALID_CLAIM_KINDS = new Set([
  "fact",
  "hypothesis",
  "belief",
  "preference",
  "commitment",
  "question",
  "interpretation",
  "instruction",
  "metric",
  "relationship",
  "event",
]);

const VALID_CLAIM_STATUSES = new Set([
  "active",
  "disputed",
  "superseded",
  "rejected",
  "archived",
]);

const VALID_CLAIM_CONFIDENCE_METHODS = new Set([
  "human_confirmed",
  "source_extracted",
  "llm_extracted",
  "inferred",
  "imported",
]);

const VALID_CLAIM_RESOLUTION_STATES = new Set([
  "unreviewed",
  "confirmed",
  "contradicted",
  "stale",
  "needs_source",
]);

const VALID_CLAIM_EVIDENCE_ROLES = new Set([
  "supports",
  "contradicts",
  "mentions",
  "derived_from",
  "cites",
  "summarizes",
]);

const VALID_CLAIM_SOURCE_REF_TYPES = new Set([
  "activity",
  "artifact",
  "run_event",
  "extracted_evidence",
  "source_snapshot",
  "external_pointer",
  "source_item",
]);

const VALID_CLAIM_SOURCE_TRUST_LEVELS = new Set([
  "trusted",
  "normal",
  "untrusted",
  "unknown",
]);


const VALID_OBJECT_PROFILE_BASE_TYPES = new Set<string>(RETRIEVAL_OBJECT_TYPE_VALUES);
const CREATE_OBJECT_PROFILE_STATUSES = new Set(["draft", "active"]);
const OBJECT_PROFILE_RELATION_HINT_DIRECTIONS = new Set(["from", "to", "either"]);
const OBJECT_PROFILE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UNSAFE_OBJECT_PROFILE_CONFIG_KEY_TOKENS = new Set([
  "script",
  "scripts",
  "shell",
  "command",
  "commands",
  "sql",
  "query_sql",
  "regex",
  "regexp",
  "pattern",
  "patterns",
  "provider_tool",
  "provider_tools",
  "tool",
  "tools",
  "executable",
]);

// Was a fourth hand-maintained copy of the `provenance_links.source_type`
// list; it now defers to the single owner. The old copy silently *dropped*
// unrecognized entries, so a divergence lost provenance without an error.

const KNOWLEDGE_ITEM_COLUMNS = `
  ki.object_id AS id, ki.space_id, so.primary_project_id AS project_id,
  so.project_folder_id, ki.root_item_id, ki.supersedes_item_id,
  ki.redirect_to_item_id, ki.knowledge_kind, ki.slug, ki.aliases_json,
  so.title, ki.content, ki.content_json, ki.content_format,
  ki.content_schema_version, ki.plain_text, so.summary AS excerpt,
  ki.status, so.visibility, ki.verification_status, ki.reflection_status,
  ki.tags_json, ki.confidence, so.owner_user_id,
  so.created_by_user_id, so.created_by_agent_id, so.created_by_run_id,
  ki.created_from_proposal_id,
  ki.approved_by_user_id, ki.version, ki.pinned_source_ref_json, so.archived_at, ki.deprecated_at,
  so.created_at, so.updated_at
`;

const KNOWLEDGE_ITEM_FROM = `
  knowledge_items ki
  JOIN space_objects so
    ON so.id = ki.object_id
   AND so.space_id = ki.space_id
   AND so.object_type = 'knowledge_item'
`;

const CLAIM_COLUMNS = `
  c.object_id AS id, c.space_id, c.subject_object_id, c.subject_text,
  c.claim_kind, c.claim_text, c.normalized_claim_hash, c.holder_object_id,
  c.holder_type, c.holder_id, c.confidence, c.confidence_method,
  c.resolution_state, c.valid_from, c.valid_until, c.observed_at,
  c.metadata_json, c.status, so.visibility, so.title, so.summary AS excerpt,
  so.owner_user_id, so.primary_project_id AS project_id, so.project_folder_id,
  so.created_by_user_id, so.created_by_agent_id, so.created_by_run_id,
  c.created_from_proposal_id, c.approved_by_user_id, so.archived_at,
  so.created_at, so.updated_at
`;

const CLAIM_FROM = `
  claims c
  JOIN space_objects so
    ON so.id = c.object_id
   AND so.space_id = c.space_id
   AND so.object_type = 'claim'
`;

const CLAIM_SOURCE_COLUMNS = `
  id, space_id, claim_id, source_object_id, source_ref_type, source_ref_id,
  source_connection_id, source_policy_snapshot_json, locator, quote_excerpt,
  evidence_role, source_trust, confidence, metadata_json, created_by_user_id,
  created_at
`;

const OBJECT_RELATION_COLUMNS = `
  r.id, r.space_id,
  r.from_object_id, from_so.object_type AS from_object_type,
  r.to_object_id, to_so.object_type AS to_object_type,
  r.link_type, r.status, r.confidence, r.evidence_summary,
  r.source_claim_id, r.source_object_id, r.source_proposal_id,
  r.metadata_json, r.created_by_user_id, r.created_by_agent_id,
  r.created_at, r.updated_at
`;

const SPACE_OBJECT_PROFILE_COLUMNS = `
  id, space_id, key, label, description, base_object_type, status, version,
  field_schema_json, extraction_policy_json, retrieval_policy_json, ui_config_json,
  created_by_user_id, created_from_proposal_id, updated_from_proposal_id,
  created_at, updated_at
`;

const TARGET_KNOWLEDGE = "knowledge";

export function registerKnowledgeProposalAppliers(
  registry: ProposalApplierRegistrar,
): void {
  registry.register("knowledge_create", applyKnowledgeCreateProposal);
  registry.register("knowledge_update", applyKnowledgeUpdateProposal);
  registry.register("knowledge_archive", applyKnowledgeArchiveProposal);
  registry.register("claim_create", applyClaimCreateProposal);
  registry.register("claim_update", applyClaimUpdateProposal);
  registry.register("claim_archive", applyClaimArchiveProposal);
  registry.register("object_relation_create", applyObjectRelationCreateProposal);
  registry.register("object_relation_delete", applyObjectRelationDeleteProposal);
  registry.register("object_profile_create", applyObjectProfileCreateProposal);
  registry.register("object_profile_update", applyObjectProfileUpdateProposal);
  registry.register("object_profile_deprecate", applyObjectProfileDeprecateProposal);
  registry.register("object_profile_archive", applyObjectProfileArchiveProposal);
}

async function applyKnowledgeCreateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "create");

  const knowledgeKind = expectString(payload.knowledge_kind);
  if (!VALID_KNOWLEDGE_KINDS.has(knowledgeKind)) {
    throw new KnowledgeApplyValidationError(`invalid knowledge_kind: ${JSON.stringify(knowledgeKind)}`);
  }

  const title = expectString(payload.title);
  const content = expectString(payload.content);
  const contentFormat = optionalString(payload.content_format) ?? "markdown";
  if (!VALID_CONTENT_FORMATS.has(contentFormat)) {
    throw new KnowledgeApplyValidationError(`invalid content_format: ${JSON.stringify(contentFormat)}`);
  }

  const visibility = optionalString(payload.visibility) ?? "space_shared";
  if (!VALID_VISIBILITIES.has(visibility)) {
    throw new KnowledgeApplyValidationError(`invalid visibility: ${JSON.stringify(visibility)}`);
  }

  const verificationStatus = optionalString(payload.verification_status) ?? "unverified";
  if (!VALID_VERIFICATION_STATUSES.has(verificationStatus)) {
    throw new KnowledgeApplyValidationError(
      `invalid verification_status: ${JSON.stringify(verificationStatus)}`,
    );
  }

  const reflectionStatus = optionalString(payload.reflection_status) ?? "unreviewed";
  if (!VALID_REFLECTION_STATUSES.has(reflectionStatus)) {
    throw new KnowledgeApplyValidationError(
      `invalid reflection_status: ${JSON.stringify(reflectionStatus)}`,
    );
  }

  const requestedOwnerUserId = optionalString(payload.owner_user_id);
  if (
    requestedOwnerUserId !== null &&
    context.proposal.created_by_user_id !== null &&
    requestedOwnerUserId !== context.proposal.created_by_user_id
  ) {
    throw new KnowledgeApplyValidationError("Knowledge owner must be the proposal creator");
  }
  if (
    (visibility === "private" || visibility === "selected_users") &&
    context.proposal.created_by_user_id == null
  ) {
    throw new KnowledgeApplyValidationError("private or selected-user Knowledge requires a human owner");
  }

  const projectId = optionalString(payload.project_id);
  const projectFolderId = optionalString(payload.project_folder_id);
  const contentJson = optionalObject(payload.content_json);
  const aliases = toStringArray(payload.aliases);
  const tags = toStringArray(payload.tags);
  const confidence = parseConfidence(payload.confidence);
  const sourceRefs = provenanceEntriesFromPayload(payload.source_refs);
  const sourceRunId = optionalString(payload.source_run_id);
  const slug = optionalString(payload.slug);
  // Discriminated, immutable pointer to the exact source revision this
  // Knowledge version was promoted from — set only when the
  // proposal originated from modules/knowledgePromotion's Candidate accept
  // flow; a proposal authored any other way (agent tool call, manual API
  // use) simply has none.
  const pinnedSourceRef = optionalObject(payload.pinned_source_ref);

  const now = new Date().toISOString();
  const plainText = derivePlainText({ title, content, contentJson });
  const excerpt = plainText ? plainText.slice(0, 280) : null;
  const itemId = randomUUID();
  const object = buildSpaceObjectInsert({
    id: itemId,
    spaceId: context.proposal.space_id,
    objectType: "knowledge_item",
    title,
    summary: excerpt,
    visibility,
    ownerUserId: requestedOwnerUserId ?? context.proposal.created_by_user_id,
    primaryProjectId: projectId,
    projectFolderId,
    createdByUserId: context.proposal.created_by_user_id,
    createdByRunId: sourceRunId ?? context.proposal.created_by_run_id,
    createdAt: now,
  });
  const n = object.params.length;
  const row = await getKnowledgeRowsOrThrow<{ id: string }>(
    context.db,
    `WITH obj AS (
       ${object.sql}
     ), item AS (
       INSERT INTO knowledge_items (
         object_id, space_id, status, knowledge_kind, slug, aliases_json, content,
         content_json, content_format, content_schema_version, plain_text,
         verification_status, reflection_status, tags_json, confidence,
         created_from_proposal_id, approved_by_user_id, version, pinned_source_ref_json
       ) VALUES (
         $${n + 1}, $${n + 2}, 'active', $${n + 3}, $${n + 4}, $${n + 5}::jsonb, $${n + 6},
         $${n + 7}::jsonb, $${n + 8}, COALESCE($${n + 9}::int, 1), $${n + 10},
         $${n + 11}, $${n + 12}, $${n + 13}::jsonb, $${n + 14},
         $${n + 15}, $${n + 16}, 1, $${n + 17}::jsonb
       )
       RETURNING object_id AS id
     )
     SELECT id FROM item`,
    [
      ...object.params,
      itemId,
      context.proposal.space_id,
      knowledgeKind,
      slug,
      JSON.stringify(aliases),
      content,
      contentJson ? JSON.stringify(contentJson) : null,
      contentFormat,
      numberValue(payload.content_schema_version),
      plainText,
      verificationStatus,
      reflectionStatus,
      JSON.stringify(tags),
      confidence,
      context.proposal.id,
      context.userId,
      pinnedSourceRef ? JSON.stringify(pinnedSourceRef) : null,
    ],
  );

  await context.db.query(`UPDATE knowledge_items SET root_item_id = object_id WHERE object_id = $1 AND space_id = $2`, [
    row.id,
    context.proposal.space_id,
  ]);

  await writeSourceRefs({
    db: context.db,
    spaceId: context.proposal.space_id,
    targetId: row.id,
    entries: sourceRefs,
  });

  await reindexWithinApply(context, (projection) =>
    projection.reindex(context.proposal.space_id, "knowledge_item", row.id));

  const created = await getKnowledgeItemById(context.db, context.proposal.space_id, row.id);
  return {
    result_type: "knowledge_item",
    result: { knowledge_item: serializeKnowledgeItem(created) },
  };
}

async function applyKnowledgeUpdateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "update");

  const targetId = expectString(payload.target_item_id);
  const current = await requireKnowledgeItem(context.db, context.proposal.space_id, targetId, context.proposal);
  const title = expectString(payload.title);
  const content = expectString(payload.content);
  const contentJson = optionalObject(payload.content_json);
  const contentFormat = optionalString(payload.content_format) ?? current.content_format;
  if (!VALID_CONTENT_FORMATS.has(contentFormat)) {
    throw new KnowledgeApplyValidationError(`invalid content_format: ${JSON.stringify(contentFormat)}`);
  }

  const verificationStatus = optionalString(payload.verification_status) ?? current.verification_status;
  if (!VALID_VERIFICATION_STATUSES.has(verificationStatus)) {
    throw new KnowledgeApplyValidationError(
      `invalid verification_status: ${JSON.stringify(verificationStatus)}`,
    );
  }

  const reflectionStatus = optionalString(payload.reflection_status) ?? current.reflection_status;
  if (!VALID_REFLECTION_STATUSES.has(reflectionStatus)) {
    throw new KnowledgeApplyValidationError(
      `invalid reflection_status: ${JSON.stringify(reflectionStatus)}`,
    );
  }

  const confidence = parseConfidence(payload.confidence);
  const aliases = hasPayloadKey(payload, "aliases")
    ? toStringArray(payload.aliases)
    : [];
  const tags = hasPayloadKey(payload, "tags") ? toStringArray(payload.tags) : [];
  const sourceRefs = provenanceEntriesFromPayload(payload.source_refs);
  const slug = optionalString(payload.slug) ?? current.slug;
  const pinnedSourceRef = optionalObject(payload.pinned_source_ref);
  const now = new Date().toISOString();

  const itemId = randomUUID();
  const rootItemId = current.root_item_id ?? current.id;
  const plainText = derivePlainText({ title, content, contentJson });
  const excerpt = plainText.slice(0, 280);

  const newVersion = toNumber(current.version) + 1;
  const object = buildSpaceObjectInsert({
    id: itemId,
    spaceId: context.proposal.space_id,
    objectType: "knowledge_item",
    title,
    summary: excerpt,
    visibility: current.visibility,
    ownerUserId: current.owner_user_id,
    primaryProjectId: current.project_id,
    projectFolderId: current.project_folder_id,
    createdByUserId: context.proposal.created_by_user_id,
    createdByRunId: context.proposal.created_by_run_id,
    createdAt: now,
  });
  const n = object.params.length;
  const created = await getKnowledgeRowsOrThrow<{ id: string }>(
    context.db,
    `WITH obj AS (
       ${object.sql}
     ), item AS (
       INSERT INTO knowledge_items (
         object_id, space_id, status, root_item_id, supersedes_item_id,
         knowledge_kind, slug, aliases_json, content, content_json,
         content_format, content_schema_version, plain_text,
         verification_status, reflection_status, tags_json, confidence,
         created_from_proposal_id, approved_by_user_id, version, pinned_source_ref_json
       ) VALUES (
         $${n + 1}, $${n + 2}, 'active', $${n + 3}, $${n + 4},
         $${n + 5}, $${n + 6}, $${n + 7}::jsonb, $${n + 8}, $${n + 9}::jsonb,
         $${n + 10}, $${n + 11}, $${n + 12},
         $${n + 13}, $${n + 14}, $${n + 15}::jsonb, $${n + 16},
         $${n + 17}, $${n + 18}, $${n + 19}, $${n + 20}::jsonb
       )
       RETURNING object_id AS id
     )
     SELECT id FROM item`,
    [
      ...object.params,
      itemId,
      context.proposal.space_id,
      rootItemId,
      current.id,
      current.knowledge_kind,
      slug,
      JSON.stringify(aliases),
      content,
      contentJson ? JSON.stringify(contentJson) : null,
      contentFormat,
      numberValue(payload.content_schema_version) ?? toNumber(current.content_schema_version),
      plainText,
      verificationStatus,
      reflectionStatus,
      JSON.stringify(tags),
      confidence,
      context.proposal.id,
      context.userId,
      newVersion,
      pinnedSourceRef ? JSON.stringify(pinnedSourceRef) : null,
    ],
  );

  await context.db.query(
    `WITH item AS (
       UPDATE knowledge_items SET status = 'superseded'
        WHERE object_id = $1 AND space_id = $3
     )
     UPDATE space_objects
        SET updated_at = $2
      WHERE id = $1 AND space_id = $3 AND object_type = 'knowledge_item'`,
    [current.id, now, context.proposal.space_id],
  );

  const updateTargetId = created.id;

  await writeSourceRefs({
    db: context.db,
    spaceId: context.proposal.space_id,
    targetId: updateTargetId,
    entries: sourceRefs,
  });

  await reindexWithinApply(context, async (projection) => {
    await projection.deleteProjectionForObject(context.proposal.space_id, "knowledge_item", current.id);
    await projection.reindex(context.proposal.space_id, "knowledge_item", updateTargetId);
  });

  const row = await getKnowledgeItemById(context.db, context.proposal.space_id, itemId);
  return {
    result_type: "knowledge_item",
    result: { knowledge_item: serializeKnowledgeItem(row) },
  };
}

async function applyKnowledgeArchiveProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "archive");

  const targetId = expectString(payload.target_item_id);
  const item = await requireKnowledgeItem(context.db, context.proposal.space_id, targetId, context.proposal);
  if (item.status !== "active" && item.status !== "draft") {
    throw new KnowledgeApplyValidationError("target Knowledge item is not active");
  }

  const now = new Date().toISOString();
  await context.db.query(
    `WITH item AS (
       UPDATE knowledge_items SET status = 'archived'
        WHERE object_id = $1 AND space_id = $3
     )
     UPDATE space_objects
      SET archived_at = $2, updated_at = $2
     WHERE id = $1 AND space_id = $3 AND object_type = 'knowledge_item'`,
    [targetId, now, context.proposal.space_id],
  );

  await reindexWithinApply(context, (projection) =>
    projection.deleteProjectionForObject(context.proposal.space_id, "knowledge_item", targetId));

  const row = await getKnowledgeItemById(context.db, context.proposal.space_id, targetId);
  return {
    result_type: "knowledge_item",
    result: { knowledge_item: serializeKnowledgeItem(row) },
  };
}

async function applyClaimCreateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "claim_create");

  const claimKind = expectString(payload.claim_kind);
  if (!VALID_CLAIM_KINDS.has(claimKind)) {
    throw new KnowledgeApplyValidationError(`invalid claim_kind: ${JSON.stringify(claimKind)}`);
  }

  const claimText = expectString(payload.claim_text);
  const title = optionalString(payload.title) ?? titleFromClaimText(claimText);
  const visibility = optionalString(payload.visibility) ?? "space_shared";
  if (!VALID_VISIBILITIES.has(visibility)) {
    throw new KnowledgeApplyValidationError(`invalid visibility: ${JSON.stringify(visibility)}`);
  }
  const status = optionalString(payload.status) ?? "active";
  if (!VALID_CLAIM_STATUSES.has(status)) {
    throw new KnowledgeApplyValidationError(`invalid claim status: ${JSON.stringify(status)}`);
  }
  const createStatusError = claimCreateStatusError(status);
  if (createStatusError) throw new KnowledgeApplyValidationError(createStatusError);
  const confidenceMethod = optionalString(payload.confidence_method) ?? "human_confirmed";
  if (!VALID_CLAIM_CONFIDENCE_METHODS.has(confidenceMethod)) {
    throw new KnowledgeApplyValidationError(`invalid confidence_method: ${JSON.stringify(confidenceMethod)}`);
  }
  const resolutionState = optionalString(payload.resolution_state) ?? "unreviewed";
  if (!VALID_CLAIM_RESOLUTION_STATES.has(resolutionState)) {
    throw new KnowledgeApplyValidationError(`invalid resolution_state: ${JSON.stringify(resolutionState)}`);
  }
  const resolutionStateError = claimResolutionStateError(status, resolutionState);
  if (resolutionStateError) throw new KnowledgeApplyValidationError(resolutionStateError);

  const subjectObjectId = optionalString(payload.subject_object_id);
  const subjectText = optionalString(payload.subject_text);
  if (!subjectObjectId && !subjectText) {
    throw new KnowledgeApplyValidationError("claim subject_object_id or subject_text is required");
  }
  if (subjectObjectId) await requireSpaceObject(context.db, context.proposal.space_id, subjectObjectId, context.proposal);

  const holderObjectId = optionalString(payload.holder_object_id);
  if (holderObjectId) await requireSpaceObject(context.db, context.proposal.space_id, holderObjectId, context.proposal);
  const holderType = optionalString(payload.holder_type);
  const holderId = optionalString(payload.holder_id);
  if ((holderType && !holderId) || (!holderType && holderId)) {
    throw new KnowledgeApplyValidationError("holder_type and holder_id must be provided together");
  }
  if (holderObjectId && (holderType || holderId)) {
    throw new KnowledgeApplyValidationError("holder_object_id cannot be combined with holder_type/holder_id");
  }

  const requestedOwnerUserId = optionalString(payload.owner_user_id);
  if (
    requestedOwnerUserId !== null &&
    context.proposal.created_by_user_id !== null &&
    requestedOwnerUserId !== context.proposal.created_by_user_id
  ) {
    throw new KnowledgeApplyValidationError("Claim owner must be the proposal creator");
  }
  if (
    (visibility === "private" || visibility === "selected_users") &&
    context.proposal.created_by_user_id == null
  ) {
    throw new KnowledgeApplyValidationError("private or selected-user Claim requires a human owner");
  }

  const sources = await claimSourcesFromPayload(context, payload.sources);
  const now = new Date().toISOString();
  const claimId = randomUUID();
  const object = buildSpaceObjectInsert({
    id: claimId,
    spaceId: context.proposal.space_id,
    objectType: "claim",
    title,
    summary: optionalString(payload.summary) ?? claimText.slice(0, 280),
    visibility,
    ownerUserId: requestedOwnerUserId ?? context.proposal.created_by_user_id,
    primaryProjectId: optionalString(payload.project_id) ?? context.proposal.project_id,
    projectFolderId: optionalString(payload.project_folder_id) ?? context.proposal.project_folder_id,
    createdByUserId: context.proposal.created_by_user_id,
    createdByRunId: context.proposal.created_by_run_id ?? null,
    createdAt: now,
    archivedAt: status === "archived" ? now : null,
  });
  const n = object.params.length;
  await context.db.query(
    `WITH obj AS (
       ${object.sql}
     )
     INSERT INTO claims (
       object_id, space_id, status, subject_object_id, subject_text, claim_kind,
       claim_text, normalized_claim_hash, holder_object_id, holder_type,
       holder_id, confidence, confidence_method, resolution_state, valid_from,
       valid_until, observed_at, metadata_json, created_from_proposal_id,
       approved_by_user_id
     ) VALUES (
       $${n + 1}, $${n + 2}, $${n + 3}::varchar(32), $${n + 4}, $${n + 5}, $${n + 6},
       $${n + 7}, $${n + 8}, $${n + 9}, $${n + 10},
       $${n + 11}, $${n + 12}, $${n + 13}, $${n + 14}, $${n + 15},
       $${n + 16}, $${n + 17}, $${n + 18}::jsonb, $${n + 19},
       $${n + 20}
     )`,
    [
      ...object.params,
      claimId,
      context.proposal.space_id,
      status,
      subjectObjectId,
      subjectText,
      claimKind,
      claimText,
      optionalString(payload.normalized_claim_hash) ?? hashClaimText(claimText),
      holderObjectId,
      holderType,
      holderId,
      parseConfidence(payload.confidence),
      confidenceMethod,
      resolutionState,
      optionalDateIso(payload.valid_from),
      optionalDateIso(payload.valid_until),
      optionalDateIso(payload.observed_at),
      JSON.stringify(optionalObject(payload.metadata) ?? {}),
      context.proposal.id,
      context.userId,
    ],
  );

  await insertClaimSources(context, claimId, sources, now);
  await reindexWithinApply(context, (projection) =>
    projection.reindex(context.proposal.space_id, "claim", claimId));

  const row = await getClaimById(context.db, context.proposal.space_id, claimId);
  const sourceRows = await getClaimSources(context.db, context.proposal.space_id, claimId);
  return {
    result_type: "claim",
    result: { claim: serializeClaim(row, sourceRows) },
  };
}

async function applyClaimUpdateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "claim_update");

  const targetId = expectString(payload.target_claim_id);
  const current = await requireClaimForMutation(context.db, context.proposal.space_id, targetId, context.proposal);

  const claimKind = optionalString(payload.claim_kind) ?? current.claim_kind;
  if (!VALID_CLAIM_KINDS.has(claimKind)) {
    throw new KnowledgeApplyValidationError(`invalid claim_kind: ${JSON.stringify(claimKind)}`);
  }
  const claimText = optionalString(payload.claim_text) ?? current.claim_text;
  const status = optionalString(payload.status) ?? current.status;
  if (!VALID_CLAIM_STATUSES.has(status)) {
    throw new KnowledgeApplyValidationError(`invalid claim status: ${JSON.stringify(status)}`);
  }
  const transitionError = claimStatusTransitionError(current.status, status);
  if (transitionError) throw new KnowledgeApplyValidationError(transitionError);
  const visibility = optionalString(payload.visibility) ?? current.visibility;
  if (!VALID_VISIBILITIES.has(visibility)) {
    throw new KnowledgeApplyValidationError(`invalid visibility: ${JSON.stringify(visibility)}`);
  }
  const confidenceMethod = optionalString(payload.confidence_method) ?? current.confidence_method;
  if (!VALID_CLAIM_CONFIDENCE_METHODS.has(confidenceMethod)) {
    throw new KnowledgeApplyValidationError(`invalid confidence_method: ${JSON.stringify(confidenceMethod)}`);
  }
  const resolutionState = optionalString(payload.resolution_state) ?? current.resolution_state;
  if (!VALID_CLAIM_RESOLUTION_STATES.has(resolutionState)) {
    throw new KnowledgeApplyValidationError(`invalid resolution_state: ${JSON.stringify(resolutionState)}`);
  }
  const resolutionStateError = claimResolutionStateError(status, resolutionState);
  if (resolutionStateError) throw new KnowledgeApplyValidationError(resolutionStateError);

  const subjectObjectId = hasPayloadKey(payload, "subject_object_id")
    ? optionalString(payload.subject_object_id)
    : current.subject_object_id;
  const subjectText = hasPayloadKey(payload, "subject_text")
    ? optionalString(payload.subject_text)
    : current.subject_text;
  if (!subjectObjectId && !subjectText) {
    throw new KnowledgeApplyValidationError("claim subject_object_id or subject_text is required");
  }
  if (subjectObjectId) await requireSpaceObject(context.db, context.proposal.space_id, subjectObjectId, context.proposal);

  const holderObjectId = hasPayloadKey(payload, "holder_object_id")
    ? optionalString(payload.holder_object_id)
    : current.holder_object_id;
  if (holderObjectId) await requireSpaceObject(context.db, context.proposal.space_id, holderObjectId, context.proposal);
  const holderType = hasPayloadKey(payload, "holder_type") ? optionalString(payload.holder_type) : current.holder_type;
  const holderId = hasPayloadKey(payload, "holder_id") ? optionalString(payload.holder_id) : current.holder_id;
  if ((holderType && !holderId) || (!holderType && holderId)) {
    throw new KnowledgeApplyValidationError("holder_type and holder_id must be provided together");
  }
  if (holderObjectId && (holderType || holderId)) {
    throw new KnowledgeApplyValidationError("holder_object_id cannot be combined with holder_type/holder_id");
  }

  const metadataWasProvided = hasPayloadKey(payload, "metadata");
  const supersededByClaimId = optionalString(payload.superseded_by_claim_id);
  let nextMetadata = metadataWasProvided
    ? (optionalObject(payload.metadata) ?? {})
    : (optionalObject(current.metadata_json) ?? {});
  if (supersededByClaimId) {
    if (supersededByClaimId === targetId) {
      throw new KnowledgeApplyValidationError("superseded_by_claim_id must differ from target_claim_id");
    }
    await requireClaimForMutation(context.db, context.proposal.space_id, supersededByClaimId, context.proposal);
    nextMetadata = { ...nextMetadata, superseded_by_claim_id: supersededByClaimId };
  }
  if (status === "superseded") {
    const hasRelation = await hasActiveSupersedingClaimRelation(context.db, context.proposal.space_id, targetId);
    const hasPointer = optionalString(nextMetadata.superseded_by_claim_id) !== null;
    if (!hasRelation && !hasPointer) {
      throw new KnowledgeApplyValidationError("superseded Claims require superseded_by_claim_id or an active supersedes relation");
    }
  }
  const metadataChanged = metadataWasProvided || supersededByClaimId !== null;

  const now = new Date().toISOString();
  const title = optionalString(payload.title) ?? current.title;
  await context.db.query(
    `WITH obj AS (
       UPDATE space_objects
          SET title = $3,
              summary = CASE WHEN $4::boolean THEN $5 ELSE summary END,
              visibility = $7,
              archived_at = CASE WHEN $6::varchar(32) = 'archived' THEN $24::timestamptz ELSE archived_at END,
              updated_at = $24
        WHERE id = $1 AND space_id = $2 AND object_type = 'claim'
        RETURNING id
     )
     UPDATE claims
        SET status = $6::varchar(32),
            subject_object_id = $8,
            subject_text = $9,
            claim_kind = $10,
            claim_text = $11,
            normalized_claim_hash = $12,
            holder_object_id = $13,
            holder_type = $14,
            holder_id = $15,
            confidence = CASE WHEN $16::boolean THEN $17 ELSE confidence END,
            confidence_method = $18,
            resolution_state = $19,
            valid_from = CASE WHEN $20::boolean THEN $21::timestamptz ELSE valid_from END,
            valid_until = CASE WHEN $22::boolean THEN $23::timestamptz ELSE valid_until END,
            observed_at = CASE WHEN $25::boolean THEN $26::timestamptz ELSE observed_at END,
            metadata_json = CASE WHEN $27::boolean THEN $28::jsonb ELSE metadata_json END
      WHERE object_id = $1 AND space_id = $2 AND EXISTS (SELECT 1 FROM obj)`,
    [
      targetId,
      context.proposal.space_id,
      title,
      hasPayloadKey(payload, "summary"),
      optionalString(payload.summary),
      status,
      visibility,
      subjectObjectId,
      subjectText,
      claimKind,
      claimText,
      optionalString(payload.normalized_claim_hash) ?? (claimText !== current.claim_text ? hashClaimText(claimText) : current.normalized_claim_hash),
      holderObjectId,
      holderType,
      holderId,
      hasPayloadKey(payload, "confidence"),
      hasPayloadKey(payload, "confidence") ? parseConfidence(payload.confidence) : null,
      confidenceMethod,
      resolutionState,
      hasPayloadKey(payload, "valid_from"),
      optionalDateIso(payload.valid_from),
      hasPayloadKey(payload, "valid_until"),
      optionalDateIso(payload.valid_until),
      now,
      hasPayloadKey(payload, "observed_at"),
      optionalDateIso(payload.observed_at),
      metadataChanged,
      JSON.stringify(nextMetadata),
    ],
  );

  if (hasPayloadKey(payload, "sources")) {
    const sources = await claimSourcesFromPayload(context, payload.sources);
    await context.db.query(
      `DELETE FROM claim_sources WHERE claim_id = $1 AND space_id = $2`,
      [targetId, context.proposal.space_id],
    );
    await insertClaimSources(context, targetId, sources, now);
  }

  await reindexWithinApply(context, (projection) =>
    projection.reindex(context.proposal.space_id, "claim", targetId));

  const row = await getClaimById(context.db, context.proposal.space_id, targetId);
  const sourceRows = await getClaimSources(context.db, context.proposal.space_id, targetId);
  return {
    result_type: "claim",
    result: { claim: serializeClaim(row, sourceRows) },
  };
}

async function applyClaimArchiveProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "claim_archive");

  const targetId = expectString(payload.target_claim_id);
  const current = await requireClaimForMutation(context.db, context.proposal.space_id, targetId, context.proposal);
  const transitionError = claimStatusTransitionError(current.status, "archived");
  if (transitionError) throw new KnowledgeApplyValidationError(transitionError);
  const now = new Date().toISOString();
  await context.db.query(
    `WITH claim AS (
       UPDATE claims SET status = 'archived'
        WHERE object_id = $1 AND space_id = $2
     )
     UPDATE space_objects
        SET archived_at = $3, updated_at = $3
      WHERE id = $1 AND space_id = $2 AND object_type = 'claim'`,
    [targetId, context.proposal.space_id, now],
  );

  await reindexWithinApply(context, (projection) =>
    projection.deleteProjectionForObject(context.proposal.space_id, "claim", targetId));

  const row = await getClaimById(context.db, context.proposal.space_id, targetId);
  const sourceRows = await getClaimSources(context.db, context.proposal.space_id, targetId);
  return {
    result_type: "claim",
    result: { claim: serializeClaim(row, sourceRows) },
  };
}

async function applyObjectRelationCreateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "object_relation_create");

  const fromObjectId = expectString(payload.from_object_id);
  const toObjectId = expectString(payload.to_object_id);
  if (fromObjectId === toObjectId) throw new KnowledgeApplyValidationError("object relation endpoints must differ");
  const linkType = expectString(payload.link_type);
  const status = optionalString(payload.status) ?? "active";
  if (!RELATION_CREATE_STATUSES.has(status)) {
    throw new KnowledgeApplyValidationError(`invalid relation status: ${JSON.stringify(status)}`);
  }
  const metadata = validatedObjectRelationMetadata(linkType, payload.metadata);

  const fromObject = await requireSpaceObjectForMutation(context.db, context.proposal.space_id, fromObjectId, context.proposal);
  const toObject = await requireSpaceObjectForMutation(context.db, context.proposal.space_id, toObjectId, context.proposal);
  // Apply is the canonical write boundary, so the registry is consulted here
  // and not only when the proposal was created: vocabulary, declared
  // governance, and endpoints together.
  const linkViolation = checkLinkTypeAllowed({
    linkType,
    fromObjectType: fromObject.object_type,
    toObjectType: toObject.object_type,
    via: "proposal",
  });
  if (linkViolation) throw new KnowledgeApplyValidationError(linkViolation);
  const sourceClaimId = optionalString(payload.source_claim_id);
  if (sourceClaimId) await requireClaimForMutation(context.db, context.proposal.space_id, sourceClaimId, context.proposal);
  const sourceObjectId = optionalString(payload.source_object_id);
  if (sourceObjectId) await requireSpaceObject(context.db, context.proposal.space_id, sourceObjectId, context.proposal);
  if (status === "active") {
    await assertNoActiveObjectRelation(context.db, context.proposal.space_id, fromObjectId, toObjectId, linkType);
  }

  const now = new Date().toISOString();
  const relationId = randomUUID();
  await context.db.query(
    `INSERT INTO object_relations (
       id, space_id, from_object_id, to_object_id, link_type, status,
       confidence, evidence_summary, source_claim_id, source_object_id,
       source_proposal_id, metadata_json, created_by_user_id,
       created_by_agent_id, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12::jsonb, $13,
       NULL, $14, $14
     )`,
    [
      relationId,
      context.proposal.space_id,
      fromObjectId,
      toObjectId,
      linkType,
      status,
      parseConfidence(payload.confidence),
      optionalString(payload.evidence_summary),
      sourceClaimId,
      sourceObjectId,
      context.proposal.id,
      JSON.stringify(metadata),
      context.proposal.created_by_user_id,
      now,
    ],
  );

  await reindexWithinApply(context, async (projection) => {
    await reindexSpaceObject(projection, context.proposal.space_id, fromObject);
    await reindexSpaceObject(projection, context.proposal.space_id, toObject);
  });

  const row = await getObjectRelationById(context.db, context.proposal.space_id, relationId);
  return {
    result_type: "object_relation",
    result: { object_relation: serializeObjectRelation(row) },
  };
}

async function applyObjectRelationDeleteProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "object_relation_delete");

  const relationId = expectString(payload.relation_id);
  const relation = await getObjectRelationById(context.db, context.proposal.space_id, relationId);
  const fromObject = await requireSpaceObjectForMutation(context.db, context.proposal.space_id, relation.from_object_id, context.proposal);
  const toObject = await requireSpaceObjectForMutation(context.db, context.proposal.space_id, relation.to_object_id, context.proposal);

  const now = new Date().toISOString();
  const metadataPatch = strictMetadataObject(payload.metadata_patch, "metadata_patch");
  const metadata = validatedObjectRelationMetadata(relation.link_type, {
    ...strictMetadataObject(relation.metadata_json, "stored relation metadata"),
    ...metadataPatch,
  });
  await context.db.query(
    `UPDATE object_relations
        SET status = 'archived',
            metadata_json = $4::jsonb,
            updated_at = $3
      WHERE id = $1 AND space_id = $2`,
    [relationId, context.proposal.space_id, now, JSON.stringify(metadata)],
  );

  await reindexWithinApply(context, async (projection) => {
    await reindexSpaceObject(projection, context.proposal.space_id, fromObject);
    await reindexSpaceObject(projection, context.proposal.space_id, toObject);
  });

  const row = await getObjectRelationById(context.db, context.proposal.space_id, relationId);
  return {
    result_type: "object_relation",
    result: { object_relation: serializeObjectRelation(row) },
  };
}

async function applyObjectProfileCreateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "object_profile_create");

  const key = expectObjectProfileKey(payload.key);
  const label = expectBoundedString(payload.label, "label", 160);
  const baseObjectType = expectObjectProfileBaseType(payload.base_object_type);
  assertObjectProfileKeyMatchesBase(baseObjectType, key);
  const status = optionalString(payload.status) ?? "active";
  if (!CREATE_OBJECT_PROFILE_STATUSES.has(status)) {
    throw new KnowledgeApplyValidationError("object kind create status must be draft or active");
  }

  const fieldSchema = objectProfileConfig(payload.field_schema, "field_schema");
  const extractionPolicy = objectProfileConfig(payload.extraction_policy, "extraction_policy");
  const retrievalPolicy = objectProfileConfig(payload.retrieval_policy, "retrieval_policy");
  const uiConfig = objectProfileConfig(payload.ui_config, "ui_config");
  const relationHints = await objectProfileRelationHints(
    context.db,
    context.proposal.space_id,
    payload.relation_hints,
  );

  await assertObjectProfileKeyAvailable(context.db, context.proposal.space_id, baseObjectType, key);

  const now = new Date().toISOString();
  const id = randomUUID();
  await context.db.query(
    `INSERT INTO space_object_profiles (
       id, space_id, key, label, description, base_object_type, status, version,
       field_schema_json, extraction_policy_json, retrieval_policy_json, ui_config_json,
       created_by_user_id, created_from_proposal_id, updated_from_proposal_id,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 1,
       $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
       $12, $13, $13,
       $14, $14
     )`,
    [
      id,
      context.proposal.space_id,
      key,
      label,
      optionalString(payload.description),
      baseObjectType,
      status,
      JSON.stringify(fieldSchema),
      JSON.stringify(extractionPolicy),
      JSON.stringify(retrievalPolicy),
      JSON.stringify(uiConfig),
      context.proposal.created_by_user_id,
      context.proposal.id,
      now,
    ],
  );
  await insertObjectProfileRelationHints(context.db, context.proposal.space_id, id, relationHints, now);

  const row = await getObjectProfileById(context.db, context.proposal.space_id, id);
  return {
    result_type: "object_profile",
    result: objectProfileApplyResult(row),
  };
}

async function applyObjectProfileUpdateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "object_profile_update");

  const targetId = expectString(payload.target_profile_id);
  const current = await requireObjectProfileMutable(context.db, context.proposal.space_id, targetId);
  const label = hasPayloadKey(payload, "label")
    ? expectBoundedString(payload.label, "label", 160)
    : current.label;
  const description = hasPayloadKey(payload, "description")
    ? optionalString(payload.description)
    : current.description;
  const status = hasPayloadKey(payload, "status")
    ? expectObjectProfileActivationStatus(payload.status, current.status)
    : current.status;
  const fieldSchema = hasPayloadKey(payload, "field_schema")
    ? objectProfileConfig(payload.field_schema, "field_schema")
    : objectRecord(current.field_schema_json);
  const extractionPolicy = hasPayloadKey(payload, "extraction_policy")
    ? objectProfileConfig(payload.extraction_policy, "extraction_policy")
    : objectRecord(current.extraction_policy_json);
  const retrievalPolicy = hasPayloadKey(payload, "retrieval_policy")
    ? objectProfileConfig(payload.retrieval_policy, "retrieval_policy")
    : objectRecord(current.retrieval_policy_json);
  const uiConfig = hasPayloadKey(payload, "ui_config")
    ? objectProfileConfig(payload.ui_config, "ui_config")
    : objectRecord(current.ui_config_json);
  const relationHints = hasPayloadKey(payload, "relation_hints")
    ? await objectProfileRelationHints(context.db, context.proposal.space_id, payload.relation_hints)
    : null;

  if (
    !hasPayloadKey(payload, "label") &&
    !hasPayloadKey(payload, "description") &&
    !hasPayloadKey(payload, "status") &&
    !hasPayloadKey(payload, "field_schema") &&
    !hasPayloadKey(payload, "extraction_policy") &&
    !hasPayloadKey(payload, "retrieval_policy") &&
    !hasPayloadKey(payload, "ui_config") &&
    !hasPayloadKey(payload, "relation_hints")
  ) {
    throw new KnowledgeApplyValidationError("object kind update requires at least one field");
  }

  const now = new Date().toISOString();
  await context.db.query(
    `UPDATE space_object_profiles
        SET label = $3,
            description = $4,
            status = $5,
            field_schema_json = $6::jsonb,
            extraction_policy_json = $7::jsonb,
            retrieval_policy_json = $8::jsonb,
            ui_config_json = $9::jsonb,
            version = version + 1,
            updated_from_proposal_id = $10,
            updated_at = $11
      WHERE id = $1 AND space_id = $2`,
    [
      targetId,
      context.proposal.space_id,
      label,
      description,
      status,
      JSON.stringify(fieldSchema),
      JSON.stringify(extractionPolicy),
      JSON.stringify(retrievalPolicy),
      JSON.stringify(uiConfig),
      context.proposal.id,
      now,
    ],
  );
  if (relationHints) {
    await replaceObjectProfileRelationHints(context.db, context.proposal.space_id, targetId, relationHints, now);
  }

  const row = await getObjectProfileById(context.db, context.proposal.space_id, targetId);
  return {
    result_type: "object_profile",
    result: objectProfileApplyResult(row),
  };
}

async function applyObjectProfileDeprecateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "object_profile_deprecate");
  return updateObjectProfileStatus(context, expectString(payload.target_profile_id), "deprecated");
}

async function applyObjectProfileArchiveProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  ensureOperation(payload, "object_profile_archive");
  return updateObjectProfileStatus(context, expectString(payload.target_profile_id), "archived");
}

async function updateObjectProfileStatus(
  context: ProposalApplyContext,
  targetId: string,
  status: "deprecated" | "archived",
): Promise<ProposalApplyResult> {
  const current = await getObjectProfileById(context.db, context.proposal.space_id, targetId);
  if (current.status === "archived") {
    throw new KnowledgeApplyValidationError("archived object kinds cannot be changed");
  }
  if (current.status === status) {
    throw new KnowledgeApplyValidationError(`object kind is already ${status}`);
  }
  const now = new Date().toISOString();
  await context.db.query(
    `UPDATE space_object_profiles
        SET status = $3,
            version = version + 1,
            updated_from_proposal_id = $4,
            updated_at = $5
      WHERE id = $1 AND space_id = $2`,
    [targetId, context.proposal.space_id, status, context.proposal.id, now],
  );
  const row = await getObjectProfileById(context.db, context.proposal.space_id, targetId);
  return {
    result_type: "object_profile",
    result: objectProfileApplyResult(row),
  };
}

async function requireKnowledgeItem(
  db: Queryable,
  spaceId: string,
  itemId: string,
  proposal: ProposalApplyContext["proposal"],
): Promise<KnowledgeItemRow> {
  const row = await getKnowledgeItemById(db, spaceId, itemId);
  if (row.status !== "active" && row.status !== "draft") {
    throw new KnowledgeApplyValidationError("target Knowledge item is not active");
  }
  if (
    !(await proposalCanReadSpaceObject(db, proposal, row.id))
    || !canApplyKnowledgeMutation(row, proposal)
  ) {
    throw new KnowledgeApplyValidationError("Knowledge item not found or not editable");
  }
  return row;
}

async function getKnowledgeItemById(db: Queryable, spaceId: string, itemId: string): Promise<KnowledgeItemRow> {
  const result = await db.query<KnowledgeItemRow>(
    `SELECT ${KNOWLEDGE_ITEM_COLUMNS}
       FROM ${KNOWLEDGE_ITEM_FROM}
      WHERE ki.object_id = $1 AND ki.space_id = $2`,
    [itemId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new KnowledgeApplyValidationError("Knowledge item not found");
  return row;
}

async function requireClaimForMutation(
  db: Queryable,
  spaceId: string,
  claimId: string,
  proposal: ProposalApplyContext["proposal"],
): Promise<ClaimRow> {
  const row = await getClaimById(db, spaceId, claimId);
  if (row.status === "archived") {
    throw new KnowledgeApplyValidationError("target Claim is archived");
  }
  if (
    !(await proposalCanReadSpaceObject(db, proposal, row.id))
    || !canApplyClaimMutation(row, proposal)
  ) {
    throw new KnowledgeApplyValidationError("Claim not found or not editable");
  }
  return row;
}

async function getClaimById(db: Queryable, spaceId: string, claimId: string): Promise<ClaimRow> {
  const result = await db.query<ClaimRow>(
    `SELECT ${CLAIM_COLUMNS}
       FROM ${CLAIM_FROM}
      WHERE c.object_id = $1 AND c.space_id = $2`,
    [claimId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new KnowledgeApplyValidationError("Claim not found");
  return row;
}

async function getClaimSources(db: Queryable, spaceId: string, claimId: string): Promise<ClaimSourceRow[]> {
  const result = await db.query<ClaimSourceRow>(
    `SELECT ${CLAIM_SOURCE_COLUMNS}
       FROM claim_sources
      WHERE claim_id = $1 AND space_id = $2
      ORDER BY created_at ASC, id ASC`,
    [claimId, spaceId],
  );
  return result.rows;
}

async function getObjectRelationById(
  db: Queryable,
  spaceId: string,
  relationId: string,
): Promise<ObjectRelationRow> {
  const result = await db.query<ObjectRelationRow>(
    `SELECT ${OBJECT_RELATION_COLUMNS}
       FROM object_relations r
       JOIN space_objects from_so
         ON from_so.id = r.from_object_id
        AND from_so.space_id = r.space_id
       JOIN space_objects to_so
         ON to_so.id = r.to_object_id
        AND to_so.space_id = r.space_id
      WHERE r.id = $1 AND r.space_id = $2`,
    [relationId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new KnowledgeApplyValidationError("Object relation not found");
  return row;
}

async function getObjectProfileById(
  db: Queryable,
  spaceId: string,
  profileId: string,
): Promise<SpaceObjectProfileRow> {
  const result = await db.query<SpaceObjectProfileRow>(
    `SELECT ${SPACE_OBJECT_PROFILE_COLUMNS}
       FROM space_object_profiles
      WHERE id = $1 AND space_id = $2`,
    [profileId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new KnowledgeApplyValidationError("Object kind not found");
  return row;
}

async function requireObjectProfileMutable(
  db: Queryable,
  spaceId: string,
  profileId: string,
): Promise<SpaceObjectProfileRow> {
  const row = await getObjectProfileById(db, spaceId, profileId);
  if (row.status === "archived") {
    throw new KnowledgeApplyValidationError("archived object kinds cannot be changed");
  }
  return row;
}

async function assertObjectProfileKeyAvailable(
  db: Queryable,
  spaceId: string,
  baseObjectType: string,
  key: string,
): Promise<void> {
  const result = await db.query<{ id: string }>(
    `SELECT id
       FROM space_object_profiles
      WHERE space_id = $1
        AND base_object_type = $2
        AND key = $3
      LIMIT 1`,
    [spaceId, baseObjectType, key],
  );
  if (result.rows[0]) throw new KnowledgeApplyValidationError("object kind key already exists for this base object type");
}

async function requireSpaceObject(
  db: Queryable,
  spaceId: string,
  objectId: string,
  proposal: ProposalApplyContext["proposal"],
): Promise<SpaceObjectRow> {
  const row = await getSpaceObjectById(db, spaceId, objectId);
  if (!(await proposalCanReadSpaceObject(db, proposal, row.id))) {
    throw new KnowledgeApplyValidationError("Space object not found");
  }
  return row;
}

async function requireSpaceObjectForMutation(
  db: Queryable,
  spaceId: string,
  objectId: string,
  proposal: ProposalApplyContext["proposal"],
): Promise<SpaceObjectRow> {
  const row = await requireSpaceObject(db, spaceId, objectId, proposal);
  if (!canApplySpaceObjectMutation(row, proposal)) {
    throw new KnowledgeApplyValidationError("Space object not editable");
  }
  return row;
}

async function getSpaceObjectById(db: Queryable, spaceId: string, objectId: string): Promise<SpaceObjectRow> {
  const result = await db.query<SpaceObjectRow>(
    `SELECT so.id, so.space_id, so.object_type, so.title,
            ${objectStatusScalarSql("so")} AS status,
            so.visibility, so.owner_user_id,
            so.primary_project_id, so.project_folder_id, so.created_by_user_id
       FROM space_objects so
      WHERE so.id = $1 AND so.space_id = $2 AND so.deleted_at IS NULL`,
    [objectId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new KnowledgeApplyValidationError("Space object not found");
  if (row.status === "archived" || row.status === "deleted") {
    throw new KnowledgeApplyValidationError("Space object is archived or deleted");
  }
  return row;
}

async function claimSourcesFromPayload(
  context: ProposalApplyContext,
  rawSources: unknown,
): Promise<Array<{
  sourceObjectId: string | null;
  sourceRefType: string | null;
  sourceRefId: string | null;
  sourceConnectionId: string | null;
  sourcePolicySnapshot: Record<string, unknown>;
  locator: string | null;
  quoteExcerpt: string | null;
  evidenceRole: string;
  sourceTrust: string | null;
  confidence: number | null;
  metadata: Record<string, unknown>;
}>> {
  if (!Array.isArray(rawSources)) return [];
  const sources: Array<{
    sourceObjectId: string | null;
    sourceRefType: string | null;
    sourceRefId: string | null;
    sourceConnectionId: string | null;
    sourcePolicySnapshot: Record<string, unknown>;
    locator: string | null;
    quoteExcerpt: string | null;
    evidenceRole: string;
    sourceTrust: string | null;
    confidence: number | null;
    metadata: Record<string, unknown>;
  }> = [];
  for (const raw of rawSources) {
    const source = optionalObject(raw);
    if (!source) throw new KnowledgeApplyValidationError("claim source entries must be objects");
    const sourceObjectId = optionalString(source.source_object_id);
    if (sourceObjectId) {
      await requireSpaceObject(context.db, context.proposal.space_id, sourceObjectId, context.proposal);
    }
    const sourceRefType = optionalString(source.source_ref_type);
    const sourceRefId = optionalString(source.source_ref_id);
    if ((sourceRefType && !sourceRefId) || (!sourceRefType && sourceRefId)) {
      throw new KnowledgeApplyValidationError("source_ref_type and source_ref_id must be provided together");
    }
    if (sourceRefType && !VALID_CLAIM_SOURCE_REF_TYPES.has(sourceRefType)) {
      throw new KnowledgeApplyValidationError(`invalid source_ref_type: ${JSON.stringify(sourceRefType)}`);
    }
    const sourceConnectionId = optionalString(source.source_connection_id);
    if (sourceRefType && !sourceConnectionId) {
      throw new KnowledgeApplyValidationError("source_ref entries require source_connection_id");
    }
    const connectionSnapshot = sourceConnectionId
      ? await sourcePolicySnapshotForConnection(context.db, context.proposal.space_id, sourceConnectionId)
      : {};
    if (!sourceObjectId && !sourceConnectionId && !sourceRefType) {
      throw new KnowledgeApplyValidationError("claim source requires source_object_id, source_connection_id, or source_ref_type/sources_ref_id");
    }
    const evidenceRole = optionalString(source.evidence_role) ?? "supports";
    if (!VALID_CLAIM_EVIDENCE_ROLES.has(evidenceRole)) {
      throw new KnowledgeApplyValidationError(`invalid evidence_role: ${JSON.stringify(evidenceRole)}`);
    }
    const sourceTrust = optionalString(source.source_trust);
    if (sourceTrust && !VALID_CLAIM_SOURCE_TRUST_LEVELS.has(sourceTrust)) {
      throw new KnowledgeApplyValidationError(`invalid source_trust: ${JSON.stringify(sourceTrust)}`);
    }
    sources.push({
      sourceObjectId,
      sourceRefType,
      sourceRefId,
      sourceConnectionId,
      sourcePolicySnapshot: optionalObject(source.source_policy_snapshot) ?? optionalObject(source.source_policy_snapshot_json) ?? connectionSnapshot,
      locator: optionalString(source.locator),
      quoteExcerpt: optionalString(source.quote_excerpt),
      evidenceRole,
      sourceTrust,
      confidence: parseConfidence(source.confidence),
      metadata: optionalObject(source.metadata) ?? {},
    });
  }
  return sources;
}

async function sourcePolicySnapshotForConnection(
  db: Queryable,
  spaceId: string,
  connectionId: string,
): Promise<Record<string, unknown>> {
  const result = await db.query<{
    id: string;
    capture_policy: string;
    trust_level: string;
    consent_json: unknown;
    policy_json: unknown;
  }>(
    `SELECT id, capture_policy, trust_level, consent_json, policy_json
       FROM source_connections
      WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
    [connectionId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new KnowledgeApplyValidationError("Claim source connection not found");
  return {
    source_connection_id: row.id,
    capture_policy: row.capture_policy,
    trust_level: row.trust_level,
    consent: optionalObject(row.consent_json) ?? {},
    policy: optionalObject(row.policy_json) ?? {},
  };
}

async function insertClaimSources(
  context: ProposalApplyContext,
  claimId: string,
  sources: Awaited<ReturnType<typeof claimSourcesFromPayload>>,
  now: string,
): Promise<void> {
  for (const source of sources) {
    await context.db.query(
      `INSERT INTO claim_sources (
         id, space_id, claim_id, source_object_id, source_ref_type,
         source_ref_id, source_connection_id, source_policy_snapshot_json,
         locator, quote_excerpt, evidence_role, source_trust, confidence,
         metadata_json, created_by_user_id, created_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::jsonb,
         $9, $10, $11, $12, $13,
         $14::jsonb, $15, $16
       )`,
      [
        randomUUID(),
        context.proposal.space_id,
        claimId,
        source.sourceObjectId,
        source.sourceRefType,
        source.sourceRefId,
        source.sourceConnectionId,
        JSON.stringify(source.sourcePolicySnapshot),
        source.locator,
        source.quoteExcerpt,
        source.evidenceRole,
        source.sourceTrust,
        source.confidence,
        JSON.stringify(source.metadata),
        context.proposal.created_by_user_id,
        now,
      ],
    );
  }
}

async function hasActiveSupersedingClaimRelation(
  db: Queryable,
  spaceId: string,
  targetClaimId: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT r.id
       FROM object_relations r
       JOIN space_objects from_so
         ON from_so.id = r.from_object_id
        AND from_so.space_id = r.space_id
        AND from_so.object_type = 'claim'
        AND from_so.deleted_at IS NULL
       JOIN space_objects to_so
         ON to_so.id = r.to_object_id
        AND to_so.space_id = r.space_id
        AND to_so.object_type = 'claim'
        AND to_so.deleted_at IS NULL
      WHERE r.space_id = $1
        AND r.to_object_id = $2
        AND r.link_type = 'supersedes'
        AND r.status = 'active'
      LIMIT 1`,
    [spaceId, targetClaimId],
  );
  return Boolean(result.rows[0]);
}

async function assertNoActiveObjectRelation(
  db: Queryable,
  spaceId: string,
  fromObjectId: string,
  toObjectId: string,
  linkType: string,
): Promise<void> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM object_relations
      WHERE space_id = $1 AND from_object_id = $2 AND to_object_id = $3
        AND link_type = $4 AND status = 'active'`,
    [spaceId, fromObjectId, toObjectId, linkType],
  );
  if (result.rows[0]) throw new KnowledgeApplyValidationError("active Object relation already exists");
}

async function reindexSpaceObject(
  projection: RetrievalProjectionService,
  spaceId: string,
  object: SpaceObjectRow,
): Promise<void> {
  const objectType = retrievalObjectTypeForSpaceObject(object.object_type);
  if (!objectType) return;
  await projection.reindex(spaceId, objectType, object.id);
}

function retrievalObjectTypeForSpaceObject(objectType: string) {
  return isKnowledgeRetrievalObjectType(objectType) ? objectType : null;
}

async function getKnowledgeRowsOrThrow<Row extends { id: string }>(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
): Promise<Row> {
  const result = await db.query<Row>(sql, params);
  const row = result.rows[0];
  if (!row) throw new KnowledgeApplyValidationError("Knowledge apply failed");
  return row;
}

async function writeSourceRefs(input: {
  db: Queryable;
  spaceId: string;
  targetId: string;
  entries: ProvenanceEntry[];
}): Promise<void> {
  if (!input.entries.length) return;
  await writeProvenanceLinks(input.db, {
    spaceId: input.spaceId,
    targetType: TARGET_KNOWLEDGE,
    targetId: input.targetId,
    entries: input.entries,
  });
}

function provenanceEntriesFromPayload(sourceRefs: unknown): ProvenanceEntry[] {
  if (!Array.isArray(sourceRefs)) return [];

  const entries: ProvenanceEntry[] = [];
  const seen = new Set<string>();
  for (const raw of sourceRefs) {
    if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const rawType = obj.source_type ?? obj.type;
    const rawId = obj.source_id ?? obj.id;
    if (typeof rawType !== "string" || typeof rawId !== "string") continue;
    const sourceType = rawType.trim();
    const sourceId = rawId.trim();
    if (!sourceType || !sourceId) continue;
    if (!isProvenanceSourceType(sourceType)) continue;

    const entry: ProvenanceEntry = {
      source_type: sourceType,
      source_id: sourceId,
    };
    const trust = optionalString(obj.source_trust);
    if (trust) {
      entry.source_trust = trust;
    }

    const evidence = optionalObject(obj.evidence_json);
    if (evidence) {
      entry.evidence_json = evidence;
    }

    const key = `${entry.source_type}:::${entry.source_id}:::${entry.source_trust ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }

  return entries;
}

function serializeKnowledgeItem(row: KnowledgeItemRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    project_folder_id: row.project_folder_id,
    root_item_id: row.root_item_id,
    supersedes_item_id: row.supersedes_item_id,
    redirect_to_item_id: row.redirect_to_item_id,
    knowledge_kind: row.knowledge_kind,
    slug: row.slug,
    aliases: parseJsonArray(row.aliases_json),
    title: row.title,
    content: row.content,
    content_json: row.content_json,
    content_format: row.content_format,
    content_schema_version: toNumber(row.content_schema_version),
    plain_text: row.plain_text,
    excerpt: row.excerpt,
    status: row.status,
    visibility: row.visibility,
    verification_status: row.verification_status,
    reflection_status: row.reflection_status,
    tags: parseJsonArray(row.tags_json),
    confidence: row.confidence,
    owner_user_id: row.owner_user_id,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_by_run_id: row.created_by_run_id,
    created_from_proposal_id: row.created_from_proposal_id,
    approved_by_user_id: row.approved_by_user_id,
    version: toNumber(row.version),
    pinned_source_ref: optionalObject(row.pinned_source_ref_json),
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
    archived_at: normalizeDate(row.archived_at),
    deprecated_at: normalizeDate(row.deprecated_at),
  };
}

function serializeClaim(row: ClaimRow, sources: ClaimSourceRow[]): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    subject_object_id: row.subject_object_id,
    subject_text: row.subject_text,
    claim_kind: row.claim_kind,
    claim_text: row.claim_text,
    normalized_claim_hash: row.normalized_claim_hash,
    holder_object_id: row.holder_object_id,
    holder_type: row.holder_type,
    holder_id: row.holder_id,
    confidence: row.confidence,
    confidence_method: row.confidence_method,
    resolution_state: row.resolution_state,
    valid_from: normalizeDate(row.valid_from),
    valid_until: normalizeDate(row.valid_until),
    observed_at: normalizeDate(row.observed_at),
    metadata: optionalObject(row.metadata_json) ?? {},
    status: row.status,
    visibility: row.visibility,
    title: row.title,
    excerpt: row.excerpt,
    owner_user_id: row.owner_user_id,
    project_id: row.project_id,
    project_folder_id: row.project_folder_id,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_by_run_id: row.created_by_run_id,
    created_from_proposal_id: row.created_from_proposal_id,
    approved_by_user_id: row.approved_by_user_id,
    sources: sources.map(serializeClaimSource),
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
    archived_at: normalizeDate(row.archived_at),
  };
}

function serializeClaimSource(row: ClaimSourceRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    claim_id: row.claim_id,
    source_object_id: row.source_object_id,
    source_ref_type: row.source_ref_type,
    source_ref_id: row.source_ref_id,
    source_connection_id: row.source_connection_id,
    source_policy_snapshot: optionalObject(row.source_policy_snapshot_json) ?? {},
    locator: row.locator,
    quote_excerpt: row.quote_excerpt,
    evidence_role: row.evidence_role,
    source_trust: row.source_trust,
    confidence: row.confidence,
    metadata: optionalObject(row.metadata_json) ?? {},
    created_by_user_id: row.created_by_user_id,
    created_at: normalizeDate(row.created_at),
  };
}

function serializeObjectRelation(row: ObjectRelationRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    from_object_id: row.from_object_id,
    to_object_id: row.to_object_id,
    link_type: row.link_type,
    status: row.status,
    confidence: row.confidence,
    evidence_summary: row.evidence_summary,
    source_claim_id: row.source_claim_id,
    source_object_id: row.source_object_id,
    source_proposal_id: row.source_proposal_id,
    retrieval_projected: isKnowledgeRetrievalProjectedRelation(row.from_object_type, row.to_object_type),
    metadata: optionalObject(row.metadata_json) ?? {},
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
  };
}

function serializeObjectProfile(row: SpaceObjectProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    key: row.key,
    label: row.label,
    description: row.description,
    base_object_type: row.base_object_type,
    status: row.status,
    version: toNumber(row.version),
    field_schema: objectRecord(row.field_schema_json),
    extraction_policy: objectRecord(row.extraction_policy_json),
    retrieval_policy: objectRecord(row.retrieval_policy_json),
    ui_config: objectRecord(row.ui_config_json),
    created_by_user_id: row.created_by_user_id,
    created_from_proposal_id: row.created_from_proposal_id,
    updated_from_proposal_id: row.updated_from_proposal_id,
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
  };
}

function canApplyKnowledgeMutation(
  item: KnowledgeItemRow,
  proposal: ProposalApplyContext["proposal"],
): boolean {
  return item.space_id === proposal.space_id && isContentOwner(item, proposal.created_by_user_id);
}

function canApplyClaimMutation(
  claim: ClaimRow,
  proposal: ProposalApplyContext["proposal"],
): boolean {
  return claim.space_id === proposal.space_id && isContentOwner(claim, proposal.created_by_user_id);
}

function canApplySpaceObjectMutation(
  object: SpaceObjectRow,
  proposal: ProposalApplyContext["proposal"],
): boolean {
  return object.space_id === proposal.space_id && isContentOwner(object, proposal.created_by_user_id);
}

async function proposalCanReadSpaceObject(
  db: Queryable,
  proposal: ProposalApplyContext["proposal"],
  objectId: string,
): Promise<boolean> {
  if (!proposal.created_by_user_id) return false;
  return (await contentDecisionFromDb(
    db,
    { spaceId: proposal.space_id, userId: proposal.created_by_user_id },
    "space_object",
    objectId,
  )) !== "deny";
}

function ensureOperation(payload: Record<string, unknown>, operation: string): void {
  const value = optionalString(payload.operation);
  if (value !== operation) {
    throw new KnowledgeApplyValidationError(`expected operation=${JSON.stringify(operation)}`);
  }
}

function expectString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new KnowledgeApplyValidationError("missing required string value");
  }
  return value.trim();
}

function expectBoundedString(value: unknown, field: string, maxLength: number): string {
  const normalized = expectString(value);
  if (normalized.length > maxLength) {
    throw new KnowledgeApplyValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function expectObjectProfileKey(value: unknown): string {
  const key = expectString(value);
  if (!OBJECT_PROFILE_KEY_PATTERN.test(key)) {
    throw new KnowledgeApplyValidationError("object kind key must be lowercase letters, numbers, or underscores and start with a letter");
  }
  return key;
}

function expectObjectProfileBaseType(value: unknown): string {
  const baseObjectType = expectString(value);
  if (!VALID_OBJECT_PROFILE_BASE_TYPES.has(baseObjectType)) {
    throw new KnowledgeApplyValidationError(`invalid base_object_type: ${JSON.stringify(baseObjectType)}`);
  }
  return baseObjectType;
}

function assertObjectProfileKeyMatchesBase(baseObjectType: string, key: string): void {
  const allowed = allowedObjectProfileKeys(baseObjectType);
  if (!allowed?.includes(key)) {
    throw new KnowledgeApplyValidationError(
      `object kind key must match the canonical ${baseObjectType} subtype (${allowed?.join(", ") ?? "none"})`,
    );
  }
}

function expectObjectProfileActivationStatus(value: unknown, currentStatus: string): "active" {
  const status = expectString(value);
  if (status !== "active") {
    throw new KnowledgeApplyValidationError("object kind update status can only be active");
  }
  if (currentStatus !== "draft") {
    throw new KnowledgeApplyValidationError("only draft object kinds can be activated");
  }
  return status;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return optionalObject(value) ?? {};
}

function objectProfileConfig(value: unknown, field: string): Record<string, unknown> {
  if (value !== undefined && value !== null && optionalObject(value) === null) {
    throw new KnowledgeApplyValidationError(`${field} must be a JSON object`);
  }
  const record = objectRecord(value);
  assertObjectProfileConfigSafe(record, field, 0);
  const serialized = JSON.stringify(record);
  if (serialized.length > 16_000) {
    throw new KnowledgeApplyValidationError(`${field} is too large`);
  }
  return record;
}

interface ObjectProfileRelationHintPayload {
  endpointObjectType: string;
  endpointObjectProfileId: string | null;
  linkType: string;
  direction: "from" | "to" | "either";
  confidenceDefault: number;
  required: boolean;
}

async function objectProfileRelationHints(
  db: Queryable,
  spaceId: string,
  rawHints: unknown,
): Promise<ObjectProfileRelationHintPayload[]> {
  if (rawHints === undefined || rawHints === null) return [];
  if (!Array.isArray(rawHints)) {
    throw new KnowledgeApplyValidationError("relation_hints must be an array");
  }
  if (rawHints.length > 50) {
    throw new KnowledgeApplyValidationError("relation_hints can include at most 50 entries");
  }
  const hints: ObjectProfileRelationHintPayload[] = [];
  for (const rawHint of rawHints) {
    const hint = optionalObject(rawHint);
    if (!hint) throw new KnowledgeApplyValidationError("relation_hints entries must be objects");
    const endpointObjectType = expectObjectProfileBaseType(hint.endpoint_object_type);
    const linkType = expectString(hint.link_type);
    if (!hasDeclaration(linkType)) {
      throw new KnowledgeApplyValidationError("invalid relation_hints link_type");
    }
    const direction = optionalString(hint.direction) ?? "from";
    if (!OBJECT_PROFILE_RELATION_HINT_DIRECTIONS.has(direction)) {
      throw new KnowledgeApplyValidationError("invalid relation_hints direction");
    }
    const confidenceDefault = numberValue(hint.confidence_default) ?? 0.55;
    if (confidenceDefault < 0 || confidenceDefault > 1) {
      throw new KnowledgeApplyValidationError("relation_hints confidence_default must be between 0 and 1");
    }
    const endpointObjectProfileId = optionalString(hint.endpoint_object_profile_id);
    if (endpointObjectProfileId) {
      const endpointKind = await getObjectProfileById(db, spaceId, endpointObjectProfileId);
      if (endpointKind.status === "archived") {
        throw new KnowledgeApplyValidationError("relation hint endpoint object kind is archived");
      }
      if (endpointKind.base_object_type !== endpointObjectType) {
        throw new KnowledgeApplyValidationError("relation_hints endpoint_object_profile_id must match endpoint_object_type");
      }
    }
    hints.push({
      endpointObjectType,
      endpointObjectProfileId,
      linkType,
      direction: direction as "from" | "to" | "either",
      confidenceDefault,
      required: hint.required === true,
    });
  }
  return hints;
}

async function insertObjectProfileRelationHints(
  db: Queryable,
  spaceId: string,
  objectProfileId: string,
  hints: readonly ObjectProfileRelationHintPayload[],
  now: string,
): Promise<void> {
  for (const hint of hints) {
    await db.query(
      `INSERT INTO space_object_profile_relation_hints (
         id, space_id, object_profile_id, endpoint_object_type, endpoint_object_profile_id,
         link_type, direction, confidence_default, required, created_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10
       )`,
      [
        randomUUID(),
        spaceId,
        objectProfileId,
        hint.endpointObjectType,
        hint.endpointObjectProfileId,
        hint.linkType,
        hint.direction,
        hint.confidenceDefault,
        hint.required,
        now,
      ],
    );
  }
}

async function replaceObjectProfileRelationHints(
  db: Queryable,
  spaceId: string,
  objectProfileId: string,
  hints: readonly ObjectProfileRelationHintPayload[],
  now: string,
): Promise<void> {
  await db.query(
    `DELETE FROM space_object_profile_relation_hints
      WHERE space_id = $1 AND object_profile_id = $2`,
    [spaceId, objectProfileId],
  );
  await insertObjectProfileRelationHints(db, spaceId, objectProfileId, hints, now);
}

function assertObjectProfileConfigSafe(value: unknown, path: string, depth: number): void {
  if (depth > 8) throw new KnowledgeApplyValidationError(`${path} is too deeply nested`);
  if (Array.isArray(value)) {
    if (value.length > 200) throw new KnowledgeApplyValidationError(`${path} has too many array entries`);
    value.forEach((entry, index) => assertObjectProfileConfigSafe(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (unsafeObjectProfileConfigKey(key)) {
      throw new KnowledgeApplyValidationError(`${path}.${key} is not allowed in object schema config`);
    }
    assertObjectProfileConfigSafe(entry, `${path}.${key}`, depth + 1);
  }
}

function unsafeObjectProfileConfigKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => UNSAFE_OBJECT_PROFILE_CONFIG_KEY_TOKENS.has(token));
}

function objectProfileApplyResult(row: SpaceObjectProfileRow): Record<string, unknown> {
  return {
    object_profile: serializeObjectProfile(row),
    registry_write_performed: true,
    canonical_domain_write_performed: false,
  };
}

function optionalDateIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = optionalString(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new KnowledgeApplyValidationError("invalid timestamp value");
  }
  return date.toISOString();
}

const AFFILIATION_PROVENANCE_SOURCES = new Set(["manual", "import", "source_sync", "agent"]);

function strictMetadataObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeApplyValidationError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validatedObjectRelationMetadata(
  linkType: string,
  value: unknown,
): Record<string, unknown> {
  const metadata = strictMetadataObject(value, "object relation metadata");
  const normalized = { ...metadata };
  if (linkType === "authored_by") {
    const position = metadata.author_position;
    if (position !== null && position !== undefined) {
      if (typeof position !== "number" || !Number.isInteger(position) || position < 1) {
        throw new KnowledgeApplyValidationError("authored_by author_position must be a positive integer or null");
      }
    }
    const corresponding = metadata.is_corresponding;
    if (corresponding !== null && corresponding !== undefined && typeof corresponding !== "boolean") {
      throw new KnowledgeApplyValidationError("authored_by is_corresponding must be a boolean or null");
    }
  }
  if (linkType === "affiliated_with") {
    for (const field of ["role", "title"] as const) {
      const fieldValue = metadata[field];
      if (fieldValue !== null && fieldValue !== undefined && typeof fieldValue !== "string") {
        throw new KnowledgeApplyValidationError(`affiliated_with ${field} must be a string or null`);
      }
    }
    for (const field of ["start_date", "end_date"] as const) {
      const fieldValue = metadata[field];
      if (fieldValue !== null && fieldValue !== undefined && typeof fieldValue !== "string") {
        throw new KnowledgeApplyValidationError(`affiliated_with ${field} must be an ISO timestamp or null`);
      }
      if (fieldValue !== undefined) normalized[field] = optionalDateIso(fieldValue);
    }
    const source = metadata.source;
    if (source !== null && source !== undefined) {
      if (typeof source !== "string" || !AFFILIATION_PROVENANCE_SOURCES.has(source)) {
        throw new KnowledgeApplyValidationError("affiliated_with source is invalid");
      }
    }
  }
  return normalized;
}

function hasPayloadKey(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseJsonArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseConfidence(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0 || value > 1) {
      throw new KnowledgeApplyValidationError("confidence must be between 0 and 1");
    }
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
  }
  throw new KnowledgeApplyValidationError("confidence must be a number between 0 and 1");
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1;
}

function derivePlainText(input: {
  title: string;
  content: string;
  contentJson?: Record<string, unknown> | null;
}): string {
  const chunks = [input.title, contentFromJson(input.contentJson), input.content];
  return chunks
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter(Boolean)
    .join(" ");
}

function contentFromJson(node: Record<string, unknown> | null | undefined): string {
  if (!node) return "";
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (!value) return;
    if (typeof value === "string") {
      const valueText = value.trim();
      if (valueText) out.push(valueText);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    if (typeof value === "object") {
      const objectValue = value as Record<string, unknown>;
      if (typeof objectValue.text === "string" && objectValue.text.trim()) {
        out.push(objectValue.text.trim());
      }
      const nested = objectValue.content;
      if (nested !== undefined) walk(nested);
      return;
    }
  };
  walk(node);
  return out.join(" ");
}

function normalizeDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string | number | Date).toISOString();
}

function titleFromClaimText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function hashClaimText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

class KnowledgeApplyValidationError extends Error {
  readonly statusCode = 422;
}
