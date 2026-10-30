import type { BriefingHighlight } from "@rainver/protocol";
import { HttpError, type Queryable } from "../../routeUtils/common.js";
import { authorizeVersion, visibleResult } from "./authorization.js";
import type { BriefingScopeAdapter } from "./contract.js";
import type { BriefingEgress } from "./execution.js";
import { PgBriefingRepository, type BriefingRow } from "./repository.js";
import { highlightDependencies, type ValidatedBriefing } from "./result.js";

/** One highlight a person acts on, with only the evidence and context it cites, as the audience may read them now. */
export interface AuthorizedHighlight {
  row: BriefingRow;
  index: number;
  highlight: BriefingHighlight;
  evidence: Array<{ key: string; source_item_id: string; title: string; source_domain: string | null }>;
  context: Array<{ key: string; label: string; source: { type: string; id: string; revision: string } }>;
}

const UNAVAILABLE = { code: "briefing_highlight_unavailable" } as const;

/**
 * The briefing, only if it belongs to this scope (its Space, its Project or
 * its owner) and the viewer reads that scope: the first check before anything
 * else is looked up by the briefing's id.
 */
export async function scopedBriefing(db: Queryable, adapter: BriefingScopeAdapter, briefingId: string, viewerId: string): Promise<BriefingRow> {
  if (!(await adapter.canRead(db, viewerId))) throw new HttpError(404, "Briefing not found");
  const row = await new PgBriefingRepository(db).get(adapter.scope.spaceId, briefingId);
  if (!row || row.scope_key !== adapter.scope.key) throw new HttpError(404, "Briefing not found");
  return row;
}

/**
 * Re-authorizes one highlight of a published version for an action on it
 * (a follow-up, an adoption) through the kernel's one rule: the whole
 * briefing must still stand for its audience (its comparison closure
 * included), and every material, signal, collecting Source and context ref
 * the highlight depends on must still be readable. With `egress`, the same
 * must hold for each execution the text would then reach. Anything less is
 * refused — never a partial copy of a highlight.
 */
export async function authorizedHighlight(
  db: Queryable,
  adapter: BriefingScopeAdapter,
  briefingId: string,
  index: number,
  viewerId: string,
  options: { egress?: BriefingEgress[] } = {},
): Promise<AuthorizedHighlight> {
  const row = await scopedBriefing(db, adapter, briefingId, viewerId);
  const repository = new PgBriefingRepository(db);
  const result = row.result_json as ValidatedBriefing | null;
  const highlight = row.status === "ready" ? result?.highlights[index] : undefined;
  if (!result || !highlight) throw new HttpError(404, "This highlight is not available", UNAVAILABLE);
  const inputs = await repository.inputs(row.id);
  const dependencies = highlightDependencies(highlight);
  for (const egress of options.egress?.length ? options.egress : [undefined]) {
    const { allowed } = await authorizeVersion(db, adapter, row, inputs, egress ? { egress } : {});
    if (visibleResult(result, allowed).withheld || !dependencies.every((ref) => allowed.has(ref))) {
      throw new HttpError(403, egress
        ? "Material behind this highlight may not reach that conversation's Agents"
        : "Material behind this highlight is no longer shared", { code: "briefing_highlight_withheld" });
    }
  }
  const cited = inputs.filter((input) => input.ref_kind === "source_item" && input.ref_key && dependencies.includes(input.ref_key));
  const titles = cited.length
    ? new Map((await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM source_items WHERE space_id = $1 AND id = ANY($2::varchar[])`,
      [row.space_id, cited.map((input) => input.source_item_id!)],
    )).rows.map((item) => [item.id, item.title]))
    : new Map<string, string>();
  return {
    row,
    index,
    highlight,
    evidence: cited.map((input) => ({
      key: input.ref_key!, source_item_id: input.source_item_id!,
      title: titles.get(input.source_item_id!) ?? "(untitled)",
      source_domain: (input.analysis_json.source_domain as string | null | undefined) ?? null,
    })),
    context: row.context_json.filter((entry) => dependencies.includes(entry.key))
      .map((entry) => ({ key: entry.key, label: entry.label, source: entry.source })),
  };
}

/** The highlight as plain text, with its citations and an honest note on verification. */
export function renderHighlight(target: AuthorizedHighlight, scopeLabel: string): string {
  const { highlight, row } = target;
  const cite = (refs: string[]) => (refs.length ? ` [${refs.join(", ")}]` : "");
  return [
    `From ${scopeLabel}, briefing version ${row.version} (cut-off ${new Date(row.cutoff_at).toISOString()}):`,
    `${highlight.title} — ${highlight.importance} importance, ${highlight.novelty}`,
    `What changed: ${highlight.what_changed}${cite(highlight.refs)}`,
    ...highlight.statements.map((statement) => `- ${statement.kind.replace("_", " ")}: ${statement.text}${cite(statement.refs)}`),
    `Why it matters: ${highlight.why_it_matters}`,
    highlight.impact.assessment === "affects"
      ? `Impact: ${highlight.impact.text}${cite(highlight.impact.context_refs)}`
      : `Impact: not enough context to judge. ${highlight.impact.text}`,
    ...(highlight.contradictions ? [`Conflicting reports: ${highlight.contradictions}`] : []),
    `Suggested: ${highlight.suggested_action}`,
    "Evidence:",
    ...target.evidence.map((entry) => `[${entry.key}] ${entry.title}${entry.source_domain ? ` (${entry.source_domain})` : ""}`),
    ...(target.context.length ? ["Context:", ...target.context.map((entry) => `[${entry.key}] ${entry.label}`)] : []),
    "Structure and citations were checked; the facts were not independently verified.",
  ].join("\n");
}

export async function scopeLabelOf(db: Queryable, row: Pick<BriefingRow, "scope_type" | "space_id" | "project_id">): Promise<string> {
  if (row.scope_type === "personal") return "your personal briefing";
  const name = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE space_id = $1 AND id = $2`, [row.space_id, row.project_id])).rows[0]?.name;
  return `the briefing of the Project "${(name ?? "Project").slice(0, 120)}"`;
}
