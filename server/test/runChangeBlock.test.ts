import { describe, expect, it } from "vitest";
import {
  containsRunChangeLink,
  diffStat,
  renderRunChangeBlock,
  RUN_CHANGE_MAX_LISTED_FILES,
} from "../src/modules/agentGroups/runChangeBlock.js";

const MIXED_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@",
  " keep",
  "--- a removed line that looks like a header",
  "+++ an added line that looks like a header",
  " keep",
  "-last",
  "\\ No newline at end of file",
  "+last",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+body",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/img/logo.png b/img/logo.png",
  "new file mode 100644",
  "index 0000000..5555555",
  "Binary files /dev/null and b/img/logo.png differ",
  "diff --git a/lib/old name.ts b/lib/new name.ts",
  "similarity index 88%",
  "rename from lib/old name.ts",
  "rename to lib/new name.ts",
  "index 6666666..7777777 100644",
  "--- a/lib/old name.ts",
  "+++ b/lib/new name.ts",
  "@@ -2 +2 @@",
  "-a",
  "+b",
  "",
].join("\n");

describe("diffStat", () => {
  it("counts added and removed lines per file from a git diff", () => {
    expect(diffStat(MIXED_DIFF)).toEqual([
      { path: "src/app.ts", added: 2, removed: 2, binary: false },
      { path: "docs/new.md", added: 2, removed: 0, binary: false },
      { path: "gone.txt", added: 0, removed: 1, binary: false },
      { path: "img/logo.png", added: 0, removed: 0, binary: true },
      { path: "lib/old name.ts => lib/new name.ts", added: 1, removed: 1, binary: false },
    ]);
  });

  it("counts what is there when the diff was cut mid-hunk", () => {
    const cut = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,10 +1,10 @@",
      "-one",
      "+uno",
      "-tw",
    ].join("\n");
    expect(diffStat(cut)).toEqual([{ path: "a.ts", added: 1, removed: 2, binary: false }]);
  });

  it("decodes the paths git quotes, UTF-8 escapes included", () => {
    const quoted = [
      'diff --git "a/t\\303\\251st.txt" "b/t\\303\\251st.txt"',
      "--- \"a/t\\303\\251st.txt\"",
      "+++ \"b/t\\303\\251st.txt\"",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    expect(diffStat(quoted)).toEqual([{ path: "tést.txt", added: 1, removed: 1, binary: false }]);
  });

  it("returns nothing for an empty diff", () => {
    expect(diffStat("")).toEqual([]);
  });
});

describe("renderRunChangeBlock", () => {
  it("lists files with counts and the link, and summarizes past the listed limit", () => {
    const files = Array.from({ length: RUN_CHANGE_MAX_LISTED_FILES + 3 }, (_, index) => ({
      path: `f${index}.ts`,
      added: 1,
      removed: index < RUN_CHANGE_MAX_LISTED_FILES ? 0 : 2,
      binary: false,
    }));
    const block = renderRunChangeBlock({ run_id: "run-1", artifact_id: "art-1", files, truncated: false }).split("\n");
    expect(block[0]).toBe(`[Changes] ${files.length} files changed, +${files.length} -6`);
    expect(block[1]).toBe("  f0.ts | +1 -0");
    expect(block).toHaveLength(1 + RUN_CHANGE_MAX_LISTED_FILES + 2);
    expect(block[RUN_CHANGE_MAX_LISTED_FILES + 1]).toBe("  … and 3 more files (+3 -6)");
    expect(block.at(-1)).toContain("rainver://artifacts/art-1");
    expect(containsRunChangeLink(block.join("\n"))).toBe(true);
  });

  it("says so when the stored diff was truncated, and marks binary files", () => {
    const block = renderRunChangeBlock({
      run_id: "run-1",
      artifact_id: "art-2",
      files: [{ path: "logo.png", added: 0, removed: 0, binary: true }],
      truncated: true,
    }, "  ");
    expect(block.split("\n")[0]).toBe(
      "  [Changes] at least 1 file changed, +0 -0 (the stored diff was truncated: counts cover only the stored part, and files after the cut are not listed)",
    );
    expect(block).toContain("    logo.png | binary");
  });
});

describe("containsRunChangeLink", () => {
  it("recognizes only an Artifact link", () => {
    expect(containsRunChangeLink("see rainver://artifacts/0f1e2d3c-aaaa-bbbb-cccc-111122223333")).toBe(true);
    expect(containsRunChangeLink("rainver:conversation-input-resource:abc")).toBe(false);
    expect(containsRunChangeLink(null)).toBe(false);
  });
});
