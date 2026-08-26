import type { Queryable } from "../routeUtils/common.js";

/**
 * Assigns persistent two-level reference ids to every citation entry of a
 * research report before it is stored: articles are numbered ref-1..ref-K in
 * first-appearance order, and when an article is cited through two or more
 * distinct evidence rows each citation gets a letter suffix (ref-2a, ref-2b).
 * Truncated evidence ids observed from synthesis models are normalized to
 * the full row id in the same pass.
 *
 * Runs at materialization without viewer access control: numbering must be
 * identical for every reader, and the stored `reference_id` is what the
 * reader projection, the reference resolver, and inline prose citations all
 * share afterwards.
 */
export async function assignReportReferenceIds(
  db: Queryable,
  spaceId: string,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const copy = structuredClone(content);
  const infos: { entry: Record<string, unknown>; groupKey: string; evidenceId: string | null }[] = [];
  const evidenceCache = new Map<string, { id: string; source_item_id: string | null } | null>();
  let position = 0;

  for (const section of [copy.findings, copy.sources, copy.ideas]) {
    if (!Array.isArray(section)) continue;
    for (const item of section) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const references = (item as Record<string, unknown>).references;
      if (!Array.isArray(references)) continue;
      for (const ref of references) {
        position += 1;
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
        const entry = ref as Record<string, unknown>;
        const evidenceToken = text(entry.evidence_id);
        if (evidenceToken) {
          const row = await lookupEvidence(db, spaceId, evidenceToken, evidenceCache);
          if (row) {
            entry.evidence_id = row.id;
            infos.push({ entry, groupKey: row.source_item_id ? `source:${row.source_item_id}` : `evidence:${row.id}`, evidenceId: row.id });
          } else {
            infos.push({ entry, groupKey: `evidence:${evidenceToken}`, evidenceId: evidenceToken });
          }
          continue;
        }
        const sourceItemId = text(entry.source_item_id);
        const objectId = text(entry.object_id);
        const doi = text(entry.doi);
        const arxiv = text(entry.arxiv_id);
        const groupKey = sourceItemId ? `source:${sourceItemId}`
          : doi ? `doi:${doi.toLowerCase()}`
            : arxiv ? `arxiv:${arxiv.toLowerCase()}`
              : objectId ? `object:${objectId}`
                : `entry:${position}`;
        infos.push({ entry, groupKey, evidenceId: null });
      }
    }
  }

  const groups = new Map<string, { index: number; evidenceIds: string[] }>();
  for (const info of infos) {
    let group = groups.get(info.groupKey);
    if (!group) { group = { index: groups.size + 1, evidenceIds: [] }; groups.set(info.groupKey, group); }
    if (info.evidenceId && !group.evidenceIds.includes(info.evidenceId)) group.evidenceIds.push(info.evidenceId);
  }
  for (const info of infos) {
    const group = groups.get(info.groupKey)!;
    const letter = info.evidenceId && group.evidenceIds.length >= 2
      ? letterSuffix(group.evidenceIds.indexOf(info.evidenceId))
      : "";
    info.entry.reference_id = `ref-${group.index}${letter}`;
  }
  return copy;
}

async function lookupEvidence(
  db: Queryable,
  spaceId: string,
  token: string,
  cache: Map<string, { id: string; source_item_id: string | null } | null>,
): Promise<{ id: string; source_item_id: string | null } | null> {
  const cached = cache.get(token);
  if (cached !== undefined) return cached;
  const prefixed = /^[0-9a-f][0-9a-f-]{7,35}$/i.test(token);
  const rows = await db.query<{ id: string; source_item_id: string | null }>(
    `SELECT id, COALESCE(source_item_id, origin_source_item_id) AS source_item_id FROM extracted_evidence
      WHERE space_id=$2 AND deleted_at IS NULL AND (id=$1 OR ($3::boolean AND id LIKE $1 || '%'))
      LIMIT 2`,
    [token, spaceId, prefixed],
  );
  const row = rows.rows.length === 1 ? rows.rows[0]! : null;
  cache.set(token, row);
  return row;
}

function letterSuffix(index: number): string {
  let value = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return suffix;
}

function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null }
