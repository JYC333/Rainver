import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer";
import { captureModule } from "../src/modules/capture";
import { loadConfig } from "../src/config";
import { __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth";
import { __setCaptureServiceFactoryForTests } from "../src/modules/capture/routes";

/**
 * The route contract for the primary capture gesture.
 *
 * A rejected body has to read as the client's error: the length limit is most
 * easily hit by pasting, which is the one action the capture box exists for,
 * and a 500 there would look like the server had lost the thought.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthRepositoryForTests(null);
  __setCaptureServiceFactoryForTests(null);
  await app?.close();
  app = undefined;
});

const auth: AuthRepository = {
  async resolveIdentity() {
    return { ok: true, spaceId: "space-1", userId: "user-1" };
  },
  async getSpaceForUser() {
    throw new Error("not used");
  },
  async getCurrentUser() {
    throw new Error("not used");
  },
  async getUserSpaces() {
    throw new Error("not used");
  },
  async logout() {
    throw new Error("not used");
  },
  async findOrCreateFromGoogle() {
    throw new Error("not used");
  },
  async createSession() {
    throw new Error("not used");
  },
};

function server(): FastifyInstance {
  __setAuthRepositoryForTests(auth);
  return buildModuleServer(
    loadConfig({ SERVER_DATABASE_URL: "postgresql://server_ro@db:5432/agent_space" }), [captureModule], { logger: false },);
}

describe("POST /api/v1/captures", () => {
  it("passes the destination through and answers 201 with the projection", async () => {
    const capture = vi.fn().mockResolvedValue({
      activity_id: "11111111-1111-4111-8111-111111111111",
      destination: "object_marginalia",
      space_id: "22222222-2222-4222-8222-222222222222",
      project_id: "33333333-3333-4333-8333-333333333333",
      visibility: "private",
      status: "processed",
      note_id: "44444444-4444-4444-8444-444444444444",
      note_title: "My notes on H3",
      block_id: "66666666-6666-4666-8666-666666666666",
    });
    __setCaptureServiceFactoryForTests(() => ({ capture }));
    app = server();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/captures",
      payload: {
        text: "the control group here is wrong",
        destination: "object_marginalia",
        project_id: "33333333-3333-4333-8333-333333333333",
        target_id: "55555555-5555-4555-8555-555555555555",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().note_title).toBe("My notes on H3");
    // The anchor relocation extracts by; it has to reach the client, not just
    // the activity record.
    expect(res.json().block_id).toBe("66666666-6666-4666-8666-666666666666");
    expect(capture).toHaveBeenCalledWith({
      userId: "user-1",
      requestSpaceId: "space-1",
      destination: "object_marginalia",
      text: "the control group here is wrong",
      projectId: "33333333-3333-4333-8333-333333333333",
      targetId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("answers 422 for an unknown destination or an over-long paste, never 500", async () => {
    const capture = vi.fn();
    __setCaptureServiceFactoryForTests(() => ({ capture }));
    app = server();

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/captures",
      payload: { text: "hello", destination: "somewhere_else" },
    });
    expect(unknown.statusCode).toBe(422);

    const tooLong = await app.inject({
      method: "POST",
      url: "/api/v1/captures",
      payload: { text: "x".repeat(20001), destination: "personal_inbox" },
    });
    expect(tooLong.statusCode).toBe(422);
    expect(capture).not.toHaveBeenCalled();
  });
});
