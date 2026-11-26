import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetBrowserAccountLedgerForTests, endBrowser, endedFor, lateSelectorRepair, noteSelected, recordIssued, revokedLate } from "../src/modules/auth/browserAccountLedger.js";

describe("browser account ledger", () => {
  beforeEach(() => { __resetBrowserAccountLedgerForTests(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("stops treating a signed-out session as ended once its mark expires, without waiting for a sweep", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    endBrowser(["session-a"], ["token-a"]);
    expect(endedFor(["session-a"], [])).toBe(true);
    expect(endedFor([], ["token-a"])).toBe(true);
    now.mockReturnValue(start + 15 * 60_000 - 1);
    expect(endedFor(["session-a"], [])).toBe(true);
    // Nothing else touched the ledger meanwhile, so nothing swept the mark away.
    now.mockReturnValue(start + 15 * 60_000);
    expect(endedFor(["session-a"], [])).toBe(false);
    expect(endedFor([], ["token-a"])).toBe(false);
  });

  it("revokes a rotation the browser never showed holding without marking it ended, and repairs only a selector naming it", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    // A password change from session-a issued session-r; its response is still on the way.
    recordIssued(["session-a"], { sessionId: "session-r", userId: "user-a" }, ["token-a"]);
    expect(endBrowser([], ["token-a"])).toEqual(expect.arrayContaining(["session-a", "session-r"]));
    // A request that left before the logout carried session-a or its token; one carrying session-r left after it.
    expect(endedFor(["session-a"], [])).toBe(true);
    expect(endedFor(["session-r"], [])).toBe(false);
    expect(revokedLate("session-r")).toBe(true);
    expect(lateSelectorRepair("session-r", ["session-r"])).toEqual({ to: null });
    // Another tab signs in as b, then adds c, then switches back to b.
    now.mockReturnValue(start + 1000);
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    now.mockReturnValue(start + 2000);
    recordIssued(["session-b"], { sessionId: "session-c", userId: "user-c" });
    now.mockReturnValue(start + 3000);
    noteSelected(["session-b", "session-c"], "session-b");
    expect(lateSelectorRepair("session-r", ["session-b", "session-c", "session-r"])).toEqual({ to: "session-b" });
    // A selector naming anything else is the browser's own choice and is left.
    expect(lateSelectorRepair("session-c", ["session-b", "session-c"])).toBeNull();
    expect(lateSelectorRepair("session-a", ["session-b"])).toBeNull();
    // 15 minutes after the last request that relied on it.
    now.mockReturnValue(start + 3000 + 15 * 60_000);
    expect(lateSelectorRepair("session-r", ["session-b"])).toBeNull();
  });

  it("keeps recognizing a written-back selector while requests keep relying on it", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    recordIssued(["session-a"], { sessionId: "session-r", userId: "user-a" }, ["token-a"]);
    endBrowser([], ["token-a"]);
    now.mockReturnValue(start + 1000);
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    // Each repair renews the marks it used, so the browser, which keeps the selector, is read as b past the first TTL.
    for (const minutes of [10, 20, 30]) {
      now.mockReturnValue(start + minutes * 60_000);
      expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: "session-b" });
    }
    // 15 minutes with no request relying on it: the ledger no longer knows.
    now.mockReturnValue(start + 45 * 60_000);
    expect(lateSelectorRepair("session-r", ["session-b"])).toBeNull();
    expect(revokedLate("session-r")).toBe(false);
  });

  it("answers none, not an earlier entry, when the browser's last selection since the logout is gone", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    recordIssued(["session-a"], { sessionId: "session-r", userId: "user-a" }, ["token-a"]);
    endBrowser([], ["token-a"]);
    // After the logout the browser signs in as b, adds c, and c is its last selection.
    now.mockReturnValue(start + 1000);
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    now.mockReturnValue(start + 2000);
    recordIssued(["session-b"], { sessionId: "session-c", userId: "user-c" }, ["token-b"]);
    expect(lateSelectorRepair("session-r", ["session-b", "session-c"])).toEqual({ to: "session-c" });
    // c's cookie is gone (not remembered across a browser restart, or dropped once revoked or expired).
    now.mockReturnValue(start + 3000);
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: null });
    // Still none while requests keep relying on the mark, past the first TTL.
    for (const minutes of [10, 20, 30]) {
      now.mockReturnValue(start + minutes * 60_000);
      expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: null });
    }
  });

  it("answers none when the last selection was a switch to an entry whose cookie is gone", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    recordIssued(["session-a"], { sessionId: "session-r", userId: "user-a" }, ["token-a"]);
    endBrowser([], ["token-a"]);
    now.mockReturnValue(start + 1000);
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    now.mockReturnValue(start + 2000);
    recordIssued(["session-b"], { sessionId: "session-c", userId: "user-c" }, ["token-b"]);
    // Switches back and forth keep the browser's group held past its first TTL.
    now.mockReturnValue(start + 10 * 60_000);
    noteSelected(["session-b", "session-c"], "session-b");
    expect(lateSelectorRepair("session-r", ["session-b", "session-c"])).toEqual({ to: "session-b" });
    now.mockReturnValue(start + 20 * 60_000);
    noteSelected(["session-b", "session-c"], "session-c");
    expect(lateSelectorRepair("session-r", ["session-b", "session-c"])).toEqual({ to: "session-c" });
    now.mockReturnValue(start + 21 * 60_000);
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: null });
    // With c still in the jar, c is the target.
    expect(lateSelectorRepair("session-r", ["session-b", "session-c"])).toEqual({ to: "session-c" });
  });

  it("orders selections and the logout by event, not by the clock", () => {
    // Every event in one millisecond, then the clock stepping back.
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    recordIssued(["session-a"], { sessionId: "session-r", userId: "user-a" }, ["token-a"]);
    endBrowser([], ["token-a"]);
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    recordIssued(["session-b"], { sessionId: "session-c", userId: "user-c" }, ["token-b"]);
    noteSelected(["session-b", "session-c"], "session-b");
    expect(lateSelectorRepair("session-r", ["session-b", "session-c", "session-r"])).toEqual({ to: "session-b" });
    now.mockReturnValue(start - 60_000);
    noteSelected(["session-b", "session-c"], "session-c");
    expect(lateSelectorRepair("session-r", ["session-c", "session-b"])).toEqual({ to: "session-c" });
    // A selection before the logout, in the same millisecond, is not one since.
    __resetBrowserAccountLedgerForTests();
    now.mockReturnValue(start);
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    recordIssued(["session-b"], { sessionId: "session-r", userId: "user-b" }, ["token-b"]);
    endBrowser([], ["token-b"]);
    expect(lateSelectorRepair("session-r", ["session-r"])).toEqual({ to: null });
  });

  it("answers none, not a remaining entry, once the browser's group was evicted for capacity", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    recordIssued(["session-a"], { sessionId: "session-r", userId: "user-a" }, ["token-a"]);
    endBrowser([], ["token-a"]);
    now.mockReturnValue(start + 1000);
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    now.mockReturnValue(start + 2000);
    recordIssued(["session-b"], { sessionId: "session-c", userId: "user-c" }, ["token-b"]);
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: null });
    // Other browsers fill the table; this one, least recently touched, goes.
    now.mockReturnValue(start + 3000);
    for (let index = 0; index <= 4096; index += 1) recordIssued([], { sessionId: `other-${index}`, userId: `user-${index}` });
    // c, its last selection, is gone with the group: b is not chosen in its place.
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: null });
    expect(lateSelectorRepair("session-r", ["session-b", "session-c"])).toEqual({ to: null });
    // A selection made since is known again in full.
    noteSelected(["session-b", "session-c"], "session-b");
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: "session-b" });
  });

  /** A logout that revoked session-r before the browser held it; its late answer writes it back as the selector. */
  function lateRevokedBrowser(): void {
    recordIssued(["session-a"], { sessionId: "session-r", userId: "user-a" }, ["token-a"]);
    endBrowser([], ["token-a"]);
  }

  it("answers none, not a remaining entry, when a group it never showed holds a later selection", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    lateRevokedBrowser();
    // Two sign-ins in flight together: neither carried the other, so they are two groups; y is selected later.
    now.mockReturnValue(start + 1000);
    recordIssued([], { sessionId: "session-x", userId: "user-x" });
    recordIssued([], { sessionId: "session-y", userId: "user-y" });
    // y's cookie is gone before any repair saw it: x is not inferred to be the last selection.
    expect(lateSelectorRepair("session-r", ["session-x"])).toEqual({ to: null });
    // Not after the groups expire either: the later selection was recorded when it was made.
    for (const minutes of [10, 20, 30]) {
      now.mockReturnValue(start + minutes * 60_000);
      expect(lateSelectorRepair("session-r", ["session-x"])).toEqual({ to: null });
    }
    // An entry the ledger knows nothing of adds no evidence either way.
    expect(lateSelectorRepair("session-r", ["session-x", "session-unknown"])).toEqual({ to: null });
  });

  it("answers none once a group seen beside the jar is gone, and after it was seen", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    lateRevokedBrowser();
    now.mockReturnValue(start + 1000);
    recordIssued([], { sessionId: "session-x", userId: "user-x" });
    recordIssued([], { sessionId: "session-y", userId: "user-y" });
    expect(lateSelectorRepair("session-r", ["session-x", "session-y"])).toEqual({ to: "session-y" });
    now.mockReturnValue(start + 2000);
    expect(lateSelectorRepair("session-r", ["session-x"])).toEqual({ to: null });
    // In the reverse order x, selected last, is the answer while it is shown, and none once it is gone.
    __resetBrowserAccountLedgerForTests();
    lateRevokedBrowser();
    recordIssued([], { sessionId: "session-y", userId: "user-y" });
    recordIssued([], { sessionId: "session-x", userId: "user-x" });
    expect(lateSelectorRepair("session-r", ["session-y", "session-x"])).toEqual({ to: "session-x" });
    expect(lateSelectorRepair("session-r", ["session-y"])).toEqual({ to: null });
  });

  it("groups a switch with every session the switching request verified", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(start);
    lateRevokedBrowser();
    recordIssued([], { sessionId: "session-x", userId: "user-x" });
    recordIssued([], { sessionId: "session-y", userId: "user-y" });
    // A switch to x from a request showing x and y joins the two groups.
    noteSelected(["session-x", "session-y"], "session-x", ["token-x", "token-y"]);
    expect(lateSelectorRepair("session-r", ["session-x", "session-y"])).toEqual({ to: "session-x" });
    // x's cookie gone: y is not chosen in its place.
    expect(lateSelectorRepair("session-r", ["session-y"])).toEqual({ to: null });
    // A logout carrying only y revokes x, switched to in the same browser.
    expect(endBrowser(["session-y"], ["token-y"])).toContain("session-x");
  });

  it("restores the switch made after the browser's group was evicted for capacity", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    lateRevokedBrowser();
    now.mockReturnValue(start + 1000);
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    recordIssued(["session-b"], { sessionId: "session-c", userId: "user-c" }, ["token-b"]);
    now.mockReturnValue(start + 2000);
    for (let index = 0; index <= 4096; index += 1) recordIssued([], { sessionId: `other-${index}`, userId: `user-${index}` });
    expect(lateSelectorRepair("session-r", ["session-b", "session-c"])).toEqual({ to: null });
    // The switch regroups every session it verified, so a later loss of c is still known.
    noteSelected(["session-b", "session-c"], "session-c");
    expect(lateSelectorRepair("session-r", ["session-b", "session-c"])).toEqual({ to: "session-c" });
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: null });
  });

  it("is not displaced by selections in groups older than the logout, only by fresh ones", () => {
    const start = Date.parse("2026-11-25T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(start);
    // Another browser, signed in before the logout, keeps switching and adding accounts.
    recordIssued([], { sessionId: "elsewhere-1", userId: "user-e1" });
    lateRevokedBrowser();
    recordIssued([], { sessionId: "session-b", userId: "user-b" });
    recordIssued(["elsewhere-1"], { sessionId: "elsewhere-2", userId: "user-e2" }, ["token-e1"]);
    noteSelected(["elsewhere-1", "elsewhere-2"], "elsewhere-1");
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: "session-b" });
    // A fresh sign-in after b's selection may be this browser's: none until the browser selects again.
    recordIssued([], { sessionId: "fresh-1", userId: "user-f1" });
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: null });
    noteSelected(["session-b"], "session-b");
    expect(lateSelectorRepair("session-r", ["session-b"])).toEqual({ to: "session-b" });
  });

  it("still ends a rotated session a request of the browser showed holding", () => {
    recordIssued(["session-a"], { sessionId: "session-r", userId: "user-a" }, ["token-a"]);
    // A later addition proved session-r: the browser held it before the logout, which carried only the newer session.
    recordIssued(["session-r"], { sessionId: "session-c", userId: "user-c" }, ["token-r"]);
    endBrowser(["session-c"], ["token-c"]);
    endBrowser([], ["token-a"]);
    expect(endedFor(["session-r"], [])).toBe(true);
    expect(revokedLate("session-r")).toBe(false);
  });
});
