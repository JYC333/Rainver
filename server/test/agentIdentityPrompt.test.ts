import { describe, expect, it } from "vitest";
import { renderAgentIdentityPrompt } from "../src/modules/agentGroups/agentIdentityPrompt.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

/**
 * What an Agent is told about itself before it is told what to do.
 *
 * The audience decision is the Memory module's and is covered against real
 * Postgres in `agentMemoryScopeDb.test.ts`. What is asserted here is the block
 * itself: the order, the budget, and that a runtime is never handed an empty
 * heading.
 */

const SPACE = "space-1";
const AGENT = "agent-1";
const ROOM = "room-1";

function db(role: string | null, memory: Array<{ memory_type: string; content: string }>): Queryable {
  return {
    query: (async (sql: string) => {
      if (String(sql).includes("FROM agents")) return { rows: [{ role_instruction: role }], rowCount: 1 };
      return {
        rows: memory.map((entry, index) => ({
          id: `memory-${index}`,
          title: null,
          origin_room_id: ROOM,
          updated_at: "2026-09-06T00:00:00.000Z",
          ...entry,
        })),
        rowCount: memory.length,
      };
    }) as Queryable["query"],
  } as Queryable;
}

describe("what an Agent is told about itself", () => {
  it("renders the owner's role first, then what the Agent made of it", async () => {
    const block = await renderAgentIdentityPrompt(
      db("Separate evidence from assumption.", [
        { memory_type: "persona", content: "I answer briefly and ask before expanding scope." },
        { memory_type: "lesson", content: "This Room wants a recommendation last." },
      ]),
      { spaceId: SPACE, agentId: AGENT, roomId: ROOM },
    );

    // Role before persona, because the role is what the person asked for and
    // the persona is what the Agent made of it.
    expect(block).toMatch(
      /Your role[\s\S]*Separate evidence from assumption\.[\s\S]*learned about yourself[\s\S]*I answer briefly[\s\S]*learned here before[\s\S]*recommendation last/,
    );
  });

  it("says nothing at all when there is nothing to say", async () => {
    // An empty heading is worse than no block: it tells a runtime it has an
    // identity and then shows it none.
    await expect(renderAgentIdentityPrompt(db(null, []), { spaceId: SPACE, agentId: AGENT, roomId: ROOM }))
      .resolves.toBeNull();
  });

  it("omits a section it has nothing for, rather than rendering it empty", async () => {
    const noRole = await renderAgentIdentityPrompt(
      db(null, [{ memory_type: "persona", content: "I check my own claims." }]),
      { spaceId: SPACE, agentId: AGENT, roomId: ROOM },
    );
    expect(noRole).not.toMatch(/Your role/);
    expect(noRole).toMatch(/I check my own claims\./);

    const noMemory = await renderAgentIdentityPrompt(
      db("Be exact.", []),
      { spaceId: SPACE, agentId: AGENT, roomId: ROOM },
    );
    expect(noMemory).toBe("[Your role, set by the person who owns you]\nBe exact.");
  });

  it("skips a note too large for what is left instead of stopping there", async () => {
    // A newest-first list can begin with one enormous note. Stopping would
    // leave the section empty and the Agent unable to tell "I learned nothing
    // here" from "the budget ran out on the first line".
    const block = await renderAgentIdentityPrompt(
      db(null, [
        { memory_type: "note", content: "x".repeat(4000) },
        { memory_type: "note", content: "the short one that matters" },
      ]),
      { spaceId: SPACE, agentId: AGENT, roomId: ROOM },
    );

    expect(block).toContain("the short one that matters");
    expect(block).not.toContain("x".repeat(4000));
  });

  it("clamps a runaway persona rather than letting it carry every turn", async () => {
    // Nothing caps what a persona may say, and an unattended Run applies one
    // without anyone deciding it — so this is the only thing between a runaway
    // persona and every turn of every Room.
    const block = await renderAgentIdentityPrompt(
      db(null, [{ memory_type: "persona", content: "y".repeat(5000) }]),
      { spaceId: SPACE, agentId: AGENT, roomId: ROOM },
    );

    expect(block!.length).toBeLessThan(2200);
    expect(block).toContain("…");
  });

  it("drops the oldest notes rather than cutting one off mid-sentence", async () => {
    // The delivery query orders persona first, then newest-first, so the tail
    // of this list is the oldest — and what an Agent learned most recently is
    // what it is most likely to need.
    const long = "x".repeat(900);
    const block = await renderAgentIdentityPrompt(
      db(null, [
        { memory_type: "note", content: `newest ${long}` },
        { memory_type: "note", content: `middle ${long}` },
        { memory_type: "note", content: `older ${long}` },
        { memory_type: "note", content: `oldest ${long}` },
      ]),
      { spaceId: SPACE, agentId: AGENT, roomId: ROOM },
    );

    expect(block).toContain("newest");
    expect(block).toContain("older");
    expect(block).not.toContain("oldest");
    // Whole notes only: nothing is truncated in the middle.
    expect(block!.split("\n").filter((line) => line.startsWith("- ")).every((line) => line.endsWith(long)))
      .toBe(true);
  });
});
