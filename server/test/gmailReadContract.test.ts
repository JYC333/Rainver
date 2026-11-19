import { describe, expect, it } from "vitest";
import {
  GMAIL_API_ORIGIN,
  GMAIL_READONLY_SCOPE,
  GmailContractError,
  assertGmailReadUrl,
  createGmailSendBudget,
  evaluateGrantedGmailScopes,
  gmailMessageFullUrl,
  gmailProfileUrl,
  gmailSourceRequestRoutes,
  gmailThreadMetadataUrl,
} from "../src/modules/sources/gmail/gmailReadContract.js";

const refused = (url: string) => expect(() => assertGmailReadUrl(url), url).toThrow(GmailContractError);
const base = `${GMAIL_API_ORIGIN}/gmail/v1/users/me`;

describe("Gmail read URL allowlist", () => {
  it("accepts exactly the URLs its builders produce", () => {
    const built = [
      gmailProfileUrl(),
      gmailThreadMetadataUrl("18c2f0a1b2c3d4e5"),
      gmailMessageFullUrl("18c2f0a1b2c3d4e6"),
    ];
    for (const url of built) expect(assertGmailReadUrl(url).toString()).toBe(url);
  });

  it("matches every built URL to exactly one GET broker route by the broker's prefix rule", () => {
    const routes = gmailSourceRequestRoutes(async () => ({ Authorization: "Bearer unused-test-value" }));
    for (const raw of [gmailProfileUrl(), gmailThreadMetadataUrl("ab"), gmailMessageFullUrl("cd")]) {
      const url = new URL(raw);
      const matches = routes.filter((r) => r.origin === url.origin
        && (url.pathname === r.path_prefix || url.pathname.startsWith(`${r.path_prefix}/`)));
      expect(matches, raw).toHaveLength(1);
      expect(matches[0]!.methods).toEqual(["GET"]);
      expect([...url.searchParams.keys()].every((k) => matches[0]!.query_keys!.includes(k))).toBe(true);
    }
  });

  it("refuses mutation, attachment, other-mailbox and widened-format requests", () => {
    for (const url of [
      `${base}/messages/send`,
      `${base}/messages/abc/modify`,
      `${base}/messages/abc/trash`,
      `${base}/messages/abc/attachments/def`,
      `${base}/messages/batchModify`,
      `${base}/messages/import`,
      `${base}/messages`,
      `${base}/threads/abc/modify`,
      `${base}/drafts`,
      `${base}/labels`,
      `${base}/history?startHistoryId=1`,
      `${base}/settings/filters`,
      `${base}/watch`,
      // Thread search was retired with Gmail V2; the owner-read allowlist no longer admits it.
      `${base}/threads?q=x&maxResults=20`,
      `${base}/messages/abc?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To`,
      `${GMAIL_API_ORIGIN}/gmail/v1/users/someone@example.com/threads?q=x&maxResults=20`,
      `${base}/messages/abc?format=raw`,
      `${base}/messages/abc`,
      `${base}/threads/abc?format=full`,
      `${base}/threads/abc?format=metadata&metadataHeaders=Cc`,
      `${base}/threads/abc?format=metadata`,
      `${base}/threads/abc?format=metadata&metadataHeaders=Subject`,
      `${base}/threads/abc?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=To`,
      `${base}/threads/abc?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date&metadataHeaders=Date`,
      `${base}/threads?maxResults=20`,
      `${base}/threads?q=&maxResults=20`,
      `${base}/threads?q=%20x&maxResults=20`,
      `${base}/threads?q=a%0Ab&maxResults=20`,
      `${base}/threads?q=a%7Fb&maxResults=20`,
      `${base}/threads?q=${"x".repeat(513)}&maxResults=20`,
      `${base}/threads?q=x&maxResults=19.5`,
      `${base}/threads?q=x&maxResults=2e1`,
      `${base}/threads?q=x&maxResults=020`,
      `${base}/threads?q=x&maxResults=`,
      `${base}/threads?q=x&maxResults=500`,
      `${base}/threads?q=x&maxResults=20&includeSpamTrash=true`,
      `${base}/threads?q=x&q=y&maxResults=20`,
      `${base}/threads/ABC?format=metadata`,
      `${base}/threads/a%2Fb?format=metadata`,
      `${base}/profile?fields=emailAddress`,
      `http://gmail.googleapis.com/gmail/v1/users/me/profile`,
      `https://gmail.googleapis.com:8443/gmail/v1/users/me/profile`,
      `https://user:pw@gmail.googleapis.com/gmail/v1/users/me/profile`,
      `https://www.googleapis.com/gmail/v1/users/me/profile`,
      `${base}/profile#x`,
      "not a url",
    ]) refused(url);
  });

  it("refuses invalid ids before any URL exists", () => {
    expect(() => gmailThreadMetadataUrl("../drafts")).toThrow(GmailContractError);
    expect(() => gmailMessageFullUrl("ABC")).toThrow(GmailContractError);
  });
});

describe("Gmail per-page send budget", () => {
  it("allows exactly sendsPerPage physical sends", () => {
    const budget = createGmailSendBudget();
    const url = new URL(gmailProfileUrl());
    for (let i = 0; i < 21; i += 1) budget.consume(url);
    expect(budget.remaining).toBe(0);
    expect(() => budget.consume(url)).toThrow(GmailContractError);
  });
});

describe("Gmail granted-scope policy", () => {
  it("accepts gmail.readonly with identity-only scopes", () => {
    expect(evaluateGrantedGmailScopes(`openid ${GMAIL_READONLY_SCOPE}`)).toEqual({ ok: true, scopes: [GMAIL_READONLY_SCOPE, "openid"].sort() });
    expect(evaluateGrantedGmailScopes(`${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/userinfo.email`).ok).toBe(true);
  });

  it("refuses a token without gmail.readonly", () => {
    expect(evaluateGrantedGmailScopes("openid email")).toMatchObject({ ok: false, code: "gmail_scope_missing" });
    expect(evaluateGrantedGmailScopes(undefined)).toMatchObject({ ok: false, code: "gmail_scope_missing" });
  });

  it("refuses any mailbox or unrelated authority beyond read-only", () => {
    for (const extra of [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.insert",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://www.googleapis.com/auth/drive.readonly",
    ]) {
      expect(evaluateGrantedGmailScopes(`openid ${GMAIL_READONLY_SCOPE} ${extra}`), extra).toMatchObject({ ok: false, code: "gmail_scope_excess" });
    }
  });
});
