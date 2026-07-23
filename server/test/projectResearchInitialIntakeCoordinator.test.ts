import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config";
import type { Queryable } from "../src/modules/routeUtils/common";
import { ProjectResearchInitialIntakeCoordinator } from "../src/modules/projectResearch/pipeline/initialIntakeCoordinator";

const identity = { spaceId: "space", userId: "user" };

describe("ProjectResearchInitialIntakeCoordinator", () => {
  it("rejects the complete selection when any materialized monitor is unavailable", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: "channel-1" }], rowCount: 1 }),
    } as unknown as Queryable;
    const coordinator = new ProjectResearchInitialIntakeCoordinator(db, {} as ServerConfig);

    await expect(coordinator.resolveChannels(identity, ["channel-1", "channel-2"]))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("reuses an active project binding instead of creating a duplicate", async () => {
    const binding = { id: "binding", source_channel_id: "channel" };
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [binding], rowCount: 1 }),
    } as unknown as Queryable;
    const coordinator = new ProjectResearchInitialIntakeCoordinator(db, {} as ServerConfig);

    await expect(coordinator.ensureBinding(identity, "project", "channel")).resolves.toEqual(binding);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
