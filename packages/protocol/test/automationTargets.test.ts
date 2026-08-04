import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_TARGET_REGISTRY,
  AUTOMATION_TARGET_TYPES,
  AutomationTargetDefinitionSchema,
} from "../src/automationTargets.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/automation_target_registry.json", import.meta.url),
);
const registryFixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("Automation target registry", () => {
  it("validates every target and keeps target_type unique", () => {
    for (const definition of AUTOMATION_TARGET_REGISTRY) {
      expect(() => AutomationTargetDefinitionSchema.parse(definition)).not.toThrow();
    }
    expect(new Set(AUTOMATION_TARGET_TYPES).size).toBe(AUTOMATION_TARGET_TYPES.length);
  });

  it("matches the frozen registry fixture 1:1", () => {
    expect(AUTOMATION_TARGET_REGISTRY.length).toBe(registryFixture.length);
    expect(AUTOMATION_TARGET_REGISTRY.map((definition) => ({ ...definition }))).toEqual(
      registryFixture,
    );
  });
});
