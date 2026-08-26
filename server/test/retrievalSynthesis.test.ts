import { describe, expect, it } from "vitest";
import {
  assembleBrief,
  buildBriefCandidates,
  DEFAULT_SYNTHESIS_CONFIG,
  type BriefCandidate,
  type SynthesisResult,
} from "../src/modules/retrieval/synthesis.js";
import type { ProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { RETRIEVAL_SYNTHESIS_TASK, SYNTHESIS_TOTAL_TEXT_MAX_CHARS } from "../src/modules/retrieval/synthesisProvider/config.js";
import { buildSynthesisPrompt, parseSynthesis } from "../src/modules/retrieval/synthesisProvider/prompt.js";
import { ProviderSynthesizer } from "../src/modules/retrieval/synthesisProvider/providerSynthesizer.js";
import type { RevalidatedObject, ScoredCandidate } from "../src/modules/retrieval/types.js";
import { resolveTestUsageAttribution } from "./support/usageAttribution.js";

const NOW = Date.parse("2026-06-23T00:00:00.000Z");

function candidate(over: Partial<BriefCandidate> & { objectId: string }): BriefCandidate {
  return {
    objectType: over.objectType ?? "knowledge_item",
    objectId: over.objectId,
    title: over.title ?? over.objectId,
    text: "text" in over ? over.text ?? null : "a".repeat(500),
    updatedAt: over.updatedAt ?? "2026-06-22T00:00:00.000Z",
  };
}

function synth(over: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    answer: over.answer ?? "An answer citing [0].",
    citations: over.citations ?? [0],
    uncitedClaims: over.uncitedClaims ?? [],
    contradictions: over.contradictions ?? [],
    missingTopics: over.missingTopics ?? [],
  };
}

describe("retrieval synthesis: prompt token budget (§2.6)", () => {
  it("caps total document text while keeping every source's title and citation index", () => {
    // 40 sources × 1000 chars each would be 40000 chars of body without a budget.
    const docs = Array.from({ length: 40 }, (_, index) => ({
      index,
      title: `Doc ${index}`,
      text: "z".repeat(1000),
    }));
    const prompt = buildSynthesisPrompt("query", docs, "registry synthesis system");
    const bodyChars = (prompt.user.match(/z/g) ?? []).length;
    expect(bodyChars).toBeLessThanOrEqual(SYNTHESIS_TOTAL_TEXT_MAX_CHARS);
    // Every source still appears (title + citation marker preserved).
    expect(prompt.user).toContain("[0]");
    expect(prompt.user).toContain("[39]");
    expect(prompt.user).toContain("Doc 39");
  });
});

describe("retrieval synthesis: assembleBrief", () => {
  it("maps in-range citation indices to source refs and drops invalid/duplicate ones", () => {
    const candidates = [candidate({ objectId: "a" }), candidate({ objectId: "b" })];
    const brief = assembleBrief(candidates, synth({ citations: [1, 1, 5, -1, 0] }), NOW, DEFAULT_SYNTHESIS_CONFIG);
    expect(brief.citations.map((c) => c.object_id)).toEqual(["b", "a"]); // 5 and -1 dropped, dup 1 once
    expect(brief.synthesized).toBe(true);
    expect(brief.answer).toBe("An answer citing [0].");
  });

  it("produces a deterministic-only brief when there is no synthesis result", () => {
    const candidates = [candidate({ objectId: "a" }), candidate({ objectId: "b" })];
    const brief = assembleBrief(candidates, null, NOW, DEFAULT_SYNTHESIS_CONFIG);
    expect(brief.answer).toBeNull();
    expect(brief.synthesized).toBe(false);
    expect(brief.citations).toEqual([]);
    expect(brief.gap_analysis.uncited_claims).toEqual([]);
    // Deterministic gaps still computed.
    expect(brief.gap_analysis.low_coverage).toBe(false);
  });

  it("flags stale and thin sources from each source's own metadata (access-neutral)", () => {
    const candidates = [
      candidate({ objectId: "fresh", updatedAt: "2026-06-20T00:00:00.000Z", text: "x".repeat(500) }),
      candidate({ objectId: "old", updatedAt: "2024-01-01T00:00:00.000Z", text: "x".repeat(500) }),
      candidate({ objectId: "thin", updatedAt: "2026-06-20T00:00:00.000Z", text: "short" }),
      candidate({ objectId: "redacted", updatedAt: "2026-06-20T00:00:00.000Z", text: null }),
    ];
    const brief = assembleBrief(candidates, null, NOW, DEFAULT_SYNTHESIS_CONFIG);
    expect(brief.gap_analysis.stale.map((g) => g.object_id)).toEqual(["old"]);
    expect(brief.gap_analysis.thin.map((g) => g.object_id).sort()).toEqual(["redacted", "thin"]);
  });

  it("sets low_coverage when fewer sources than the minimum are surfaced", () => {
    const brief = assembleBrief([candidate({ objectId: "only" })], null, NOW, DEFAULT_SYNTHESIS_CONFIG);
    expect(brief.gap_analysis.low_coverage).toBe(true); // 1 < lowCoverageMin (2)
  });

  it("carries LLM gap signals (deduped) when synthesis ran", () => {
    const candidates = [candidate({ objectId: "a" }), candidate({ objectId: "b" })];
    const brief = assembleBrief(
      candidates,
      synth({ uncitedClaims: ["c1", "c1"], contradictions: ["x"], missingTopics: ["m", "m2"] }),
      NOW,
      DEFAULT_SYNTHESIS_CONFIG,
    );
    expect(brief.gap_analysis.uncited_claims).toEqual(["c1"]);
    expect(brief.gap_analysis.contradictions).toEqual(["x"]);
    expect(brief.gap_analysis.missing_topics).toEqual(["m", "m2"]);
  });
});

describe("retrieval synthesis: buildBriefCandidates", () => {
  function scored(objectId: string): ScoredCandidate {
    return {
      objectType: "knowledge_item",
      objectId,
      title: objectId,
      snippet: "indexed snippet (must NOT be used)",
      matchedFields: ["plain_text"],
      evidence: { kind: "lexical_match" },
      rank: 1,
      arm: "lexical",
      updatedAt: "2026-06-22T00:00:00.000Z",
      score: 0.5,
    };
  }

  it("takes title/text only from the revalidation cache and bounds to the limit", () => {
    const visible = [scored("a"), scored("b"), scored("c")];
    const cache = new Map<string, RevalidatedObject | null>([
      ["knowledge_item:a", { title: "A", text: "full revalidated A" }],
      ["knowledge_item:b", { title: "B", text: null }], // redacted: visible title, null text
      ["knowledge_item:c", { title: "C", text: "full C" }],
    ]);
    const out = buildBriefCandidates(visible, cache, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ objectId: "a", title: "A", text: "full revalidated A" });
    expect(out[1]).toMatchObject({ objectId: "b", title: "B", text: null }); // never the indexed snippet
  });

  it("skips a visible candidate missing from the cache (defensive)", () => {
    const out = buildBriefCandidates([scored("a")], new Map(), 5);
    expect(out).toEqual([]);
  });
});

describe("retrieval synthesis: parseSynthesis", () => {
  it("parses a well-formed JSON object", () => {
    const r = parseSynthesis('{"answer":"Hi [0]","citations":[0],"uncited_claims":[],"contradictions":[],"missing_topics":["m"]}');
    expect(r).toMatchObject({ answer: "Hi [0]", citations: [0], missingTopics: ["m"] });
  });

  it("extracts the object from surrounding prose / code fences", () => {
    const r = parseSynthesis('```json\n{"answer":"x","citations":[1,2]}\n```');
    expect(r?.answer).toBe("x");
    expect(r?.citations).toEqual([1, 2]);
  });

  it("returns null when the answer is missing or empty", () => {
    expect(parseSynthesis('{"citations":[0]}')).toBeNull();
    expect(parseSynthesis('{"answer":"  "}')).toBeNull();
  });

  it("returns null on non-JSON and filters non-integer citations", () => {
    expect(parseSynthesis("not json")).toBeNull();
    expect(parseSynthesis('{"answer":"a","citations":[0,"x",1.5,2]}')?.citations).toEqual([0, 2]);
  });
});

describe("retrieval synthesis: ProviderSynthesizer", () => {
  it("requires the retrieval_synthesis task policy instead of falling back to the default provider", async () => {
    let requestedProviderId: string | null | undefined;
    const store = {
      resolveUsageAttribution: resolveTestUsageAttribution,
      async getTaskChain(_spaceId: string, task: string) {
        expect(task).toBe(RETRIEVAL_SYNTHESIS_TASK);
        return null;
      },
      async getInvocationTarget(_spaceId: string, providerId?: string | null) {
        requestedProviderId = providerId;
        throw new Error("no provider should be invoked without the task policy");
      },
    } as unknown as ProviderCommandStore;

    const result = await new ProviderSynthesizer(store, {
      systemPromptResolver: async () => "registry synthesis system",
    }).synthesize(
      "space-1",
      "user-1",
      "alpha",
      [candidate({ objectId: "a" })],
    );

    expect(result).toBeNull();
    expect(requestedProviderId).toBeDefined();
    expect(requestedProviderId).not.toBe("");
  });

  it("returns null when the registry prompt cannot be resolved", async () => {
    const store = {
      async getTaskChain() {
        throw new Error("provider should not be called without a prompt");
      },
      async getInvocationTarget() {
        throw new Error("provider should not be called without a prompt");
      },
    } as unknown as ProviderCommandStore;

    const result = await new ProviderSynthesizer(store, {
      systemPromptResolver: async () => null,
    }).synthesize("space-1", "user-1", "alpha", [candidate({ objectId: "a" })]);

    expect(result).toBeNull();
  });
});
