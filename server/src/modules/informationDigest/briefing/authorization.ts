import type { BriefingHighlight } from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { collectingKey, collectingRefs, materialRevisions, readableCollecting } from "./candidates.js";
import { contextSourceKey, signalKey, type BriefingContextEntry, type BriefingDeps, type BriefingScopeAdapter } from "./contract.js";
import { sourceEgressAllowed, type BriefingExecution } from "./execution.js";
import type { BriefingInputRow, BriefingRow } from "./repository.js";
import { highlightDependencies } from "./result.js";

export interface VersionAuthorization {
  /** S/C refs every current audience member may still read (and, when asked, that may still reach this model). */
  allowed: Set<string>;
  /** S refs whose frozen material, analysis or signal revision is no longer current (only when asked). */
  changed: Set<string>;
  /** Frozen context is no longer the current Project context. */
  outdated: boolean;
  /** Every included ref of the version. */
  refs: string[];
}

/** The dependencies frozen with one included input; an input without any is its lead item alone. */
export function inputDeps(input: BriefingInputRow): BriefingDeps {
  const deps = input.analysis_json.deps as BriefingDeps | undefined;
  return deps ?? { items: [{ id: input.source_item_id!, connection_id: null, revision: input.content_revision ?? "" }], annotations: [], signals: [] };
}

/** One comparison text of a version, with the full dependency closure of where it came from. */
export interface ComparisonEntry {
  title: string;
  what_changed: string;
  refs: string[];
  previous_briefing_id: string;
  deps: BriefingDeps;
  context: BriefingContextEntry["source"][];
}

/** Every dependency and context source a set of comparison entries rests on. */
export function comparisonClosure(entries: ComparisonEntry[]): { deps: BriefingDeps; context: BriefingContextEntry["source"][] } {
  return {
    deps: {
      items: entries.flatMap((entry) => entry.deps.items),
      annotations: entries.flatMap((entry) => entry.deps.annotations),
      signals: entries.flatMap((entry) => entry.deps.signals),
    },
    context: [...new Map(entries.flatMap((entry) => entry.context).map((source) => [contextSourceKey(source), source])).values()],
  };
}

/**
 * The one authorization rule of a frozen version, used before dispatch, at
 * publication and on every read (and when a published version is offered as
 * comparison for the next). A material ref stands only when
 * - every item whose text it sent is still fully readable by the whole
 *   current audience;
 * - every analysis and scope judgment behind it came through a Source the
 *   whole audience may still read (the canonical Source reader gate, no
 *   oversight), and every scope signal is still offered;
 * - with `egress`, every Source connection behind it still consents to that
 *   model.
 * A context ref stands while it is still shared with the audience. The
 * version's comparison texts carry the dependency closure of the previous
 * versions they came from: if anything in that closure no longer stands,
 * nothing of the version stands, since any of its text may rest on it. With
 * `revisions`, any material dependency whose content, analysis or text
 * changed since freezing is reported.
 */
export async function authorizeVersion(
  db: Queryable,
  adapter: BriefingScopeAdapter,
  row: Pick<BriefingRow, "space_id" | "context_json" | "comparison_json">,
  inputs: BriefingInputRow[],
  options: { egress?: BriefingExecution; revisions?: boolean } = {},
): Promise<VersionAuthorization> {
  const material = inputs.filter((input) => input.ref_kind === "source_item" && input.ref_key && input.status === "included");
  const deps = material.map((input) => ({ key: input.ref_key!, deps: inputDeps(input) }));
  const closure = comparisonClosure((row.comparison_json ?? []) as ComparisonEntry[]);
  const everything = [...deps.map((entry) => entry.deps), closure.deps];
  const itemIds = everything.flatMap((entry) => entry.items.map((dep) => dep.id));
  const signals = everything.flatMap((entry) => entry.signals);
  const [audience, allowedItems, signalState] = await Promise.all([
    adapter.audience(db),
    adapter.allowedItems(db, itemIds),
    adapter.signalState(db, signals),
  ]);
  const readable = await readableCollecting(db, row.space_id, audience, collectingRefs(everything));
  const egress = new Map<string, boolean>();
  const consents = async (connectionId: string | null) => {
    if (!connectionId || !options.egress) return true;
    if (!egress.has(connectionId)) egress.set(connectionId, await sourceEgressAllowed(db, row.space_id, connectionId, options.egress));
    return egress.get(connectionId)!;
  };
  const stands = async (entry: BriefingDeps) => {
    if (!entry.items.every((dep) => allowedItems.has(dep.id))) return false;
    if (!entry.signals.every((dep) => signalState.has(signalKey(dep)))) return false;
    if (!collectingRefs([entry]).every((ref) => readable.has(collectingKey(ref)))) return false;
    for (const dep of [...entry.items, ...entry.annotations, ...entry.signals]) if (!(await consents(dep.connection_id))) return false;
    return true;
  };
  const allowed = new Set<string>();
  for (const entry of deps) if (await stands(entry.deps)) allowed.add(entry.key);
  const changed = new Set<string>();
  if (options.revisions) {
    const current = await materialRevisions(
      db, row.space_id, deps.flatMap((entry) => entry.deps.items.map((dep) => dep.id)), deps.flatMap((entry) => entry.deps.annotations.map((dep) => dep.id)),
    );
    for (const entry of deps) {
      const stale = entry.deps.items.some((dep) => current.items.get(dep.id) !== dep.revision)
        || entry.deps.annotations.some((dep) => current.annotations.get(dep.id) !== dep.revision)
        || entry.deps.signals.some((dep) => signalState.has(signalKey(dep)) && signalState.get(signalKey(dep)) !== dep.revision);
      if (stale) changed.add(entry.key);
    }
  }
  const context = await adapter.contextState(db, row.context_json.map((entry) => entry.source as never));
  for (const entry of row.context_json) if (context.allowed.has(contextSourceKey(entry.source as never))) allowed.add(entry.key);
  // Comparison context is historical (a Task may be done since): only whether it is still shared counts.
  const historical = closure.context.length ? await adapter.contextState(db, closure.context) : { allowed: new Set<string>() };
  const comparisonStands = await stands(closure.deps) && closure.context.every((source) => historical.allowed.has(contextSourceKey(source)));
  return {
    allowed: comparisonStands ? allowed : new Set(),
    changed,
    outdated: context.outdated,
    refs: [...material.map((input) => input.ref_key!), ...row.context_json.map((entry) => entry.key)],
  };
}

/**
 * A published result as `allowed` permits: the overview summarizes
 * everything, so when it depends on something not allowed the whole briefing
 * is withheld; otherwise each highlight or question is hidden when anything it
 * depends on is.
 */
export function visibleResult(
  result: null | { overview: { text: string; refs: string[] }; highlights: BriefingHighlight[]; open_questions: Array<{ text: string; refs: string[] }> },
  allowed: Set<string>,
) {
  const visible = (refs: string[]) => refs.every((ref) => allowed.has(ref));
  const units = result ? 1 + result.highlights.length + result.open_questions.length : 0;
  if (!result) return { overview: null, highlights: [], open_questions: [], withheld: false, units, shown: 0 };
  if (!visible(result.overview.refs)) return { overview: null, highlights: [], open_questions: [], withheld: true, units, shown: 0 };
  const highlights = result.highlights.filter((highlight) => visible(highlightDependencies(highlight)));
  const questions = result.open_questions.filter((question) => visible(question.refs));
  return { overview: result.overview, highlights, open_questions: questions, withheld: false, units, shown: 1 + highlights.length + questions.length };
}
