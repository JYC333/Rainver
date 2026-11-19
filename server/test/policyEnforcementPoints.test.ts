import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { POLICY_ACTION_REGISTRY } from "@rainver/protocol";

// The policy action registry names where each action is enforced. A path that does not exist sends a
// reviewer (or an inventory) to the wrong place, so every file path it names must be a real file.
it("names only existing files as current enforcement points", () => {
  const root = resolve(import.meta.dirname, "../..");
  const missing = POLICY_ACTION_REGISTRY
    .map((entry) => (entry as { action: string; current_enforcement_point?: string | null }))
    .filter((entry) => typeof entry.current_enforcement_point === "string" && /^[\w./-]+\.tsx?$/.test(entry.current_enforcement_point))
    .filter((entry) => !existsSync(resolve(root, entry.current_enforcement_point!)))
    .map((entry) => `${entry.action}: ${entry.current_enforcement_point}`);
  expect(missing).toEqual([]);
});
