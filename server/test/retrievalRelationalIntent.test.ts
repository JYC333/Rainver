import { describe, expect, it } from "vitest";
import { parseRelationalIntent } from "../src/modules/retrieval/relationalIntent.js";

describe("parseRelationalIntent", () => {
  it("recognizes a small deterministic relation vocabulary", () => {
    expect(parseRelationalIntent("Who works with Alpha?")).toMatchObject({
      kind: "related_to",
      seedPhrases: ["Alpha"],
    });
    expect(parseRelationalIntent("How is Alpha connected to Beta?")).toMatchObject({
      kind: "connection",
      seedPhrases: ["Alpha"],
      focusPhrases: ["Beta"],
    });
    expect(parseRelationalIntent("Sources for Alpha")).toMatchObject({
      kind: "sources_for",
      seedPhrases: ["Alpha"],
      targetObjectTypes: ["source"],
    });
    expect(parseRelationalIntent("Projects related to embeddings")).toMatchObject({
      kind: "projects_related",
      seedPhrases: ["embeddings"],
      targetObjectTypes: ["project_public_summary"],
    });
  });

  it("leaves ordinary free-text queries on the standard recall path", () => {
    expect(parseRelationalIntent("Alpha migration notes")).toBeNull();
    expect(parseRelationalIntent("latest deployment notes")).toBeNull();
  });
});
