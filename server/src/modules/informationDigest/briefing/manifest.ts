import type { BriefingCoverage, BriefingDeltaClass } from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import {
  BRIEFING_LIMITS, sha256,
  type BriefingCandidate, type BriefingContextEntry, type BriefingDeps, type BriefingLens, type BriefingScopeAdapter,
} from "./contract.js";
import { collectingKey, readableCollecting } from "./candidates.js";
import type { ComparisonEntry } from "./authorization.js";
import {
  BLOCK_LEVELS, assertWithinBudget, renderBlock, renderComparison, renderContext, renderFrame, renderInstruction,
} from "./prompt.js";

/** One frozen input of the previous version, as the next version compares to it. */
export interface PreviousInput {
  ref_key: string | null;
  source_item_id: string | null;
  family_key: string | null;
  content_revision: string | null;
  status: string;
  item_ids: string[];
}

/** A highlight of the previous version that the whole audience may still read, with the families it rests on. */
/**
 * A highlight of the previous version that the whole audience may still read,
 * with the families it rests on and the full dependency closure of its text:
 * every dependency of every material ref it cited, every context source it
 * cited, and the closure that version itself inherited from its comparison.
 */
export interface PreviousHighlight {
  title: string;
  what_changed: string;
  families: string[];
  deps: BriefingDeps;
  context: BriefingContextEntry["source"][];
}

export interface PreviousVersion {
  /** The latest version with a published briefing: the comparison chain never runs through "nothing new" checks. */
  id: string;
  cutoff_at: string;
  context_hash: string;
  /** This version's own inputs: what was left pending is carried forward. */
  inputs: PreviousInput[];
  /** Every reading family a published version of this scope already briefed, with its latest briefed revision. */
  known: Map<string, string | null>;
  highlights: PreviousHighlight[];
}

export type ManifestInputStatus = "included" | "not_ready" | "truncated" | "egress_refused" | "not_shared";

export interface ManifestInput {
  ref_key: string | null;
  status: ManifestInputStatus;
  delta_class: BriefingDeltaClass | null;
  family_key: string | null;
  /** Content-addressed revision of the family's kept material and analysis. */
  revision: string | null;
  /** The item whose title, summary and excerpt are sent; null for an item not shared with the audience. */
  lead: BriefingCandidate | null;
  /** Every Source item of the family (sent or not): carried forward when pending. */
  item_ids: string[];
  unverified: boolean;
  lenses: BriefingLens[];
  signals: string[];
  /** Every record whose text this input sends, with revisions and Source connections. */
  deps: BriefingDeps;
  activity_at: string | null;
  /** The exact text sent for this input; null when it is not sent. */
  block: string | null;
}

export interface ManifestContext extends BriefingContextEntry { key: string }

export interface BriefingManifest {
  since: string;
  cutoff: string;
  comparison: "baseline" | "delta";
  context_changed: boolean;
  inputs: ManifestInput[];
  context: ManifestContext[];
  coverage: BriefingCoverage;
  /** Whether a model Run has anything to do: news, or background to reassess after a context change. */
  needs_run: boolean;
  /** Previous highlights sent as comparison, each with its dependency closure: the whole version rests on them. */
  comparison_entries: ComparisonEntry[];
  prompt: string;
  instruction: string;
  /** Hash of everything sent about material (blocks, comparison, dependencies and revisions). */
  input_hash: string;
  context_hash: string;
}

const DELTA_PRIORITY: Record<BriefingDeltaClass, number> = {
  evidenced_change: 0, revised: 1, new_publication: 2, newly_found: 3, unknown_time: 4, baseline: 5, background: 6,
};
const PENDING: ReadonlySet<string> = new Set(["not_ready", "truncated", "egress_refused", "not_shared"]);
const EMPTY_DEPS: BriefingDeps = { items: [], annotations: [], signals: [] };

/**
 * Freezes what one version is about. Deterministic for the same scope state:
 * - reading families (same capture: canonical URL + initial hash) are merged,
 *   so a repost is one input, not two confirmations. This is not event
 *   merging: different URLs about one event stay separate inputs, and the
 *   model groups them against the previous briefing's highlights;
 * - every member, annotation and scope signal of a family is gated on its own
 *   Source's model-egress consent; a refused one contributes nothing, so no
 *   text rides in through another member;
 * - against the previous published version, an unchanged family is not news;
 *   a changed content/analysis revision is `revised`; a recorded evidenced
 *   change is `evidenced_change`; material published since the last cut-off
 *   is `new_publication`, older material found only now `newly_found`;
 * - the previous version's still-readable highlights and their material come
 *   along as `background` for comparison, and to reassess impact when the
 *   Project context changed;
 * - inputs left out (not analysed, over the bound, refused, not shared) are
 *   carried to the next version;
 * - the whole request (prompt + instruction) is held to a hard character
 *   budget by shortening every block, then truncating the lowest-priority
 *   inputs (carried) — never by cutting text mid-way unrecorded.
 * Nothing here calls a model or writes.
 */
export async function buildManifest(
  db: Queryable,
  adapter: BriefingScopeAdapter,
  input: {
    cutoff: string;
    previous: PreviousVersion | null;
    label: string;
    egressAllowed: (connectionId: string) => Promise<boolean>;
  },
): Promise<BriefingManifest> {
  const { cutoff, previous } = input;
  const since = previous?.cutoff_at
    ?? new Date(Date.parse(cutoff) - BRIEFING_LIMITS.baselineWindowDays * 86_400_000).toISOString();
  const carryItemIds = previous
    ? [...new Set(previous.inputs.filter((row) => PENDING.has(row.status)).flatMap((row) => row.item_ids.length ? row.item_ids : [row.source_item_id!]))]
      .slice(0, BRIEFING_LIMITS.maxCarry)
    : [];
  const comparisonHighlights = (previous?.highlights ?? []).slice(0, BRIEFING_LIMITS.maxComparisonHighlights);
  const backgroundFamilies = new Set(comparisonHighlights.flatMap((highlight) => highlight.families).slice(0, BRIEFING_LIMITS.maxBackgroundFamilies));
  const backgroundItemIds = previous
    ? previous.inputs.filter((row) => row.family_key && backgroundFamilies.has(row.family_key) && row.status === "included").flatMap((row) => row.item_ids)
    : [];
  const carried = new Set(carryItemIds);
  const offered = await adapter.candidates(db, { since, cutoff, pinnedItemIds: [...new Set([...carryItemIds, ...backgroundItemIds])] });

  // An analysis or judgment travels only when its own collecting Source is readable by the whole audience.
  const readable = await readableCollecting(db, adapter.scope.spaceId, await adapter.audience(db),
    offered.rows.flatMap((row) => [...(row.annotation ? [row.annotation] : []), ...row.signals.map((signal) => signal.dep)])
      .map((dep) => ({ connection_id: dep.connection_id, at: dep.at })));
  const shared = (dep: { connection_id: string | null; at: string | null }) => readable.has(collectingKey(dep));
  const egress = new Map<string, boolean>();
  const allows = async (connectionId: string | null) => {
    if (!connectionId) return true;
    if (!egress.has(connectionId)) egress.set(connectionId, await input.egressAllowed(connectionId));
    return egress.get(connectionId)!;
  };

  const families = new Map<string, BriefingCandidate[]>();
  for (const row of offered.rows) families.set(row.family_key, [...(families.get(row.family_key) ?? []), row]);
  const known = previous?.known ?? new Map<string, string | null>();
  let mergedDuplicates = 0;
  let unchanged = 0;
  let carriedCount = 0;
  const staged: ManifestInput[] = [];
  for (const [family, group] of families) {
    mergedDuplicates += group.length - 1;
    const itemIds = group.map((row) => row.source_item_id).sort();
    if (itemIds.some((id) => carried.has(id))) carriedCount += 1;
    // Each member, annotation and signal travels only under its own Source's consent.
    const kept: BriefingCandidate[] = [];
    for (const member of group) {
      if (!(await allows(member.connection_id))) continue;
      const annotation = member.annotation && shared(member.annotation) && (await allows(member.annotation.connection_id)) ? member.annotation : null;
      const signals = [];
      for (const signal of member.signals) if (shared(signal.dep) && (await allows(signal.dep.connection_id))) signals.push(signal);
      kept.push({ ...member, annotation, summary: annotation ? member.summary : null, signals });
    }
    if (kept.length === 0) {
      staged.push(pending("egress_refused", family, itemIds, group));
      continue;
    }
    const lead = [...kept].sort((a, b) => Number(isReady(b)) - Number(isReady(a))
      || b.activity_at.localeCompare(a.activity_at) || a.source_item_id.localeCompare(b.source_item_id))[0]!;
    const deps: BriefingDeps = {
      items: kept.map((row) => ({ id: row.source_item_id, connection_id: row.connection_id, revision: row.content_revision }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      annotations: kept.flatMap((row) => (row.annotation ? [row.annotation] : [])).sort((a, b) => a.id.localeCompare(b.id)),
      signals: kept.flatMap((row) => row.signals.map((signal) => signal.dep)).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
    };
    const revision = sha256([
      [...new Set(deps.items.map((dep) => dep.revision))].sort(),
      [...new Set(deps.annotations.map((dep) => dep.revision))].sort(),
    ]).slice(0, 32);
    const allSignals = kept.flatMap((row) => row.signals);
    const changeAt = allSignals.map((signal) => signal.change_at).filter((at): at is string => Boolean(at)).sort().pop() ?? null;
    const changedSince = Boolean(previous && changeAt && changeAt > previous.cutoff_at);
    const briefed = known.has(family);
    const isUnchanged = briefed && known.get(family) === revision && !changedSince;
    if (isUnchanged && !backgroundFamilies.has(family)) { unchanged += 1; continue; }
    if (isUnchanged) unchanged += 1;
    const deltaClass: BriefingDeltaClass = !previous ? "baseline"
      : isUnchanged ? "background"
        : changedSince ? "evidenced_change"
          : briefed ? "revised"
            : !lead.occurred_at ? "unknown_time"
              : lead.occurred_at > previous.cutoff_at ? "new_publication" : "newly_found";
    staged.push({
      ref_key: null,
      status: kept.some(isReady) ? "included" : "not_ready",
      delta_class: deltaClass,
      family_key: family,
      revision,
      lead,
      item_ids: itemIds,
      unverified: kept.every((row) => row.unverified),
      lenses: [...new Map(allSignals.map((signal) => [`${signal.lens.kind}:${signal.lens.label}`, signal.lens])).values()],
      signals: [...new Set(allSignals.map((signal) => signal.text).filter((text): text is string => Boolean(text)))],
      deps,
      activity_at: kept.map((row) => row.activity_at).sort().pop() ?? null,
      block: null,
    });
  }
  for (const id of offered.not_shared_ids) staged.push(pending("not_shared", null, [id], []));

  const contextEntries = await adapter.context(db);
  const context = contextEntries.map((entry, index) => ({ ...entry, key: `C${index + 1}` }));
  const contextHash = sha256(context.map((entry) => [entry.key, entry.kind, entry.source, entry.text]));
  const contextChanged = Boolean(previous && previous.context_hash !== contextHash);
  const comparison = previous ? "delta" : "baseline";

  const included = (row: ManifestInput) => row.status === "included";
  const news = staged.filter((row) => included(row) && row.delta_class !== "background")
    .sort((a, b) => DELTA_PRIORITY[a.delta_class!] - DELTA_PRIORITY[b.delta_class!]
      || (b.activity_at ?? "").localeCompare(a.activity_at ?? "") || a.family_key!.localeCompare(b.family_key!));
  // Background is sent only when a Run has a reason: news to compare, or a changed context to reassess.
  const wantBackground = news.length > 0 || contextChanged;
  const background = wantBackground ? staged.filter((row) => included(row) && row.delta_class === "background")
    .sort((a, b) => a.family_key!.localeCompare(b.family_key!)) : [];
  news.slice(BRIEFING_LIMITS.maxInputs).forEach((row) => { row.status = "truncated"; });

  // Fit the whole request: richest block level that fits, then drop lowest-priority inputs (carried).
  const instruction = renderInstruction(comparison, contextChanged);
  const contextText = renderContext(context);
  let sent = [...news.slice(0, BRIEFING_LIMITS.maxInputs), ...background];
  let level = 0;
  const assign = () => sent.forEach((row, index) => {
    row.ref_key = `S${index + 1}`;
    row.block = renderBlock({ ...row, ref_key: row.ref_key, delta_class: row.delta_class!, lead: row.lead! }, level);
  });
  const comparisonEntries = (): ComparisonEntry[] => {
    if (!wantBackground || !previous) return [];
    const keyOf = new Map(sent.map((row) => [row.family_key!, row.ref_key!]));
    return comparisonHighlights
      .filter((highlight) => highlight.families.length > 0 && highlight.families.every((family) => keyOf.has(family)))
      .map((highlight) => ({
        title: highlight.title, what_changed: highlight.what_changed, refs: highlight.families.map((family) => keyOf.get(family)!),
        previous_briefing_id: previous.id, deps: highlight.deps, context: highlight.context,
      }));
  };
  const comparisonText = () => renderComparison(comparisonEntries());
  const size = () => renderFrame({
    label: input.label, comparison, cutoff, coverage: null, context: contextText,
    previous: wantBackground ? comparisonText() : null, material: sent.map((row) => row.block).join("\n\n"),
  }).length + instruction.length;
  assign();
  while (size() > BRIEFING_LIMITS.promptChars && level < BLOCK_LEVELS.length - 1) { level += 1; assign(); }
  while (size() > BRIEFING_LIMITS.promptChars && sent.length > 0) {
    const dropped = sent.pop()!;
    dropped.ref_key = null;
    dropped.block = null;
    // Truncated news is carried to the next version; background that does not fit is simply not sent.
    if (dropped.delta_class !== "background") dropped.status = "truncated";
    assign();
  }
  const sentSet = new Set(sent);
  const inputs = [
    ...sent,
    ...staged.filter((row) => !sentSet.has(row) && row.delta_class !== "background")
      .sort((a, b) => (a.family_key ?? a.item_ids[0]!).localeCompare(b.family_key ?? b.item_ids[0]!)),
  ];
  const count = (status: ManifestInputStatus) => inputs.filter((row) => row.status === status).length;
  const coverage: BriefingCoverage = {
    since: previous ? since : null,
    cutoff,
    candidates: families.size,
    included: sent.length,
    merged_duplicates: mergedDuplicates,
    not_ready: count("not_ready"),
    truncated: count("truncated"),
    egress_refused: count("egress_refused"),
    not_shared_with_audience: count("not_shared"),
    carried_from_previous: carriedCount,
    unchanged_since_previous: unchanged,
    background: sent.filter((row) => row.delta_class === "background").length,
    context_changed: contextChanged,
    complete: count("not_ready") + count("truncated") + count("egress_refused") + count("not_shared") === 0,
  };
  const previousText = wantBackground ? comparisonText() : null;
  const prompt = renderFrame({
    label: input.label, comparison, cutoff, coverage, context: contextText, previous: previousText,
    material: sent.map((row) => row.block).join("\n\n"),
  });
  const needsRun = sent.some((row) => row.delta_class !== "background") || (contextChanged && sent.length > 0);
  if (needsRun) assertWithinBudget(prompt, instruction);
  const entries = comparisonEntries();
  return {
    since,
    cutoff,
    comparison,
    comparison_entries: entries,
    context_changed: contextChanged,
    inputs,
    context,
    coverage,
    needs_run: needsRun,
    prompt,
    instruction,
    input_hash: sha256([
      inputs.map((row) => [row.ref_key, row.status, row.delta_class, row.family_key, row.revision, row.item_ids, row.deps, row.block]),
      previousText,
      entries.map((entry) => [entry.previous_briefing_id, entry.deps, entry.context]),
      contextChanged,
    ]),
    context_hash: contextHash,
  };
}

function isReady(row: BriefingCandidate): boolean {
  return Boolean(row.summary) || row.signals.some((signal) => Boolean(signal.text));
}

function pending(status: ManifestInputStatus, family: string | null, itemIds: string[], group: BriefingCandidate[]): ManifestInput {
  return {
    ref_key: null, status, delta_class: null, family_key: family, revision: null, lead: group[0] ?? null,
    item_ids: itemIds, unverified: false, lenses: [], signals: [], deps: EMPTY_DEPS,
    activity_at: group.map((row) => row.activity_at).sort().pop() ?? null, block: null,
  };
}
