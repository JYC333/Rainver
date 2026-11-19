import type { Queryable } from "../routeUtils/common.js";
import { writeProvenanceLinks } from "../memory/memoryApplyProvenance.js";
import {
  SOURCE_LINEAGE_PINNED_CONNECTIONS_KEY,
  SOURCE_LINEAGE_PROVENANCE_TYPES,
  loadSourceConnectionIdsForTargets,
} from "../retrieval/sourcePolicy.js";

/**
 * Text derived from other Notes keeps their Source policy: the Note it is written
 * into inherits every Source lineage entry (`source_item`, `source_snapshot`,
 * `extracted_evidence` provenance) those Notes carry, through the canonical
 * provenance writer, in the caller's write transaction. Every later read, model
 * send and retrieval of that Note then answers to the same Sources' readers and
 * egress consent as the text it came from.
 *
 * Each inherited entry also pins the Source connections the text was derived
 * under (`SOURCE_LINEAGE_PINNED_CONNECTIONS_KEY`): the inputs' lineage connections
 * resolved now, plus `pinConnectionIds` (connections the caller resolved earlier,
 * for example when the derivation started). A later `source.item.update` that
 * rebinds or clears an item's connection therefore never drops the original
 * Source's policy from the derived Note. An entry the Note already carries with
 * the same pins is not duplicated; nothing is removed. Returns entries added.
 *
 * `includeTarget` is for an in-place edit whose prompt also copied the target Note's
 * own body: the target's own lineage is then an input too, and its entries are re-pinned
 * to the frozen connections, so a rebind after the prompt was frozen cannot detach the
 * edited text from the Source it was read under.
 */
export async function inheritNoteSourceLineage(
  db: Queryable,
  input: { spaceId: string; noteId: string; fromNoteIds: readonly string[]; pinConnectionIds?: readonly string[]; includeTarget?: boolean },
): Promise<number> {
  const from = [...new Set(input.fromNoteIds)].filter(id => input.includeTarget || id !== input.noteId);
  if (!from.length) return 0;
  const live = await loadSourceConnectionIdsForTargets(db, input.spaceId, "note", from);
  const pins = [...new Set([...[...live.values()].flat(), ...(input.pinConnectionIds ?? [])])].sort();
  const rows = (await db.query<{ source_type: string; source_id: string }>(
    `SELECT DISTINCT pl.source_type, pl.source_id
       FROM provenance_links pl
      WHERE pl.space_id=$1 AND pl.target_type='note' AND pl.target_id=ANY($2::varchar[])
        AND pl.source_type=ANY($4::varchar[])
        AND NOT EXISTS (SELECT 1 FROM provenance_links own
                         WHERE own.space_id=pl.space_id AND own.target_type='note' AND own.target_id=$3
                           AND own.source_type=pl.source_type AND own.source_id=pl.source_id
                           AND COALESCE(own.evidence_json->'${SOURCE_LINEAGE_PINNED_CONNECTIONS_KEY}','[]'::jsonb) @> $5::jsonb)
      ORDER BY pl.source_type, pl.source_id`,
    [input.spaceId, from, input.noteId, [...SOURCE_LINEAGE_PROVENANCE_TYPES], JSON.stringify(pins)],
  )).rows;
  return writeProvenanceLinks(db, {
    spaceId: input.spaceId,
    targetType: "note",
    targetId: input.noteId,
    entries: rows.map(row => ({
      source_type: row.source_type,
      source_id: row.source_id,
      evidence_json: { inherited_from_note_ids: from, [SOURCE_LINEAGE_PINNED_CONNECTIONS_KEY]: pins },
    })),
  });
}

/**
 * Text copied from Source items directly (a selected excerpt a model wrote into a Note)
 * keeps those items' Source policy the same way: the Note gets a `source_item` lineage
 * entry per item, pinned to `pins.get(item)` — the connections the item was read under
 * when the derivation started plus its connection now (see `sourceItemLineagePins`).
 * An entry already carried with those pins is not duplicated. Returns entries added.
 */
export async function recordNoteSourceItemLineage(
  db: Queryable,
  input: { spaceId: string; noteId: string; pins: ReadonlyMap<string, readonly string[]> },
): Promise<number> {
  const entries = [];
  for (const [itemId, connections] of [...input.pins].sort(([a], [b]) => a.localeCompare(b))) {
    const pins = [...new Set(connections)].sort();
    const held = await db.query(
      `SELECT 1 FROM provenance_links WHERE space_id=$1 AND target_type='note' AND target_id=$2 AND source_type='source_item' AND source_id=$3
          AND COALESCE(evidence_json->'${SOURCE_LINEAGE_PINNED_CONNECTIONS_KEY}','[]'::jsonb) @> $4::jsonb LIMIT 1`,
      [input.spaceId, input.noteId, itemId, JSON.stringify(pins)],
    );
    if (!held.rows.length) entries.push({ source_type: "source_item", source_id: itemId, evidence_json: { [SOURCE_LINEAGE_PINNED_CONNECTIONS_KEY]: pins } });
  }
  return writeProvenanceLinks(db, { spaceId: input.spaceId, targetType: "note", targetId: input.noteId, entries });
}

/**
 * The lineage pins that let a Note carry each copied Source item's policy: the
 * connections frozen for the item when the derivation started (`frozen`) and its live
 * connection (an item bound to no Source carries none). `null` when the constraint
 * cannot be kept — an item is gone, or the derivation froze no connections for it, so
 * which Source its text came under is unknown — and the caller writes nothing rather
 * than a Note readable without that policy.
 */
export async function sourceItemLineagePins(
  db: Queryable,
  spaceId: string,
  itemIds: readonly string[],
  frozen: Readonly<Record<string, readonly string[]>> | null,
): Promise<Map<string, string[]> | null> {
  const ids = [...new Set(itemIds)].sort();
  if (!ids.length) return new Map();
  if (!frozen || ids.some(id => !(id in frozen))) return null;
  const live = new Map((await db.query<{ id: string; connection_id: string | null }>(
    `SELECT id,connection_id FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[]) AND deleted_at IS NULL`,
    [spaceId, ids],
  )).rows.map(row => [row.id, row.connection_id]));
  const out = new Map<string, string[]>();
  for (const id of ids) {
    if (!live.has(id)) return null;
    const pins = [...new Set([...(frozen[id] ?? []), live.get(id)].filter((c): c is string => typeof c === "string" && !!c))].sort();
    out.set(id, pins);
  }
  return out;
}
