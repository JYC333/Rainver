import { describe, expect, it } from "vitest";
import { GmailMonitorCriteriaSchema } from "@rainver/protocol";
import {
  assertGmailSyncUrl, GMAIL_WATCH_URL, gmailHistoryUrl, gmailMessageMetadataUrl, gmailProfileUrl, gmailRecoveryListUrl, historyIdGreater,
} from "../src/modules/sources/gmail/gmailSyncContract.js";
import { assertGmailReadUrl, GmailContractError } from "../src/modules/sources/gmail/gmailReadContract.js";
import { gmailMonitorMatches, headerAddresses } from "../src/modules/sources/gmail/gmailMonitorCriteria.js";

const base = "https://gmail.googleapis.com/gmail/v1/users/me";
const refused = (url: string) => expect(() => assertGmailSyncUrl(url), url).toThrow(GmailContractError);

describe("Gmail sync URL allowlist", () => {
  it("accepts exactly what its builders produce, and the read allowlist accepts none of the sync-only shapes", () => {
    const built = [
      gmailProfileUrl(), gmailHistoryUrl({ startHistoryId: "12345" }), gmailHistoryUrl({ startHistoryId: "12345", pageToken: "abc_-1" }),
      gmailRecoveryListUrl({ afterEpochSeconds: 1_700_000_000 }), gmailRecoveryListUrl({ afterEpochSeconds: 1_700_000_000, pageToken: "p40" }),
      gmailMessageMetadataUrl("18c2f0a1b2c3d4e5"),
    ];
    for (const url of built) expect(assertGmailSyncUrl(url).toString()).toBe(url);
    for (const url of built.slice(1)) expect(() => assertGmailReadUrl(url), url).toThrow(GmailContractError);
  });

  it("refuses bodies, attachments, free queries, other history types, writes and other mailboxes", () => {
    for (const url of [
      `${base}/messages/abc?format=full`, `${base}/messages/abc?format=raw`, `${base}/messages/abc`,
      `${base}/messages/abc?format=metadata&metadataHeaders=Subject`,
      `${base}/messages/abc?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
      `${base}/messages/abc/attachments/def`, `${base}/messages?q=from:someone&maxResults=40`, `${base}/messages?q=after:1&maxResults=500`,
      `${base}/history?startHistoryId=1&historyTypes=labelAdded&maxResults=100`, `${base}/history?startHistoryId=x&historyTypes=messageAdded&maxResults=100`,
      `${base}/history?startHistoryId=1&historyTypes=messageAdded&maxResults=100&labelId=INBOX`,
      `${base}/threads?q=x&maxResults=20`, `${base}/messages/send`, `${base}/stop`, GMAIL_WATCH_URL, `${base}/labels`,
      "https://gmail.googleapis.com/gmail/v1/users/other@example.com/history?startHistoryId=1&historyTypes=messageAdded&maxResults=100",
      "https://gmail.googleapis.com:8443/gmail/v1/users/me/profile", "not a url",
    ]) refused(url);
    expect(() => gmailHistoryUrl({ startHistoryId: "-1" })).toThrow(GmailContractError);
    expect(() => gmailRecoveryListUrl({ afterEpochSeconds: Number.NaN })).toThrow(GmailContractError);
    expect(() => gmailMessageMetadataUrl("../x")).toThrow(GmailContractError);
  });

  it("compares history ids numerically beyond float precision", () => {
    expect(historyIdGreater("10000000000000000001", "10000000000000000000")).toBe(true);
    expect(historyIdGreater("9", "10")).toBe(false);
  });
});

describe("Gmail monitor criteria", () => {
  const criteria = (raw: unknown) => GmailMonitorCriteriaSchema.parse(raw);
  const msg = (from: string | null, subject: string | null, labelIds: string[] = ["INBOX"]) => ({ from, subject, labelIds });

  it("needs at least one bounded criterion and normalizes senders", () => {
    expect(GmailMonitorCriteriaSchema.safeParse({}).success).toBe(false);
    expect(GmailMonitorCriteriaSchema.safeParse({ from_any: ["not an address"] }).success).toBe(false);
    expect(GmailMonitorCriteriaSchema.safeParse({ subject_any: Array.from({ length: 11 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(criteria({ from_any: [" Admissions@Uni.Example "] }).from_any).toEqual(["admissions@uni.example"]);
    expect(headerAddresses(`"Dean, Office" <Dean@CS.Uni.Example>, x@y.example`)).toEqual(["dean@cs.uni.example", "x@y.example"]);
  });

  it("ANDs fields, ORs values, matches domains with subdomains and never matches drafts, sent, spam, trash or chat", () => {
    const c = criteria({ from_any: ["@uni.example", "boss@corp.example"], subject_any: ["Interview", "offer"] });
    expect(gmailMonitorMatches(c, msg("Admissions <a@uni.example>", "Your INTERVIEW slot"))).toBe(true);
    expect(gmailMonitorMatches(c, msg("a@cs.uni.example", "Job offer"))).toBe(true);
    expect(gmailMonitorMatches(c, msg("boss@corp.example", "offer letter"))).toBe(true);
    expect(gmailMonitorMatches(c, msg("a@notuni.example", "interview"))).toBe(false);
    expect(gmailMonitorMatches(c, msg("a@uni.example", "newsletter"))).toBe(false);
    expect(gmailMonitorMatches(c, msg(null, "interview"))).toBe(false);
    for (const label of ["DRAFT", "SENT", "SPAM", "TRASH", "CHAT"]) expect(gmailMonitorMatches(c, msg("a@uni.example", "interview", ["INBOX", label]))).toBe(false);
    const labels = criteria({ label_any: ["IMPORTANT"] });
    expect(gmailMonitorMatches(labels, msg("x@y.example", null, ["INBOX", "IMPORTANT"]))).toBe(true);
    expect(gmailMonitorMatches(labels, msg("x@y.example", null, ["INBOX"]))).toBe(false);
  });
});
