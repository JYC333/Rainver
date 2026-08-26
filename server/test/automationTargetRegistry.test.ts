import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutomationTargetType } from "@rainver/protocol";
import {
  automationTargetHandlerRegistry,
  requireAutomationTargetHandler,
  type AutomationTargetHandler,
} from "../src/modules/automations/targetRegistry.js";
import { loadAutomationTargetDefinitions } from "../src/modules/automations/targetDefinitions.js";

const handler: AutomationTargetHandler = {
  preflight: async () => ({ executable: true }),
  execute: async () => ({ ok: true }),
};

// The registry is a process singleton, and the automations module registers
// its own handlers into it at load. Files in the shared project run in one
// worker, so whatever an earlier file loaded is still there when this one
// starts — reset before each test, not only after.
beforeEach(() => {
  automationTargetHandlerRegistry.__resetForTests();
});

afterEach(() => {
  automationTargetHandlerRegistry.__resetForTests();
});

describe("AutomationTargetHandlerRegistry", () => {
  it("upserts handlers by target type and validates exact protocol coverage", async () => {
    const targetTypes = [...(await loadAutomationTargetDefinitions()).keys()];
    for (const targetType of targetTypes) {
      automationTargetHandlerRegistry.register(targetType, handler, "test");
      automationTargetHandlerRegistry.register(targetType, handler, "test");
    }
    expect(() => automationTargetHandlerRegistry.assertComplete(targetTypes)).not.toThrow();
    expect(automationTargetHandlerRegistry.registeredTypes()).toEqual(
      new Set(targetTypes),
    );
  });

  it("fails startup completeness when a declared target has no handler", async () => {
    const targetTypes = [...(await loadAutomationTargetDefinitions()).keys()];
    for (const targetType of targetTypes.slice(1)) {
      automationTargetHandlerRegistry.register(targetType, handler, "test");
    }
    expect(() => automationTargetHandlerRegistry.assertComplete(targetTypes)).toThrow(
      /missing=\[agent_run\]/,
    );
  });

  it("fails closed at dispatch when the registered target handler is absent", () => {
    expect(() => requireAutomationTargetHandler("autonomous_tick")).toThrow(
      expect.objectContaining({
        statusCode: 503,
        message: expect.stringContaining("no active handler"),
      }),
    );
  });

  it("does not accept undeclared target keys through the protocol registry", async () => {
    const targetType = "not_registered" as AutomationTargetType;
    expect((await loadAutomationTargetDefinitions()).has(targetType)).toBe(false);
  });
});
