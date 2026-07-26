import { describe, expect, it } from "vitest";
import { hardFilterRows } from "../src/modules/context/contextRepositoryHelpers";
import type { ContextMemoryRow } from "../src/modules/context/repository";

// Unit coverage for the per-run project cut enforced in hardFilterRows. Rows are
// owned by the viewer so canReadMemory always passes — the assertions isolate the
// project-filter behavior.

const SPACE = "space-1";
const USER = "user-1";

function row(id: string, projectId: string | null): ContextMemoryRow {
  return {
    id,
    space_id: SPACE,
    owner_user_id: USER,
    scope_type: "user",
    visibility: "space_shared",
    sensitivity_level: "normal",
    deleted_at: null,
    project_folder_id: null,
    access_level: "full",
    project_id: projectId,
  } as unknown as ContextMemoryRow;
}

const base = { spaceId: SPACE, userId: USER, projectFolderId: null, includeSystemScope: false };
const rows = [row("m-free", null), row("m-P", "P"), row("m-Q", "Q")];

describe("per-run project cut (hardFilterRows)", () => {
  it("no projectFilter keeps everything (legacy behavior)", () => {
    expect(hardFilterRows(rows, base).map((r) => r.id)).toEqual(["m-free", "m-P", "m-Q"]);
  });

  it("allowed project P keeps project-free and P, drops other projects", () => {
    const out = hardFilterRows(rows, { ...base, projectFilter: { allowedProjectId: "P" } });
    expect(out.map((r) => r.id)).toEqual(["m-free", "m-P"]);
  });

  it("allowedProjectId null keeps only project-free memory", () => {
    const out = hardFilterRows(rows, { ...base, projectFilter: { allowedProjectId: null } });
    expect(out.map((r) => r.id)).toEqual(["m-free"]);
  });
});
