import { describe, expect, it } from "vitest";
import {
  MODE_PLACEHOLDER_ENTITIES,
  assertPlaceholderEntitiesProvided,
  projectEntitySummaryRegistry,
} from "../src/modules/projects/overviewRegistry";
import { PROJECT_OWNED_ENTITY_TYPES } from "../src/modules/projects/overviewService";
import { registerInquiryProjectIntegration } from "../src/modules/inquiry/projectIntegration";
import { registerDecisionsProjectIntegration } from "../src/modules/decisions/projectIntegration";
import { registerTasksProjectIntegration } from "../src/modules/tasks/projectIntegration";
import { registerAutomationsProjectIntegration } from "../src/modules/automations/projectIntegration";
import { registerLearningProjectIntegration } from "../src/modules/learning/projectIntegration";
import { registerProjectResearchProjectIntegration } from "../src/modules/projectResearch/projectIntegration";

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

  /** Order is part of the contract: a placeholder that reorders itself as
   *  data arrives moves the page under the reader. */
  it("declares research placeholders question-first, from asking to evidence", () => {
    expect(MODE_PLACEHOLDER_ENTITIES.research).toEqual([
      "inquiry_thread", "research_workflow", "source_item", "extracted_evidence",
    ]);
  });

  it("classifies by how work advances, not by subject matter", () => {
    expect(Object.keys(MODE_PLACEHOLDER_ENTITIES).sort())
      .toEqual(["delivery", "learning", "operations", "research"]);
  });
});
