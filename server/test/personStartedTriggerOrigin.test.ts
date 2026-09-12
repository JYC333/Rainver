import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("person-started trigger origin", () => {
  it("does not take trigger_origin from HTTP bodies on agent or task run create", () => {
    const agents = readFileSync(new URL("../src/modules/agents/routes.ts", import.meta.url), "utf8");
    const tasks = readFileSync(new URL("../src/modules/tasks/repository.ts", import.meta.url), "utf8");
    expect(agents).toContain("trigger_origin: PERSON_STARTED_TRIGGER_ORIGIN");
    expect(agents).not.toMatch(/body\.trigger_origin/);
    expect(tasks).toContain("trigger_origin: PERSON_STARTED_TRIGGER_ORIGIN");
    expect(tasks).not.toMatch(/body\.trigger_origin/);
  });
});
