import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import type { Queryable } from "../src/modules/routeUtils/common";
import { SourceChannelService } from "../src/modules/sources/channels/sourceChannelService";
import { ProjectSourceBindingService } from "../src/modules/projects/projectSourceBindingService";

const identity = { spaceId: "space-1", userId: "user-1" };

/** Input that must be refused at the service boundary, before any SQL runs. */
describe("Source service boundaries", () => {
  it("requires a Provider instead of an implementation connector key", async () => {
    const query = vi.fn();
    const service = new SourceChannelService({ query } as Queryable, loadConfig({}));
    await expect(service.create({ spaceId: "space-1", userId: "user-1" }, {
      connector_key: "custom_source",
      name: "Bypass attempt",
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects malformed project binding commands before persistence", async () => {
    const query = vi.fn();
    const service = new ProjectSourceBindingService({ query } as Queryable);

    expect(() => service.createBinding(identity, {
      project_id: "project-1",
      source_channel_id: "channel-1",
      delivery_scope: "everyone",
    })).toThrow(expect.objectContaining({ statusCode: 422 }));
    await expect(service.updateBinding(identity, "binding-1", { status: "deleted" }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(query).not.toHaveBeenCalled();
  });
});
