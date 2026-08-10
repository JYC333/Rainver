import { defaultExtractionProfileRegistry } from "../extractionProfiles/registry";
import type { Queryable } from "../routeUtils/common";

interface PassingCorpusProfileRow {
  corpus_item_id: string;
  project_id: string;
  source_item_id: string;
  extraction_policy_json: unknown;
}

function extractionProfileKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profileKey = (value as Record<string, unknown>).profile_key;
  return typeof profileKey === "string" && profileKey.trim()
    ? profileKey.trim()
    : null;
}

/**
 * Materializes only active SourceItem corpus rows that have passed triage.
 * The caller then runs the existing SourceItem-to-object promotion so human
 * triage/read state and SourceItem provenance are preserved in one place.
 */
export async function materializePassingProjectCorpusItems(
  db: Queryable,
  input: {
    spaceId: string;
    projectId?: string | null;
    sourceItemId?: string | null;
    corpusItemId?: string | null;
  },
): Promise<number> {
  const result = await db.query<PassingCorpusProfileRow>(
    `SELECT pci.id AS corpus_item_id, pci.project_id, pci.source_item_id,
            binding.extraction_policy_json
       FROM project_corpus_items pci
       JOIN project_source_item_links link
         ON link.space_id = pci.space_id
        AND link.project_id = pci.project_id
        AND link.source_item_id = pci.source_item_id
        AND link.status = 'active'
       JOIN project_source_bindings binding
         ON binding.id = link.project_source_binding_id
        AND binding.space_id = link.space_id
        AND binding.status = 'active'
      WHERE pci.space_id = $1
        AND pci.status = 'active'
        AND pci.object_id IS NULL
        AND pci.source_item_id IS NOT NULL
        AND pci.triage_status IN ('relevant', 'included')
        AND ($2::varchar IS NULL OR pci.project_id = $2)
        AND ($3::varchar IS NULL OR pci.source_item_id = $3)
        AND ($4::varchar IS NULL OR pci.id = $4)
      ORDER BY pci.id, binding.priority DESC, binding.id ASC`,
    [
      input.spaceId,
      input.projectId ?? null,
      input.sourceItemId ?? null,
      input.corpusItemId ?? null,
    ],
  );

  let materialized = 0;
  let currentCorpusItemId: string | null = null;
  for (const row of result.rows) {
    if (row.corpus_item_id === currentCorpusItemId) continue;
    const profileKey = extractionProfileKey(row.extraction_policy_json);
    if (!profileKey) continue;
    const profile = defaultExtractionProfileRegistry.get(profileKey);
    if (!profile) continue;

    const savepoint = "project_corpus_materialization";
    await db.query(`SAVEPOINT ${savepoint}`);
    try {
      const outcome = await defaultExtractionProfileRegistry.materialize(
        profileKey,
        db,
        {
          spaceId: input.spaceId,
          sourceItemId: row.source_item_id,
          projectId: row.project_id,
        },
      );
      await db.query(`RELEASE SAVEPOINT ${savepoint}`);
      if (outcome) {
        currentCorpusItemId = row.corpus_item_id;
        materialized++;
      }
    } catch (error) {
      await db
        .query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        .catch(() => undefined);
      await db.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
      process.stderr.write(
        `[extraction_profile.${profile.entityType}] post-triage materialization failed (${row.source_item_id}): ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }
  return materialized;
}
