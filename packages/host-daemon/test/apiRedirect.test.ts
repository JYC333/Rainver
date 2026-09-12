import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { revokeCurrentHost } from "../src/api.js";

/**
 * Every call in `api.ts` carries this host's bearer token, and registration
 * exchanges a one-time pairing code for a long-lived one. A followed redirect
 * is the control plane telling the daemon to send that credential somewhere
 * else — including from https down to http, or to an origin the owner never
 * paired with. `redirect: "error"` is what stops it, and that only shows up
 * against a server that actually answers with a 302.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("control-plane calls never follow a redirect", () => {
  it("refuses rather than re-sending the host token to the redirect target", async () => {
    const received: Array<string | undefined> = [];
    const target = await listen((request, response) => {
      received.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const origin = await listen((_request, response) => {
      response.writeHead(302, { location: `${target}/api/v1/hosts/me/revoke` });
      response.end();
    });

    await expect(revokeCurrentHost(origin, "host-bearer-token")).rejects.toThrow(/Could not reach the control plane/);
    expect(received).toEqual([]);
  });

  it("still completes an ordinary non-redirected call", async () => {
    const seen: Array<string | undefined> = [];
    const origin = await listen((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });

    await expect(revokeCurrentHost(origin, "host-bearer-token")).resolves.toBeUndefined();
    expect(seen).toEqual(["Bearer host-bearer-token"]);
  });
});
