import { describe, expect, it } from "vitest";
import { topicKeyFor, MAX_TOPIC_KEY_LENGTH } from "../src/modules/interestProfile/topicKey";
import {
  explorationShare,
  gapsAreMeaningful,
  profileMaturity,
  skeletonSize,
  MIN_EXPLORATION_SHARE,
  WARMING_MIN_READ_ITEMS,
  WARM_MIN_COVERED_DOMAINS,
  WARM_MIN_READ_ITEMS,
} from "../src/modules/interestProfile/maturity";

describe("topic key normalization", () => {
  it("collapses the spellings of one interest", () => {
    // Annotation returns whatever phrase the model chose. If these produced
    // different keys, one interest would become several topics and the coverage
    // distribution would read as breadth the reader does not have.
    const key = topicKeyFor("Large Language Models");
    expect(topicKeyFor("large language model")).toBe(key);
    expect(topicKeyFor("  LARGE   language  models  ")).toBe(key);
    expect(topicKeyFor("large-language-models")).toBe(key);
  });

  it("keeps genuinely different interests apart", () => {
    // Over-merging is the worse failure: the owner cannot undo it without
    // deleting a topic, and cannot see why two interests collapsed.
    expect(topicKeyFor("computing")).not.toBe(topicKeyFor("computer"));
    expect(topicKeyFor("progress")).not.toBe(topicKeyFor("progres"));
    expect(topicKeyFor("climate policy")).not.toBe(topicKeyFor("climate science"));
  });

  it("does not strip an s that is part of the word", () => {
    // Over-merging is invisible and unrecoverable, so a vowel before the s
    // blocks stripping even though that leaves some real plurals unmerged.
    expect(topicKeyFor("progress")).toBe("progress");
    expect(topicKeyFor("corpus")).toBe("corpus");
    expect(topicKeyFor("analysis")).toBe("analysis");
    expect(topicKeyFor("bias")).toBe("bias");
  });

  it("leaves discipline names intact", () => {
    // These are singular and are among the most common shapes a topic phrase
    // takes; stripping them would file "robotics" under "robotic".
    for (const word of ["robotics", "physics", "economics", "politics", "mathematics", "statistics"]) {
      expect(topicKeyFor(word)).toBe(word);
    }
  });

  it("handles the plural forms it can resolve safely", () => {
    expect(topicKeyFor("batteries")).toBe(topicKeyFor("battery"));
    expect(topicKeyFor("processes")).toBe(topicKeyFor("process"));
    expect(topicKeyFor("models")).toBe(topicKeyFor("model"));
    expect(topicKeyFor("neural networks")).toBe(topicKeyFor("neural network"));
  });

  it("returns empty for phrases with nothing to key on", () => {
    expect(topicKeyFor("   ")).toBe("");
    expect(topicKeyFor("!!!")).toBe("");
  });

  it("bounds the key length", () => {
    expect(topicKeyFor("word ".repeat(100)).length).toBeLessThanOrEqual(MAX_TOPIC_KEY_LENGTH);
  });
});

describe("profile maturity", () => {
  it("starts cold for a reader who has done nothing", () => {
    // Cold start is a normal product state, not an absent profile.
    expect(profileMaturity({ readItemCount: 0, coveredDomainCount: 0 })).toBe("cold");
  });

  it("warms only once there is enough signal to rank on", () => {
    expect(profileMaturity({ readItemCount: WARMING_MIN_READ_ITEMS - 1, coveredDomainCount: 3 })).toBe("cold");
    expect(profileMaturity({ readItemCount: WARMING_MIN_READ_ITEMS, coveredDomainCount: 3 })).toBe("warming");
  });

  it("requires breadth as well as volume to be warm", () => {
    // Volume alone in one domain does not make "you never read about X"
    // a statement about the reader.
    expect(profileMaturity({ readItemCount: WARM_MIN_READ_ITEMS, coveredDomainCount: WARM_MIN_COVERED_DOMAINS - 1 }))
      .toBe("warming");
    expect(profileMaturity({ readItemCount: WARM_MIN_READ_ITEMS, coveredDomainCount: WARM_MIN_COVERED_DOMAINS }))
      .toBe("warm");
  });

  it("ramps exploration down as the profile learns, and never to zero", () => {
    expect(explorationShare("cold")).toBe(1);
    expect(explorationShare("warming")).toBeLessThan(explorationShare("cold"));
    expect(explorationShare("warm")).toBeLessThan(explorationShare("warming"));
    // A profile that only fills computed gaps converges on the reader's own
    // history — precisely the failure serendipity exists to prevent.
    expect(explorationShare("warm")).toBeGreaterThanOrEqual(MIN_EXPLORATION_SHARE);
    expect(explorationShare("warm")).toBeGreaterThan(0);
  });

  it("only treats gaps as meaningful when warm", () => {
    expect(gapsAreMeaningful("cold")).toBe(false);
    expect(gapsAreMeaningful("warming")).toBe(false);
    expect(gapsAreMeaningful("warm")).toBe(true);
  });

  it("reports the skeleton as the coverage denominator", () => {
    expect(skeletonSize()).toBeGreaterThanOrEqual(30);
  });
});
