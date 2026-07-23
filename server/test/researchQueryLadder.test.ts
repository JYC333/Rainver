import { describe, expect, it } from "vitest";
import type { ResearchSemanticQuery } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { ResearchQueryLadderBuilder, type ResearchQueryLadderStep } from "../src/modules/research/queryPlanning/queryLadderBuilder";
import { MAX_RESEARCH_QUERY_ATTEMPTS } from "../src/modules/research/queryPlanning/queryPolicy";

describe("ResearchQueryLadderBuilder", () => {
  it("broadens one lever at a time: expansion vocabulary first, then the qualifier (arxiv genuinely ORs expansions in)", () => {
    const builder = new ResearchQueryLadderBuilder();
    const intent = semanticIntent();
    const initial = builder.initial(intent);
    const afterFirstBroaden = builder.next(initial, intent, "broaden", "arxiv");
    const afterSecondBroaden = builder.next(afterFirstBroaden, intent, "broaden", "arxiv");

    expect(initial).toMatchObject({ sequence: 1, direction: "initial" });
    expect(initial.semanticQuery.qualifiers).toHaveLength(1);
    expect(afterFirstBroaden).toMatchObject({ sequence: 2, direction: "broaden" });
    // Dropping the one AND'd qualifier and adding an OR'd expansion in the
    // same step used to jump a query's hit count by two orders of magnitude
    // in production. The first broaden only adds expansion vocabulary.
    expect(afterFirstBroaden.semanticQuery.qualifiers).toHaveLength(1);
    expect(afterFirstBroaden.semanticQuery.expansions.length).toBeGreaterThan(initial.semanticQuery.expansions.length);
    // Only once there's no more expansion vocabulary left does broaden reach
    // for the qualifier.
    expect(afterSecondBroaden.semanticQuery.qualifiers).toHaveLength(0);
    expect(afterSecondBroaden.semanticQuery.core.length).toBeGreaterThan(0);
  });

  it("narrows by adding the next highest-ranked qualifier and stops at the attempt limit", () => {
    const builder = new ResearchQueryLadderBuilder();
    const intent = semanticIntent();
    const initial = builder.initial(intent);
    const narrower = builder.next(initial, intent, "narrow", "openalex");
    const narrowest = builder.next(narrower, intent, "narrow", "openalex");
    const final = builder.next(narrowest, intent, "narrow", "openalex");

    expect(narrower.semanticQuery.qualifiers.map((concept) => concept.value)).toEqual(["evaluation", "cross-session"]);
    expect(final.sequence).toBe(MAX_RESEARCH_QUERY_ATTEMPTS);
    expect(() => builder.next(final, intent, "narrow", "openalex")).toThrow(`limited to ${MAX_RESEARCH_QUERY_ATTEMPTS} attempts`);
  });

  // arxiv's compiler ORs core concepts into one topic clause instead of
  // requiring every one of them (see providers/arxiv.ts), so once qualifiers
  // and expansions are exhausted, adding/removing a core alternative must
  // move the query the opposite way from every other provider.
  it("arxiv broadens by adding a missing core alternative once qualifiers and expansions are exhausted", () => {
    const builder = new ResearchQueryLadderBuilder();
    const intent = coreLadderIntent();
    const previous: ResearchQueryLadderStep = {
      sequence: 2,
      direction: "broaden",
      semanticQuery: { ...intent, core: [intent.core[0]!], qualifiers: [], expansions: intent.expansions },
    };

    const next = builder.next(previous, intent, "broaden", "arxiv");

    expect(next.semanticQuery.core.map((concept) => concept.value)).toEqual(["agent memory", "retrieval augmentation"]);
  });

  it("arxiv narrows by dropping a core alternative once qualifiers are exhausted", () => {
    const builder = new ResearchQueryLadderBuilder();
    const intent = coreLadderIntent();
    const previous: ResearchQueryLadderStep = {
      sequence: 2,
      direction: "narrow",
      semanticQuery: { ...intent, core: intent.core, qualifiers: intent.qualifiers, expansions: [] },
    };

    const next = builder.next(previous, intent, "narrow", "arxiv");

    expect(next.semanticQuery.core).toHaveLength(1);
  });

  it("non-arxiv providers keep AND-core semantics: drop core to broaden, add core to narrow", () => {
    const builder = new ResearchQueryLadderBuilder();
    const intent = coreLadderIntent();
    const broadenPrevious: ResearchQueryLadderStep = {
      sequence: 2,
      direction: "broaden",
      semanticQuery: { ...intent, core: intent.core, qualifiers: [], expansions: intent.expansions },
    };
    const narrowPrevious: ResearchQueryLadderStep = {
      sequence: 2,
      direction: "narrow",
      // expansions already exhausted, so narrow reaches the core-touch
      // fallback this test is targeting instead of adding expansion
      // vocabulary (that's covered separately below).
      semanticQuery: { ...intent, core: [intent.core[0]!], qualifiers: intent.qualifiers, expansions: intent.expansions },
    };

    expect(builder.next(broadenPrevious, intent, "broaden", "openalex").semanticQuery.core).toHaveLength(1);
    expect(builder.next(narrowPrevious, intent, "narrow", "openalex").semanticQuery.core).toHaveLength(2);
  });

  // plainQuery (openalex, semantic_scholar) has no boolean operators at all —
  // every field gets flattened into one space-joined keyword string, so an
  // "expansion" is exactly as narrowing as a qualifier and never broadens.
  // Verified in production: three consecutive "broaden" steps for openalex
  // kept adding words and hits kept dropping (1094 -> 360 -> 24 -> 24).
  it("openalex/semantic_scholar broaden by dropping the qualifier instead of adding a useless expansion", () => {
    const builder = new ResearchQueryLadderBuilder();
    const intent = semanticIntent();
    const initial = builder.initial(intent);

    const broader = builder.next(initial, intent, "broaden", "openalex");

    expect(broader.semanticQuery.qualifiers).toHaveLength(0);
    expect(broader.semanticQuery.expansions.length).toBe(initial.semanticQuery.expansions.length);
  });

  it("openalex/semantic_scholar narrow by adding expansion vocabulary once qualifiers are exhausted", () => {
    const builder = new ResearchQueryLadderBuilder();
    const intent = coreLadderIntent();
    const previous: ResearchQueryLadderStep = {
      sequence: 2,
      direction: "narrow",
      semanticQuery: { ...intent, core: intent.core, qualifiers: intent.qualifiers, expansions: [] },
    };

    const next = builder.next(previous, intent, "narrow", "semantic_scholar");

    expect(next.semanticQuery.expansions).toHaveLength(1);
    expect(next.semanticQuery.core).toHaveLength(2);
  });
});

function coreLadderIntent(): ResearchSemanticQuery {
  return {
    schema_version: "research_semantic_query.v1",
    core: [
      { value: "agent memory", synonyms: [], weight: 1 },
      { value: "retrieval augmentation", synonyms: [], weight: 0.9 },
    ],
    expansions: [{ value: "long-term context", synonyms: [], weight: 0.8 }],
    qualifiers: [{ value: "evaluation", synonyms: [], weight: 0.9 }],
    exclusions: [],
    time_window: null,
  };
}

function semanticIntent(): ResearchSemanticQuery {
  return {
    schema_version: "research_semantic_query.v1",
    core: [
      { value: "agent memory", synonyms: ["memory-augmented agents"], weight: 1 },
      { value: "retrieval", synonyms: ["memory retrieval"], weight: 0.9 },
    ],
    expansions: [
      { value: "long-term context", synonyms: [], weight: 0.8 },
      { value: "persistent memory", synonyms: [], weight: 0.7 },
      { value: "episodic memory", synonyms: [], weight: 0.6 },
    ],
    qualifiers: [
      { value: "evaluation", synonyms: ["benchmark"], weight: 0.9 },
      { value: "cross-session", synonyms: [], weight: 0.8 },
      { value: "stale information", synonyms: [], weight: 0.6 },
    ],
    exclusions: [],
    time_window: null,
  };
}
