import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { REQUEST_ID_HEADER } from "../src/gateway/requestContext.js";
import { ProviderInvocationError } from "../src/modules/providers/invocation/invocation.js";
import { HttpError, sendRouteError } from "../src/modules/routeUtils/common.js";

// What a route answers when a dependency fails. A 5xx the server did not
// author as a structured body must not carry the exception's text: provider
// response bodies, URLs with credentials, machine paths and other Spaces'
// content all travel in those messages. The log keeps them under the request id.

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function appThrowing(error: unknown) {
  const app = Fastify({ logger: false });
  app.get("/fail", async (_request, reply) => {
    reply.header(REQUEST_ID_HEADER, "req-123");
    return sendRouteError(reply, error);
  });
  apps.push(app);
  return app;
}

describe("sendRouteError", () => {
  it("withholds a provider failure's message and answers with allowlisted structure only", async () => {
    const secret = "https://alice:ghp_tokenvalue@api.example.test/v1 returned: {\"internal_path\":\"/srv/rainver/other-space\"}";
    const error = new ProviderInvocationError(502, `Provider request failed: ${secret}`, { failure_class: "transient", actions: ["fail"] }, "provider_network_error", undefined, secret);
    const response = await appThrowing(error).inject({ method: "GET", url: "/fail" });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      detail: "The request could not be completed; the server log has the details under this request id.",
      request_id: "req-123",
      code: "provider_network_error",
      failure_class: "transient",
      retryable: true,
    });
    expect(response.body).not.toContain("ghp_tokenvalue");
    expect(response.body).not.toContain("other-space");
  });

  it("withholds the message of a plain 5xx HttpError but keeps one the server authored as a body", async () => {
    const plain = await appThrowing(new HttpError(502, "upstream said: token=abc at /home/alice")).inject({ method: "GET", url: "/fail" });
    expect(plain.statusCode).toBe(502);
    expect(plain.body).not.toContain("token=abc");
    expect(plain.json()).toMatchObject({ request_id: "req-123" });

    const authored = await appThrowing(new HttpError(503, "ignored", { detail: "Files cannot be read on this host", code: "unsupported_platform" }))
      .inject({ method: "GET", url: "/fail" });
    expect(authored.json()).toEqual({ detail: "Files cannot be read on this host", code: "unsupported_platform" });
  });

  it("keeps a 4xx message, which the server wrote for the client", async () => {
    const response = await appThrowing(new HttpError(422, "repo_url must be an https:// URL")).inject({ method: "GET", url: "/fail" });
    expect(response.json()).toEqual({ detail: "repo_url must be an https:// URL" });
  });

  it("drops a code or failure class outside the allowlist", async () => {
    const error = Object.assign(new Error("boom with /private/path"), {
      statusCode: 500,
      code: "Not A Code; drop table",
      resilience: { failure_class: "something-else" },
    });
    const response = await appThrowing(error).inject({ method: "GET", url: "/fail" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      detail: "The request could not be completed; the server log has the details under this request id.",
      request_id: "req-123",
    });
  });
});
