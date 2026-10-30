import type { Briefing, BriefingEvidence, BriefingHighlight, BriefingSummary } from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { authorizeVersion, visibleResult } from "./authorization.js";
import type { BriefingScopeAdapter } from "./contract.js";
import type { BriefingRow, PgBriefingRepository } from "./repository.js";

const iso = (value: string | null): string | null => (value ? new Date(value).toISOString() : null);

export function briefingSummary(row: BriefingRow): BriefingSummary {
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    status: row.status,
    outcome: row.outcome,
    comparison: row.comparison,
    period_date: row.period_date,
    cutoff_at: iso(row.cutoff_at)!,
    created_at: iso(row.created_at)!,
    completed_at: iso(row.completed_at),
    checked_at: iso(row.checked_at),
    error_code: row.error_code,
  };
}

/**
 * A briefing as the current audience may see it. Every reference is checked
 * now through `authorizeVersion` — the same rule dispatch and publication use
 * — not when it was generated: an item of a merged family, a scope signal,
 * or context the whole audience can no longer read hides every unit
 * depending on it; when the overview does, the whole briefing is withheld.
 * Evidence lists only what remains visible.
 */
export async function projectBriefing(
  db: Queryable,
  repository: PgBriefingRepository,
  adapter: BriefingScopeAdapter,
  row: BriefingRow,
): Promise<Briefing> {
  const inputs = await repository.inputs(row.id);
  const authorization = await authorizeVersion(db, adapter, row, inputs);
  const { allowed } = authorization;
  const shown = visibleResult(row.result_json as Parameters<typeof visibleResult>[0], allowed);
  let visibility: Briefing["visibility"] = shown.withheld ? "withheld" : shown.shown < shown.units ? "partial" : "visible";
  if (!row.result_json) visibility = "visible";

  const material = inputs.filter((input) => input.ref_kind === "source_item" && input.ref_key && input.status === "included" && allowed.has(input.ref_key));
  const items = material.length
    ? (await db.query<{ id: string; title: string; occurred_at: string | null }>(
      `SELECT id, title, occurred_at::text FROM source_items WHERE space_id = $1 AND id = ANY($2::varchar[])`,
      [row.space_id, material.map((input) => input.source_item_id!)],
    )).rows
    : [];
  const itemById = new Map(items.map((item) => [item.id, item]));
  const evidence: BriefingEvidence[] = shown.withheld ? [] : material
    .filter((input) => itemById.has(input.source_item_id!))
    .map((input) => {
      const item = itemById.get(input.source_item_id!)!;
      return {
        key: input.ref_key!,
        source_item_id: input.source_item_id!,
        title: item.title,
        source_domain: (input.analysis_json.source_domain as string | null | undefined) ?? null,
        occurred_at: iso(item.occurred_at),
        delta_class: input.delta_class as BriefingEvidence["delta_class"],
        unverified: input.analysis_json.unverified === true,
        lenses: ((input.analysis_json.lenses ?? []) as BriefingEvidence["lenses"]),
      };
    });
  const runStatus = row.status === "queued" && row.run_id
    ? (await db.query<{ status: string }>(`SELECT status FROM runs WHERE space_id = $1 AND id = $2`, [row.space_id, row.run_id])).rows[0]?.status ?? null
    : null;
  return {
    ...briefingSummary(row),
    scope_type: row.scope_type,
    previous_briefing_id: row.previous_briefing_id,
    run_status: runStatus,
    coverage: row.coverage_json,
    visibility,
    hidden_units: shown.units - shown.shown,
    overview: shown.overview,
    highlights: shown.highlights as BriefingHighlight[],
    open_questions: shown.open_questions,
    evidence,
    context: shown.withheld ? [] : row.context_json
      .filter((entry) => allowed.has(entry.key))
      .map((entry) => ({ key: entry.key, kind: entry.kind as Briefing["context"][number]["kind"], label: entry.label })),
    context_outdated: authorization.outdated,
  };
}
