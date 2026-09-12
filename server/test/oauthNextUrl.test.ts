import { describe, expect, it } from "vitest";
import { safeNextUrl } from "../src/modules/auth/oauth.js";

/**
 * The `next` value is appended to `FRONTEND_URL` and handed to the browser as a
 * redirect out of the OAuth callback, so anything that resolves off-site is an
 * open redirect on the one route that runs before a session exists.
 */
describe("safeNextUrl", () => {
  it("keeps an in-app path, with its query and hash", () => {
    expect(safeNextUrl("/invitations/tok123?auto=1")).toBe("/invitations/tok123?auto=1");
    expect(safeNextUrl("/projects/p1#top")).toBe("/projects/p1#top");
    expect(safeNextUrl("/")).toBe("/");
  });

  it("refuses anything that is not a single-slash path", () => {
    for (const value of ["//evil.example/x", "https://evil.example", "javascript:alert(1)", "invitations/x", "", undefined]) {
      expect(safeNextUrl(value), String(value)).toBe("");
    }
  });

  it("refuses a path the browser would resolve off-site", () => {
    // One leading slash, no backslash — and the browser collapses it to
    // `//evil.example`, which is protocol-relative and leaves the site.
    expect(safeNextUrl("/..//evil.example")).toBe("");
    expect(safeNextUrl("/../..//evil.example/x")).toBe("");
  });

  it("refuses a backslash, which browsers have read as a slash", () => {
    expect(safeNextUrl("/\\evil.example")).toBe("");
    expect(safeNextUrl("/\\\\evil.example")).toBe("");
  });

  it("returns the resolved path, so a later reader cannot re-derive a different one", () => {
    expect(safeNextUrl("/projects/../invitations/tok123")).toBe("/invitations/tok123");
  });
});
