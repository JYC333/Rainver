import { describe, expect, it } from "vitest";
import {
  assertPlaceholderEntitiesProvided,
  projectEntitySummaryRegistry,
} from "../src/modules/projects/overviewRegistry.js";
import { PROJECT_OWNED_ENTITY_TYPES } from "../src/modules/projects/overviewService.js";
import { registerInquiryProjectIntegration } from "../src/modules/inquiry/projectIntegration.js";
import { registerDecisionsProjectIntegration } from "../src/modules/decisions/projectIntegration.js";
import { registerTasksProjectIntegration } from "../src/modules/tasks/projectIntegration.js";
import { registerAutomationsProjectIntegration } from "../src/modules/automations/projectIntegration.js";
import { registerLearningProjectIntegration } from "../src/modules/learning/projectIntegration.js";
import { registerProjectResearchProjectIntegration } from "../src/modules/projectResearch/projectIntegration.js";

function registerAll(): void {
  registerInquiryProjectIntegration();
  registerDecisionsProjectIntegration();
  registerTasksProjectIntegration();
  registerAutomationsProjectIntegration();
  registerLearningProjectIntegration();
  registerProjectResearchProjectIntegration();
}

/**
 * A Mode placeholder that nothing provides is a row the Overview silently
 * never renders — the class of omission the entity registry exists to stop,
 * so it is asserted rather than remembered.
 */
describe("Primary Mode placeholder entities", () => {
  it("every declared placeholder has a provider", () => {
    projectEntitySummaryRegistry.__resetForTests();
    registerAll();
    expect(() => assertPlaceholderEntitiesProvided(PROJECT_OWNED_ENTITY_TYPES)).not.toThrow();
  });

  it("rejects a placeholder naming an entity nothing provides", () => {
    projectEntitySummaryRegistry.__resetForTests();
    registerAll();
    expect(() => assertPlaceholderEntitiesProvided(
      PROJECT_OWNED_ENTITY_TYPES.filter((entityType) => entityType !== "artifact"),
    )).toThrow(/delivery declares a placeholder for artifact/);
  });

});
