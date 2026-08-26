import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SpaceObjectWriteError, buildSpaceObjectInsert } from "../src/db/spaceObjectWriter.js";
import { entityDefinition } from "../src/modules/ontology/entities.js";

const VALID = {
  id: "obj-1",
  spaceId: "space-1",
  objectType: "note",
  title: "A note",
  createdByUserId: "user-1",
  createdAt: "2026-08-04T00:00:00.000Z",
} as const;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("space object writer", () => {
  // Hardening the writer is worthless if a domain can hand-roll the insert next
  // to it, so the choke point is asserted before any of the rules are.
  it("is the only place that writes a space_objects row", () => {
    const offenders = sourceFiles(join(import.meta.dirname, "..", "src"))
      .filter((file) => !file.endsWith(join("db", "spaceObjectWriter.ts")))
      .filter((file) => /INSERT\s+INTO\s+space_objects/i.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("defaults visibility and access level rather than leaving them to callers", () => {
    const { sql, params } = buildSpaceObjectInsert({ ...VALID });
    expect(sql).toContain("INSERT INTO space_objects");
    expect(params).toContain("space_shared");
    expect(params).toContain("full");
  });

  it("offsets its placeholders so it can be embedded in a caller's statement", () => {
    const { sql, params } = buildSpaceObjectInsert({ ...VALID }, 4);
    expect(sql).toContain("$5");
    expect(sql).not.toMatch(/\$[1-4]\b/);
    expect(params[0]).toBe("obj-1");
  });
});

// B12H, enforced in one place so it cannot be forgotten at one of the eleven
// call sites. Each of these was a silent defect before: an unattributable
// object, or one whose Project gate was simply absent.
describe("space object writer B12H rules", () => {
  it("rejects an object with no created-by provenance", () => {
    const { createdByUserId: _omitted, ...withoutProvenance } = VALID;
    expect(() => buildSpaceObjectInsert(withoutProvenance)).toThrow(SpaceObjectWriteError);
  });

  it("accepts run or agent provenance in place of a user", () => {
    const { createdByUserId: _omitted, ...rest } = VALID;
    expect(() => buildSpaceObjectInsert({ ...rest, createdByRunId: "run-1" })).not.toThrow();
    expect(() => buildSpaceObjectInsert({ ...rest, createdByAgentId: "agent-1" })).not.toThrow();
  });

  it("requires a Project on a Project-owned object type", () => {
    // A null Project does not narrow access — the scope predicate treats it as
    // "no Project restriction", leaving only visibility. P3 attached Inquiry
    // Thread to the root, so the rule declared ahead of time now fires.
    expect(entityDefinition("inquiry_thread")?.requiresProjectScope).toBe(true);
    expect(entityDefinition("research_workflow")?.requiresProjectScope).toBe(true);
    expect(() => buildSpaceObjectInsert({ ...VALID, objectType: "inquiry_thread" }))
      .toThrow(/requires primary_project_id/);
    expect(() => buildSpaceObjectInsert({ ...VALID, objectType: "research_workflow" }))
      .toThrow(/requires primary_project_id/);
    expect(() => buildSpaceObjectInsert({
      ...VALID, objectType: "inquiry_thread", primaryProjectId: "project-1",
    })).not.toThrow();
  });

  it("rejects an object type that is not a registered ontology object", () => {
    expect(() => buildSpaceObjectInsert({ ...VALID, objectType: "run" }))
      .toThrow(/not a registered ontology object type/);
    expect(() => buildSpaceObjectInsert({ ...VALID, objectType: "nonsense" }))
      .toThrow(SpaceObjectWriteError);
  });

  it("rejects an invalid visibility or access level rather than storing it", () => {
    expect(() => buildSpaceObjectInsert({ ...VALID, visibility: "public" })).toThrow(/Invalid visibility/);
    expect(() => buildSpaceObjectInsert({ ...VALID, accessLevel: "none" })).toThrow(/Invalid access level/);
  });

  it("projects an over-long title to the column width instead of failing the write", () => {
    const { params } = buildSpaceObjectInsert({ ...VALID, title: "x".repeat(900) });
    expect(params).toContain("x".repeat(512));
  });

  it("rejects a blank title", () => {
    expect(() => buildSpaceObjectInsert({ ...VALID, title: "   " })).toThrow(/non-empty title/);
  });
});
