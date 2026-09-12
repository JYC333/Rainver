import { describe, expect, it } from "vitest";
import { csrfOriginAllowed, stateChangingReadAllowed } from "../src/gateway/csrfOrigin.js";

function request(method: string, headers: Record<string, string>) {
  return { method, headers };
}

describe("csrf origin check", () => {
  it("allows safe methods and mutating requests without an Origin header", () => {
    expect(csrfOriginAllowed(request("GET", { origin: "https://evil.example" }), "http://localhost:5173")).toBe(true);
    expect(csrfOriginAllowed(request("POST", {}), "http://localhost:5173")).toBe(true);
  });

  it("allows the configured frontend origin", () => {
    expect(csrfOriginAllowed(request("POST", { origin: "http://localhost:5173" }), "http://localhost:5173")).toBe(true);
  });

  it("refuses an Origin that only matches the request's own host", () => {
    expect(csrfOriginAllowed(
      request("POST", { origin: "http://localhost:3000", host: "localhost:3000" }),
      "http://localhost:5173",
    )).toBe(false);
  });

  it("refuses an explicit cross-site or opaque Origin", () => {
    expect(csrfOriginAllowed(request("POST", { origin: "https://evil.example" }), "http://localhost:5173")).toBe(false);
    expect(csrfOriginAllowed(request("POST", { origin: "null" }), "http://localhost:5173")).toBe(false);
  });

  it("refuses a write a browser says another site caused, with or without an Origin", () => {
    expect(csrfOriginAllowed(request("POST", { "sec-fetch-site": "cross-site" }), "http://localhost:5173")).toBe(false);
    expect(csrfOriginAllowed(request("PATCH", { "sec-fetch-site": "cross-origin" }), "http://localhost:5173")).toBe(false);
    expect(csrfOriginAllowed(
      request("DELETE", { "sec-fetch-site": "cross-site", origin: "http://localhost:5173" }),
      "http://localhost:5173",
    )).toBe(false);
  });

  it("still serves the web client and the callers that send no fetch metadata", () => {
    expect(csrfOriginAllowed(request("POST", { "sec-fetch-site": "same-origin" }), "http://localhost:5173")).toBe(true);
    // The person's own address bar cannot produce a write, but it costs nothing
    // to say so rather than fail on it.
    expect(csrfOriginAllowed(request("POST", { "sec-fetch-site": "none" }), "http://localhost:5173")).toBe(true);
    // A host daemon, the Run CLI, and `app.inject` send neither header.
    expect(csrfOriginAllowed(request("POST", {}), "http://localhost:5173")).toBe(true);
  });
});

describe("state-changing read check", () => {
  function read(headers: Record<string, string>) {
    return { headers };
  }
  const FRONTEND = "http://localhost:5173";

  it("allows what the web client's own fetch sends", () => {
    expect(stateChangingReadAllowed(read({ "sec-fetch-site": "same-origin" }), FRONTEND)).toBe(true);
    // The person's own address bar.
    expect(stateChangingReadAllowed(read({ "sec-fetch-site": "none" }), FRONTEND)).toBe(true);
  });

  it("refuses a same-site navigation, and lets a same-site fetch prove itself by Origin", () => {
    // A top-level navigation from any host under the same registrable domain
    // sends `same-site` with no `Origin` and the `SameSite=Lax` cookie — which
    // is enough to drive a folder read or a login stream from a sibling host
    // somebody else controls.
    expect(stateChangingReadAllowed(read({ "sec-fetch-site": "same-site" }), FRONTEND)).toBe(false);
    // A frontend served from a sibling host of the API is also `same-site`,
    // but its `fetch` names itself, and that is the more specific answer.
    expect(stateChangingReadAllowed(
      read({ "sec-fetch-site": "same-site", origin: FRONTEND }),
      FRONTEND,
    )).toBe(true);
    expect(stateChangingReadAllowed(
      read({ "sec-fetch-site": "same-site", origin: "https://other.localhost" }),
      FRONTEND,
    )).toBe(false);
  });

  it("refuses a request another site caused", () => {
    expect(stateChangingReadAllowed(read({ "sec-fetch-site": "cross-site" }), FRONTEND)).toBe(false);
    // Even carrying headers that would otherwise stand in for first-party.
    expect(stateChangingReadAllowed(
      read({ "sec-fetch-site": "cross-site", "x-rainver-space-id": "space-1", authorization: "Bearer t" }),
      FRONTEND,
    )).toBe(false);
    expect(stateChangingReadAllowed(read({ "sec-fetch-site": "cross-origin" }), FRONTEND)).toBe(false);
  });

  it("judges an explicit Origin against the configured frontend", () => {
    expect(stateChangingReadAllowed(read({ origin: FRONTEND }), FRONTEND)).toBe(true);
    expect(stateChangingReadAllowed(read({ origin: "https://evil.example" }), FRONTEND)).toBe(false);
    expect(stateChangingReadAllowed(read({ origin: "null" }), FRONTEND)).toBe(false);
  });

  it("fails closed on a request carrying no fetch metadata and nothing first-party", () => {
    // A top-level cross-site navigation from a browser that sends no
    // `Sec-Fetch-Site` carries no `Origin` either, and `SameSite=Lax` sends the
    // session cookie with it. Allowing this case was the hole.
    expect(stateChangingReadAllowed(read({}), FRONTEND)).toBe(false);
    expect(stateChangingReadAllowed(read({ referer: "https://evil.example/" }), FRONTEND)).toBe(false);
  });

  it("allows a non-browser caller that sets a header of its own", () => {
    expect(stateChangingReadAllowed(read({ "x-rainver-space-id": "space-1" }), FRONTEND)).toBe(true);
    expect(stateChangingReadAllowed(read({ authorization: "Bearer host-token" }), FRONTEND)).toBe(true);
    // The real header name. It was spelled `x-internal-token`, which nothing
    // sends, so this disjunct could never have fired.
    expect(stateChangingReadAllowed(read({ "x-rainver-internal-token": "internal" }), FRONTEND)).toBe(true);
    expect(stateChangingReadAllowed(read({ "x-internal-token": "internal" }), FRONTEND)).toBe(false);
  });
});
