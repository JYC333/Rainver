import { describe, expect, it } from "vitest";

import { entityDefinition } from "../src/modules/ontology/entities.js";

/**
 * NE: the first object-bound actions, and the mechanism `applies_to` exists
 * for (ADR 0012 decision 8).
 *
 * All three are user-invoked from a selection. None is `agent_tool` visible.
 * Do not make one agent-callable without failing here first. That would widen
 * the callable surface, which is a product decision about capability exposure.
 */

const NOTE_ACTION_IDS = [
  "note.promote_to_knowledge",
  "note.raise_as_question",
  "note.link_to_evidence",
] as const;

describe("note object actions", () => {
  it("declares all three against the note object type", async () => {
    const { systemActionsForObjectType } = await import("@rainver/protocol");
    const ids = systemActionsForObjectType("note").map((definition) => definition.id);
    expect(ids.sort()).toEqual([...NOTE_ACTION_IDS].sort());
  });

  it("does not widen the agent's callable surface", async () => {
    const { SYSTEM_ACTION_REGISTRY } = await import("@rainver/protocol");
    for (const id of NOTE_ACTION_IDS) {
      const definition = SYSTEM_ACTION_REGISTRY.find((entry) => entry.id === id);
      expect(definition, `${id} is not registered`).toBeTruthy();
      // The gateway admits a tool only when both hold, so either alone is
      // enough to keep it out — both are asserted because either changing is
      // the product decision the ADR reserved.
      expect(definition!.visibility.has("agent_tool")).toBe(false);
      expect(definition!.allowed_actor_types).not.toContain("agent");
    }
  });

  it("keeps promotion behind the proposal gate and the other two direct", async () => {
    const { SYSTEM_ACTION_REGISTRY } = await import("@rainver/protocol");
    const byId = new Map(SYSTEM_ACTION_REGISTRY.map((entry) => [entry.id, entry]));
    // Promotion proposes. Thread structure and a note link are direct writes.
    // Do not put those two behind a proposal.
    expect(byId.get("note.promote_to_knowledge")?.side_effects).toBe("proposal");
    expect(byId.get("note.raise_as_question")?.side_effects).toBe("durable");
    expect(byId.get("note.link_to_evidence")?.side_effects).toBe("durable");
    for (const id of NOTE_ACTION_IDS) {
      // Every one of them mutates, so every one needs an idempotency key.
      expect(byId.get(id)?.idempotency_required).toBe(true);
    }
  });

  it("binds only to object types the ontology registry knows", async () => {
    const { SYSTEM_ACTION_REGISTRY } = await import("@rainver/protocol");
    // An `applies_to` naming something that is not an entity would make the
    // menu unresolvable at the surface that renders it — the same class of
    // defect as a relation hint for an edge `object_relations` would reject.
    for (const definition of SYSTEM_ACTION_REGISTRY) {
      for (const objectType of definition.applies_to ?? []) {
        expect(entityDefinition(objectType), `${definition.id} applies_to ${objectType}`).toBeTruthy();
      }
    }
  });

  it("keeps the `note.` id prefix and the `applies_to` declaration in step", async () => {
    // The web selection bar renders `systemActionsForObjectType('note')` and
    // types its label map on `NoteSystemActionId`, which TypeScript can only
    // derive from the id prefix. If a note action were registered without the
    // prefix it would appear in the menu with an undefined label; if a
    // `note.`-prefixed action were registered without `applies_to`, the label
    // map would demand an entry for something the menu never shows.
    const { SYSTEM_ACTION_REGISTRY, systemActionsForObjectType } = await import("@rainver/protocol");
    const byPrefix = SYSTEM_ACTION_REGISTRY.filter((entry) => entry.id.startsWith("note.")).map((entry) => entry.id);
    const byDeclaration = systemActionsForObjectType("note").map((definition) => definition.id);
    expect(byPrefix.sort()).toEqual(byDeclaration.sort());
  });

  it("references policy actions that exist", async () => {
    const { SYSTEM_ACTION_REGISTRY, POLICY_ACTION_REGISTRY } = await import("@rainver/protocol");
    const known = new Set(POLICY_ACTION_REGISTRY.map((entry) => entry.action));
    for (const id of NOTE_ACTION_IDS) {
      const definition = SYSTEM_ACTION_REGISTRY.find((entry) => entry.id === id);
      expect(known.has(definition!.policy_action), `${id} → ${definition!.policy_action}`).toBe(true);
    }
  });
});
