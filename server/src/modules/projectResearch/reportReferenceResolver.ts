import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { evidenceProvenanceReadableClause } from "../sources/sourceItemAccess.js";

export interface ResolvedResearchReferenceExcerpt { id: string; title?: string }
export interface ResolvedResearchReference { id: string; availability: "available" | "unavailable"; title?: string; authors?: string[]; year?: number | null; library_path?: string; academic_path?: string; external_url?: string; excerpts?: ResolvedResearchReferenceExcerpt[] }

interface EvidenceRow { source_item_id: string | null; title: string; source_author: string | null; occurred_at: unknown }
type SourceItemMeta = Omit<ResolvedResearchReference, "id" | "availability" | "excerpts">;

/**
 * Resolves a report's citation entries into the grouped References panel
 * shape: one entry per article (`ref-N`), carrying the article metadata the
 * viewer may read plus the cited evidence excerpts as lettered sub-items
 * (`ref-Na`). Grouping follows the persistent `reference_id` labels written
 * at materialization; entries without one (reports stored before two-level
 * numbering) fall back to one positional group per entry, which reproduces
 * the previous flat output.
 */
export async function resolveResearchReportReferences(db: Queryable, identity: SpaceUserIdentity, content: Record<string, unknown>) {
  const references = collect(content);
  const groups = new Map<string, ResolvedResearchReference>();
  const groupsWithArticle = new Set<string>();
  const evidenceCache = new Map<string, EvidenceRow | null>();
  const sourceItemCache = new Map<string, SourceItemMeta | null>();

  for (let index = 0; index < references.length; index += 1) {
    const ref = references[index]!;
    const label = entryLabel(ref, index + 1);
    const parsed = /^ref-(\d+)([a-z]*)$/.exec(label);
    const groupId = parsed ? `ref-${parsed[1]}` : label;
    const letter = parsed?.[2] ?? "";
    let group = groups.get(groupId);
    if (!group) { group = { id: groupId, availability: "unavailable" }; groups.set(groupId, group); }

    const evidenceToken = text(ref.evidence_id)
    const sourceItemId = text(ref.source_item_id)
    let evidence: EvidenceRow | null = null;
    let article: SourceItemMeta | null = null;
    if (evidenceToken) {
      evidence = await readableEvidence(db, identity, evidenceToken, evidenceCache);
      if (evidence?.source_item_id) article = await readableSourceItem(db, identity, evidence.source_item_id, sourceItemCache);
    } else if (sourceItemId) {
      article = await readableSourceItem(db, identity, sourceItemId, sourceItemCache);
    }

    if (article && !groupsWithArticle.has(groupId)) {
      Object.assign(group, article);
      group.availability = "available";
      groupsWithArticle.add(groupId);
    } else if (!groupsWithArticle.has(groupId)) {
      const doi = text(ref.doi); const arxiv = text(ref.arxiv_id)
      // DOI/arXiv-only citations have no local ACL-bearing source. When a
      // local id is present, however, never use its embedded metadata as an
      // authorization fallback after that local resource fails its read gate.
      if (!evidenceToken && !sourceItemId && doi && !group.external_url) { group.external_url = `https://doi.org/${encodeURIComponent(doi)}`; group.availability = "available"; }
      else if (!evidenceToken && !sourceItemId && arxiv && !group.external_url) { group.external_url = `https://arxiv.org/abs/${encodeURIComponent(arxiv)}`; group.availability = "available"; }
      else if (evidence && group.availability === "unavailable") {
        group.availability = "available";
        group.title = evidence.title;
        if (evidence.source_author) group.authors = [evidence.source_author];
        group.year = year(evidence.occurred_at);
      }
    }

    if (letter) {
      group.excerpts ??= [];
      if (!group.excerpts.some((excerpt) => excerpt.id === label)) {
        group.excerpts.push({ id: label, ...(evidence?.title ? { title: evidence.title } : {}) });
      }
    }
  }
  return { content: sanitize(content), resolved: [...groups.values()] };
}

/** The persistent materialization label, or the positional fallback for legacy reports. */
function entryLabel(ref: Record<string, unknown>, positionalIndex: number): string {
  const id = ref.reference_id;
  return typeof id === "string" && id.trim() ? id.trim() : `ref-${positionalIndex}`;
}

async function readableSourceItem(
  db: Queryable, identity: SpaceUserIdentity, sourceItemId: string,
  cache: Map<string, SourceItemMeta | null>,
): Promise<SourceItemMeta | null> {
  const cached = cache.get(sourceItemId);
  if (cached !== undefined) return cached;
  const row = await db.query<{ title: string; metadata_json: unknown; occurred_at: unknown; reference_object_id: string | null }>(
    `SELECT si.title,si.metadata_json,si.occurred_at,sir.reference_object_id FROM source_items si
      LEFT JOIN source_connections sc ON sc.id=si.connection_id
      LEFT JOIN source_item_references sir ON sir.source_item_id=si.id AND sir.space_id=si.space_id
     WHERE si.id=$1 AND si.space_id=$2 AND si.deleted_at IS NULL
       AND ${contentReadSql("source_item", "si", "$3")}
       AND (si.created_by_user_id=$3 OR sc.consent_json->>'owner_user_id'=$3
         OR sc.consent_json->'allowed_reader_user_ids' @> to_jsonb($3::text)
         OR EXISTS (SELECT 1 FROM source_channel_user_subscriptions su JOIN source_channels ch ON ch.id=su.source_channel_id
                     WHERE su.space_id=$2 AND su.user_id=$3 AND su.status='subscribed' AND ch.source_connection_id=si.connection_id)
         OR ((sc.consent_json->>'allow_space_admins')::boolean=true AND EXISTS
             (SELECT 1 FROM space_memberships sm WHERE sm.space_id=$2 AND sm.user_id=$3 AND sm.status='active' AND sm.role IN ('owner','admin'))))`,
    [sourceItemId, identity.spaceId, identity.userId],
  );
  let meta: SourceItemMeta | null = null;
  if (row.rows[0]) {
    const metadata = object(row.rows[0].metadata_json)
    meta = {
      title: row.rows[0].title,
      authors: stringArray(metadata.authors),
      year: year(metadata.year) ?? year(row.rows[0].occurred_at),
      library_path: `/library/items/${sourceItemId}`,
      ...(row.rows[0].reference_object_id ? { academic_path: `/knowledge/sources?object=${encodeURIComponent(row.rows[0].reference_object_id)}` } : {}),
    }
  }
  cache.set(sourceItemId, meta);
  return meta;
}

/**
 * Synthesis models have been observed citing an evidence row by the first
 * UUID segment instead of the full id, so a hex prefix of at least 8 chars is
 * also accepted when it identifies exactly one readable row in the space.
 */
async function readableEvidence(
  db: Queryable, identity: SpaceUserIdentity, evidenceId: string,
  cache: Map<string, EvidenceRow | null>,
): Promise<EvidenceRow | null> {
  const cached = cache.get(evidenceId);
  if (cached !== undefined) return cached;
  const prefixed = /^[0-9a-f][0-9a-f-]{7,35}$/i.test(evidenceId)
  const rows = await db.query<EvidenceRow>(
    `SELECT COALESCE(ee.source_item_id, ee.origin_source_item_id) AS source_item_id,
            ee.title, ee.source_author, ee.occurred_at
       FROM extracted_evidence ee
       LEFT JOIN source_items evidence_source
         ON evidence_source.id=COALESCE(ee.source_item_id,ee.origin_source_item_id)
        AND evidence_source.space_id=ee.space_id
        AND evidence_source.deleted_at IS NULL
      WHERE ee.space_id=$2 AND ee.deleted_at IS NULL
        AND (ee.id=$1 OR ($4::boolean AND ee.id LIKE $1 || '%'))
        AND ${contentReadSql("extracted_evidence", "ee", "$3")}
        AND ${evidenceProvenanceReadableClause("ee", "$3")}
      LIMIT 2`,
    [evidenceId, identity.spaceId, identity.userId, prefixed],
  );
  const row = rows.rows.length === 1 ? rows.rows[0]! : null;
  cache.set(evidenceId, row);
  return row;
}

function collect(content: Record<string, unknown>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  for (const section of [content.findings, content.sources, content.ideas]) if (Array.isArray(section)) for (const item of section) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const refs = (item as Record<string, unknown>).references
    if (Array.isArray(refs)) for (const ref of refs) if (ref && typeof ref === "object" && !Array.isArray(ref)) result.push(ref as Record<string, unknown>)
  }
  return result
}
function sanitize(content: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(content)
  let index = 0
  for (const section of [copy.findings, copy.sources, copy.ideas]) if (Array.isArray(section)) for (const item of section) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const refs = (item as Record<string, unknown>).references
    if (Array.isArray(refs)) (item as Record<string, unknown>).references = refs.map((ref) => {
      index += 1
      const label = ref && typeof ref === "object" && !Array.isArray(ref) ? entryLabel(ref as Record<string, unknown>, index) : `ref-${index}`
      return { reference_id: label }
    })
  }
  return copy
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringArray(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim()) : []
  return values.length ? values : undefined
}
function year(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 9999) return value
  if (typeof value !== "string" && !(value instanceof Date)) return null
  const parsed = new Date(value).getUTCFullYear()
  return Number.isInteger(parsed) && parsed >= 1000 && parsed <= 9999 ? parsed : null
}
