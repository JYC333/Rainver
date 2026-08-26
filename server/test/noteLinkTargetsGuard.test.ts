import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { retrievableEntityTypes, spaceObjectSubtypes } from "../src/modules/ontology/entities.js";

/**
 * The guardrail the plan asks for: the editor's target-kind list must be
 * derived from the backend's accepted set, never hand-maintained.
 *
 * Gap 3 was exactly a hand-maintained list drifting from its backend —
 * `NoteEditor.tsx` offered `note` and `knowledge_item` while the storage and
 * the backlinks query handled far more, so notes and research material could
 * not be connected at all. Fixing the list once fixes nothing durably; what
 * stops the drift recurring is a check that fails when the two disagree.
 *
 * Two corrections to the plan's premise, found while implementing NB. The plan
 * says the backend "already accepts" all nine `retrieval_object_type` values.
 *
 * - The *storage column* is typed that wide, but `createNoteLink` resolves both
 *   endpoints through `requireVisibleSpaceObject`, so an entity with no
 *   `space_objects` row — `source_item`, `extracted_evidence`, `memory_entry` —
 *   is rejected at write time. Offering those three would 404 on every use.
 * - The picker sources candidates from `POST /knowledge/search`, so a target
 *   must also be `Retrievable`. `decision_case`, `experiment`, `person` and
 *   `organization` are linkable but unsearchable, so offering them would give
 *   an entry with a permanently empty candidate list.
 *
 * The offered set is the intersection, which this asserts against the registry
 * so it tracks the backend instead of being remembered.
 */

const webSrc = join(import.meta.dirname, "..", "..", "apps", "web", "src");

function tsxFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("note link target guardrail", () => {
  it("equals the linkable-and-searchable intersection the registry declares", async () => {
    const { NOTE_LINK_TARGET_TYPE_VALUES } = await import("@agent-space/protocol");
    const retrievable = new Set<string>(retrievableEntityTypes());
    const expected = spaceObjectSubtypes().filter((type) => retrievable.has(type));
    expect([...NOTE_LINK_TARGET_TYPE_VALUES].sort()).toEqual([...expected].sort());
  });

  it("offers every type that is both linkable and searchable", async () => {
    // The direction gap 3 actually failed in: the list was a strict subset of
    // what the backend supported, and the missing entries were the ones that
    // connected notes to research material. Registering a new searchable
    // `space_objects` subtype must fail here until the editor offers it.
    const { NOTE_LINK_TARGET_TYPE_VALUES } = await import("@agent-space/protocol");
    const offered = new Set<string>(NOTE_LINK_TARGET_TYPE_VALUES);
    const retrievable = new Set<string>(retrievableEntityTypes());
    const missing = spaceObjectSubtypes().filter((type) => retrievable.has(type) && !offered.has(type));
    expect(missing).toEqual([]);
  });

  it("keeps the unreachable types unreachable, rather than offering a link that 404s", async () => {
    // NC's stated acceptance names `source_item` and `extracted_evidence` as
    // link targets. Neither has a `space_objects` row, so `createNoteLink`
    // rejects both — reaching them would mean widening the endpoint contract,
    // the same reflex ND's open question warns against for
    // `knowledge_item_sources`. Evidence is reached through the Source object
    // its paper materializes into instead. This asserts the decision so a
    // later reader sees a choice rather than an oversight.
    const { NOTE_LINK_TARGET_TYPE_VALUES } = await import("@agent-space/protocol");
    const offered = new Set<string>(NOTE_LINK_TARGET_TYPE_VALUES);
    const subtypes = new Set<string>(spaceObjectSubtypes());
    for (const rootless of ["source_item", "extracted_evidence", "memory_entry"]) {
      expect(subtypes.has(rootless)).toBe(false);
      expect(offered.has(rootless)).toBe(false);
    }
  });

  it("builds the editor's dropdown from the shared list rather than its own literals", () => {
    const editor = tsxFiles(webSrc).find((file) => file.endsWith("NoteEditor.tsx"));
    expect(editor, "NoteEditor.tsx has moved; update this guard").toBeTruthy();
    const source = readFileSync(editor!, "utf8");
    expect(source).toContain("NOTE_LINK_TARGET_TYPE_VALUES");
    // The two literals the old hand-maintained array was built from. Their
    // presence as quoted option values would mean the array came back.
    expect(source).not.toMatch(/\{\s*value:\s*'note'\s*,\s*label:/);
    expect(source).not.toMatch(/\{\s*value:\s*'knowledge_item'\s*,\s*label:/);
  });
});
