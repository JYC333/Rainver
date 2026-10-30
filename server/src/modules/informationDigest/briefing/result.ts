import { BriefingModelOutputSchema, type BriefingDeltaClass, type BriefingHighlight, type BriefingModelOutput } from "@rainver/protocol";

/** What the validator needs to know about one frozen reference. */
export interface ManifestRef {
  key: string;
  kind: "source_item" | "context";
  delta_class: BriefingDeltaClass | null;
  unverified: boolean;
  source_domain: string | null;
}

export interface ValidatedBriefing {
  overview: BriefingModelOutput["overview"];
  highlights: BriefingHighlight[];
  open_questions: BriefingModelOutput["open_questions"];
}

export class BriefingOutputError extends Error {
  readonly code = "briefing_output_invalid";
  constructor(readonly issues: string[]) {
    super(`The briefing did not meet its contract: ${issues.slice(0, 5).join("; ")}`);
    this.name = "BriefingOutputError";
  }
}

/** The Run's final text: one JSON object, or one ```json block in it. */
export function parseBriefingOutput(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, ...[...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((match) => match[1]!.trim()).reverse()];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* next */ }
  }
  throw new BriefingOutputError(["the final reply is not one JSON object"]);
}

const NEW_INPUTS: ReadonlySet<BriefingDeltaClass> = new Set(["new_publication", "newly_found", "unknown_time"]);
const UPDATED_INPUTS: ReadonlySet<BriefingDeltaClass> = new Set(["revised", "evidenced_change"]);

/**
 * Checks a model output against its frozen manifest. It proves only what can
 * be proved mechanically — every cited ref exists and is of the right kind,
 * facts cite material, an impact names context, novelty matches the server's
 * own classification — not that the text is supported by its sources.
 */
export function validateBriefing(
  raw: unknown,
  refs: ManifestRef[],
  comparison: "baseline" | "delta",
): ValidatedBriefing {
  const parsed = BriefingModelOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BriefingOutputError(parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`));
  }
  const output = parsed.data;
  const byKey = new Map(refs.map((ref) => [ref.key, ref]));
  const hasContext = refs.some((ref) => ref.kind === "context");
  const issues: string[] = [];
  const known = (where: string, keys: string[]) => {
    for (const key of keys) if (!byKey.has(key)) issues.push(`${where} cites ${key}, which is not in this briefing's inputs`);
  };
  const material = (keys: string[]) => keys.filter((key) => byKey.get(key)?.kind === "source_item");
  known("overview", output.overview.refs);
  output.highlights.forEach((highlight, index) => {
    const where = `highlights.${index}`;
    known(where, highlight.refs);
    known(`${where}.impact`, highlight.impact.context_refs);
    if (material(highlight.refs).length === 0) issues.push(`${where} must cite at least one material ref`);
    if (highlight.impact.context_refs.some((key) => byKey.get(key)?.kind !== "context")) issues.push(`${where}.impact may cite only context refs`);
    if (highlight.impact.assessment === "affects" && (!hasContext || highlight.impact.context_refs.length === 0)) {
      issues.push(`${where}.impact says "affects" without citing the goal, constraint or task it affects`);
    }
    highlight.statements.forEach((statement, statementIndex) => {
      known(`${where}.statements.${statementIndex}`, statement.refs);
      if (statement.kind === "fact" && material(statement.refs).length === 0) issues.push(`${where}.statements.${statementIndex} is a fact without a material ref`);
    });
    const cited = material([...highlight.refs, ...highlight.statements.flatMap((statement) => statement.refs)]).map((key) => byKey.get(key)!);
    if (comparison === "baseline" && highlight.novelty !== "baseline") issues.push(`${where}.novelty must be "baseline" in a first briefing`);
    if (comparison === "delta" && highlight.novelty === "baseline") issues.push(`${where}.novelty cannot be "baseline" after the first briefing`);
    if (highlight.novelty === "new" && !cited.some((ref) => ref.delta_class && NEW_INPUTS.has(ref.delta_class))) {
      issues.push(`${where} is marked new but cites no new or newly found input`);
    }
    if (highlight.novelty === "update" && !cited.some((ref) => ref.delta_class && UPDATED_INPUTS.has(ref.delta_class))) {
      issues.push(`${where} is marked update but cites no revised or evidenced-change input`);
    }
  });
  output.open_questions.forEach((question, index) => known(`open_questions.${index}`, question.refs));
  if (issues.length) throw new BriefingOutputError(issues);
  return {
    overview: output.overview,
    open_questions: output.open_questions,
    highlights: output.highlights.map((highlight) => {
      const cited = material([...highlight.refs, ...highlight.statements.flatMap((statement) => statement.refs)]).map((key) => byKey.get(key)!);
      const facts = highlight.statements.filter((statement) => statement.kind === "fact");
      return {
        ...highlight,
        source_domains: new Set(cited.map((ref) => ref.source_domain ?? ref.key)).size,
        rests_on_unverified: facts.some((statement) => material(statement.refs).every((key) => byKey.get(key)!.unverified)),
      };
    }),
  };
}

/** Every ref a unit depends on, for read-time visibility. */
export function highlightDependencies(highlight: BriefingHighlight): string[] {
  return [...new Set([...highlight.refs, ...highlight.impact.context_refs, ...highlight.statements.flatMap((statement) => statement.refs)])];
}
