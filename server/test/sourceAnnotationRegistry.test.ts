import { describe, expect, it } from "vitest";
import {
  adjacentDomainKeys,
  distantDomainKeys,
  domainDefinitions,
  getDomain,
  isKnownDomain,
  registerDomain,
} from "../src/modules/sourceAnnotation/domainSkeleton.js";
import {
  parseSourceAnnotationResult,
  sourceAnnotationOutputContract,
  normalizeTopicCandidates,
  SOURCE_ANNOTATION_SCHEMA_ID,
} from "../src/modules/sourceAnnotation/resultParser.js";
import { MAX_TOPIC_CANDIDATES } from "../src/modules/sourceAnnotation/vocabulary.js";

// The domain skeleton is the reference frame serendipity gaps are computed
// against, so what it guarantees is structural: it is coarse, it is stable, and
// every registered key is usable end to end.

describe("domain skeleton", () => {
  it("stays coarse enough that gaps are real", () => {
    // A fine-grained skeleton manufactures gaps: split a field the reader
    // follows daily into forty subfields and most of them read as uncovered.
    const count = domainDefinitions().length;
    expect(count).toBeGreaterThanOrEqual(30);
    expect(count).toBeLessThanOrEqual(60);
  });

  it("gives every domain a prompt hint", () => {
    // Domains at this granularity collide in ordinary language ("media" vs
    // "arts"); without a disambiguator the model distributes the same material
    // differently between runs and the coverage distribution drifts.
    for (const domain of domainDefinitions()) {
      expect(domain.hint.trim().length).toBeGreaterThan(0);
      expect(domain.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("rejects a malformed key", () => {
    expect(() => registerDomain({ key: "Not Valid", label: "x", group: "science", hint: "y", owner: "test" }))
      .toThrow(/invalid domain key/);
  });

  it("refuses to let another owner take a registered key", () => {
    expect(() => registerDomain({ key: "physics", label: "x", group: "science", hint: "y", owner: "someone-else" }))
      .toThrow(/already registered/);
  });

  it("splits adjacent from distant with no overlap", () => {
    const covered = ["artificial_intelligence"];
    const adjacent = adjacentDomainKeys(covered);
    const distant = distantDomainKeys(covered);

    // Adjacent means "same group, not yet covered".
    expect(adjacent).toContain("security_privacy");
    expect(adjacent).not.toContain("artificial_intelligence");
    // Distant shares no group with anything covered.
    expect(distant).toContain("cooking");
    expect(adjacent.some((key) => distant.includes(key))).toBe(false);
  });

  it("treats everything as distant when nothing is covered", () => {
    // Cold start: an empty distribution must not make the serendipity quota
    // undefined, it must make almost everything eligible.
    const distant = distantDomainKeys([]);
    expect(distant.length).toBe(domainDefinitions().length);
    expect(adjacentDomainKeys([])).toEqual([]);
  });

  it("exposes registered domains through the lookup guard", () => {
    expect(isKnownDomain("cooking")).toBe(true);
    expect(isKnownDomain("astrology_of_finance")).toBe(false);
    expect(getDomain("cooking")?.group).toBe("practice");
  });
});

describe("annotation output contract", () => {
  it("builds its domain enum from the registry", () => {
    // A domain the skeleton knows but the schema rejects would fail every
    // annotation naming it, and the failure would look like a model problem.
    const contract = sourceAnnotationOutputContract();
    const properties = (contract.schema.properties as Record<string, any>);
    const domainEnum: string[] = properties.annotations.items.properties.domain_key.enum;
    expect(domainEnum).toContain("cooking");
    expect(domainEnum.length).toBe(domainDefinitions().length);
    expect(contract.schema_id).toBe(SOURCE_ANNOTATION_SCHEMA_ID);
    expect(contract.stage).toBe("source_annotation");
  });
});

describe("annotation result parsing", () => {
  const output = (annotations: unknown[]) =>
    JSON.stringify({ schema: SOURCE_ANNOTATION_SCHEMA_ID, annotations });

  const valid = {
    source_item_id: "item-1",
    domain_key: "artificial_intelligence",
    depth: "analysis",
    genre: "explainer",
    summary: "Explains how retrieval augmentation works.",
    topic_candidates: ["retrieval-augmented generation"],
    stance_target: "retrieval augmentation improves factual accuracy",
    stance_polarity: "supports",
    stance_confidence: 82,
  };

  it("accepts a well-formed annotation", () => {
    const result = parseSourceAnnotationResult(output([valid]), ["item-1"]);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].domain_key).toBe("artificial_intelligence");
    expect(result.annotations[0]).toMatchObject({
      stance_target_key: "retrieval augmentation improves factual accuracy",
      stance_polarity: "supports",
    });
    expect(result.rejected).toEqual([]);
  });

  it("rejects directional stance without a target", () => {
    const result = parseSourceAnnotationResult(output([{ ...valid, stance_target: null }]), ["item-1"]);
    expect(result.annotations).toEqual([]);
    expect(result.rejected).toContainEqual({ source_item_id: "item-1", reason: "invalid_stance" });
  });

  it("drops an unknown domain instead of storing it", () => {
    // An unrecognized domain in the coverage distribution is uninterpretable by
    // gap computation. A missing annotation is recoverable; a wrong one is not.
    const result = parseSourceAnnotationResult(
      output([{ ...valid, domain_key: "vibes" }]),
      ["item-1"],
    );
    expect(result.annotations).toEqual([]);
    expect(result.rejected).toEqual([{ source_item_id: "item-1", reason: "unknown_domain" }]);
  });

  it("drops unknown depth and genre", () => {
    expect(parseSourceAnnotationResult(output([{ ...valid, depth: "profound" }]), ["item-1"]).rejected[0].reason)
      .toBe("unknown_depth");
    expect(parseSourceAnnotationResult(output([{ ...valid, genre: "vibes" }]), ["item-1"]).rejected[0].reason)
      .toBe("unknown_genre");
  });

  it("keeps good annotations when a sibling is hallucinated", () => {
    // The pass is best-effort per item: one invented id must not cost the
    // others their annotation.
    const result = parseSourceAnnotationResult(
      output([valid, { ...valid, source_item_id: "never-requested" }]),
      ["item-1"],
    );
    expect(result.annotations.map((a) => a.source_item_id)).toEqual(["item-1"]);
    expect(result.rejected).toEqual([{ source_item_id: "never-requested", reason: "unrequested_item" }]);
  });

  it("keeps the first of a duplicated item", () => {
    const result = parseSourceAnnotationResult(
      output([valid, { ...valid, domain_key: "cooking" }]),
      ["item-1"],
    );
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].domain_key).toBe("artificial_intelligence");
    expect(result.rejected[0].reason).toBe("duplicate_item");
  });

  it("rejects output declaring another schema", () => {
    const wrong = JSON.stringify({ schema: "something.else.v1", annotations: [] });
    expect(() => parseSourceAnnotationResult(wrong, [])).toThrow(/unexpected_schema|declares schema/);
  });

  it("rejects unparseable output", () => {
    expect(() => parseSourceAnnotationResult("not json", [])).toThrow();
  });

  it("rejects output with no annotations array", () => {
    expect(() => parseSourceAnnotationResult(JSON.stringify({ schema: SOURCE_ANNOTATION_SCHEMA_ID }), []))
      .toThrow();
  });
});

describe("topic candidate normalization", () => {
  it("caps, trims, and dedupes case-insensitively", () => {
    const input = ["  Rust  ", "rust", "WebAssembly", "a".repeat(200), "x1", "x2", "x3", "x4"];
    const result = normalizeTopicCandidates(input);
    expect(result.length).toBeLessThanOrEqual(MAX_TOPIC_CANDIDATES);
    expect(result[0]).toBe("Rust");
    expect(result.filter((phrase) => phrase.toLowerCase() === "rust")).toHaveLength(1);
    expect(result.every((phrase) => phrase.length <= 64)).toBe(true);
  });

  it("returns an empty list for non-arrays", () => {
    expect(normalizeTopicCandidates(undefined)).toEqual([]);
    expect(normalizeTopicCandidates("rust")).toEqual([]);
  });
});
