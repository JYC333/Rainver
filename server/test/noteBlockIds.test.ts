import { describe, expect, it } from "vitest";
import { addedBlockIds, blockIds, withBlockIds, BLOCK_ID_ATTR } from "../src/modules/knowledge/noteBlockIds.js";
import { applyNoteOps } from "../src/modules/knowledge/noteDocument.js";

/**
 * Block identity, which relocation later anchors on. A block *index* cannot do
 * this job: inserting a line above shifts every index below it, so a capture
 * would come to point at someone else's paragraph.
 */

const paragraph = (text: string, id?: string) => ({
  type: "paragraph",
  ...(id ? { attrs: { [BLOCK_ID_ATTR]: id } } : {}),
  content: [{ type: "text", text }],
});

describe("withBlockIds", () => {
  it("stamps every block that has none", () => {
    const doc = withBlockIds({ type: "doc", content: [paragraph("a"), paragraph("b")] });
    const ids = blockIds(doc);
    expect(ids.filter(Boolean)).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("leaves an existing id alone, so identity survives every rewrite", () => {
    const doc = withBlockIds({ type: "doc", content: [paragraph("a", "keep-me"), paragraph("b")] });
    const ids = blockIds(doc);
    expect(ids[0]).toBe("keep-me");
    expect(ids[1]).toBeTruthy();
  });

  it("returns the same object when there is nothing to stamp", () => {
    const source = { type: "doc", content: [paragraph("a", "one")] };
    expect(withBlockIds(source)).toBe(source);
  });

  it("treats a document with no blocks as legal rather than throwing", () => {
    expect(blockIds(withBlockIds({ type: "doc" }))).toEqual([]);
    expect(blockIds(withBlockIds(null))).toEqual([]);
  });
});

describe("addedBlockIds", () => {
  it("names only the blocks a write introduced", () => {
    const before = withBlockIds({ type: "doc", content: [paragraph("kept", "kept-id")] });
    const after = withBlockIds({ type: "doc", content: [paragraph("kept", "kept-id"), paragraph("new")] });
    const added = addedBlockIds(before, after);
    expect(added).toHaveLength(1);
    expect(added[0]).not.toBe("kept-id");
  });

  it("is empty when a write only changed existing blocks", () => {
    const before = withBlockIds({ type: "doc", content: [paragraph("old", "same")] });
    const after = { type: "doc", content: [paragraph("edited", "same")] };
    expect(addedBlockIds(before, after)).toEqual([]);
  });
});

describe("applyNoteOps with block ids", () => {
  it("carries the ids of blocks it does not touch", () => {
    const doc = withBlockIds({
      type: "doc",
      content: [paragraph("first"), paragraph("second"), paragraph("third")],
    });
    const before = blockIds(doc);
    const next = withBlockIds(applyNoteOps(doc, [{ op: "replace", index: 1, count: 1, markdown: "rewritten" }]));
    const after = blockIds(next);

    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    // The replaced block is a different block and gets a different identity —
    // relocation must not follow an anchor onto text nobody captured.
    expect(after[1]).not.toBe(before[1]);
  });

  it("keeps ids stable when a block is inserted above them", () => {
    const doc = withBlockIds({ type: "doc", content: [paragraph("anchor")] });
    const anchor = blockIds(doc)[0];
    const next = withBlockIds(applyNoteOps(doc, [{ op: "insert", index: 0, markdown: "above" }]));

    expect(blockIds(next)[1]).toBe(anchor);
  });

  it("gives an appended capture its own id", () => {
    const doc = withBlockIds({ type: "doc", content: [paragraph("existing")] });
    const next = withBlockIds(applyNoteOps(doc, [{ op: "append", markdown: "the capture" }]));
    const added = addedBlockIds(doc, next);

    expect(added).toHaveLength(1);
    expect(blockIds(next)[1]).toBe(added[0]);
  });
});

describe("mixed block sizes", () => {
  it("keeps every id distinct across blocks of different sizes", () => {
    // Uniform single-line paragraphs hide position arithmetic mistakes. A list,
    // a code block and a multi-line paragraph do not.
    const doc = withBlockIds({
      type: "doc",
      content: [
        { type: "bulletList", content: [{ type: "listItem", content: [paragraph("a")] }, { type: "listItem", content: [paragraph("b")] }] },
        { type: "codeBlock", content: [{ type: "text", text: "line one\nline two" }] },
        paragraph("tail"),
      ],
    });
    const ids = blockIds(doc);
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  it("leaves the ids of nested nodes alone — identity is top-level only", () => {
    const doc = withBlockIds({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "listItem", content: [paragraph("nested")] }] }],
    });
    const list = (doc.content as Record<string, unknown>[])[0]!;
    const item = (list.content as Record<string, unknown>[])[0]!;
    const nested = (item.content as Record<string, unknown>[])[0]!;
    expect(nested.attrs).toBeUndefined();
  });
});
