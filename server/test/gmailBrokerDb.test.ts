import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { publicAddressGuard } from "./support/outboundGuard.js";
import { createSourceRequestBroker, type SourceRequestGrant } from "../src/modules/sources/sourceRequestBroker.js";
import {
  createGmailSendBudget,
  gmailMessageFullUrl,
  gmailProfileUrl,
  gmailSourceRequestPolicy,
  type GmailSendBudget,
} from "../src/modules/sources/gmail/gmailReadContract.js";
import { gmailQuotaGroups } from "../src/modules/sources/gmail/gmailQuota.js";

// Real broker + real PostgreSQL quota; only the network is stubbed.
const db = useTestDatabase(import.meta.filename);
afterEach(() => { vi.restoreAllMocks(); });

const TOKEN = "Bearer gmail-fixture-access-token";
const MESSAGE = gmailMessageFullUrl("18c2f0a1b2c3d4e6");
const ATTACHMENT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f0a1b2c3d4e6/attachments/abc";
const RAW = "https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f0a1b2c3d4e6?format=raw";

function grant(budget: GmailSendBudget, opts: { subject?: string; owner?: string; override?: Partial<SourceRequestGrant> } = {}): SourceRequestGrant {
  const keys = gmailQuotaGroups({ googleSubject: opts.subject ?? `1${Date.now()}${Math.floor(Math.random() * 1e6)}`, ownerUserId: opts.owner ?? randomUUID() });
  return {
    // A new connection/credential each call: scopeId and credential differ, quota keys must not.
    scopeId: `gmail:${randomUUID()}`,
    quotaGroup: keys.account,
    quota: [{ window: "minute", limit: 60 }, { window: "day", limit: 2000 }],
    endpointQuotas: [{ key: keys.owner, windows: [{ window: "minute", limit: 120 }] }],
    authorize: async () => {},
    ...gmailSourceRequestPolicy({ credentialHeaders: async () => ({ authorization: TOKEN }), budget }),
    ...opts.override,
  };
}
const call = (url: string, sequence = 1) => ({ url, sequence, method: "GET" });
function stubFetch(handler: (url: string) => Response) {
  const seen: { url: string; auth: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    seen.push({ url: String(url), auth: (init?.headers as Record<string, string>).authorization });
    return handler(String(url));
  });
  return seen;
}

it("refuses a same-origin redirect to attachments or format=raw without a second send", async () => {
  for (const target of [ATTACHMENT, RAW]) {
    const seen = stubFetch((url) => url === MESSAGE ? new Response(null, { status: 302, headers: { location: target } }) : new Response("mail"));
    const budget = createGmailSendBudget();
    await expect(createSourceRequestBroker(db.pool, grant(budget), new AbortController().signal, publicAddressGuard)(call(MESSAGE)))
      .rejects.toMatchObject({ code: "source_network_failed" });
    expect(seen).toEqual([{ url: MESSAGE, auth: TOKEN }]);
    expect(budget.remaining).toBe(20);
    vi.restoreAllMocks();
  }
});

it("applies the exact allowlist to every redirect hop before credentials, even if redirects were allowed", async () => {
  for (const target of [ATTACHMENT, RAW]) {
    const seen = stubFetch((url) => url === MESSAGE ? new Response(null, { status: 302, headers: { location: target } }) : new Response("mail"));
    const budget = createGmailSendBudget();
    await expect(createSourceRequestBroker(db.pool, grant(budget, { override: { maxRedirects: 5 } }), new AbortController().signal, publicAddressGuard)(call(MESSAGE)))
      .rejects.toMatchObject({ code: "source_scope_refused" });
    expect(seen).toEqual([{ url: MESSAGE, auth: TOKEN }]);
    vi.restoreAllMocks();
  }
  // The broker's prefix route alone would have admitted it.
  const budget = createGmailSendBudget();
  stubFetch(() => new Response("x"));
  await expect(createSourceRequestBroker(db.pool, grant(budget), new AbortController().signal, publicAddressGuard)(call(ATTACHMENT)))
    .rejects.toMatchObject({ code: "source_scope_refused" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("debits the page budget per physical send, redirect hops included", async () => {
  const seen = stubFetch((url) => url === gmailProfileUrl() ? new Response(null, { status: 302, headers: { location: MESSAGE } }) : new Response("mail"));
  const budget = createGmailSendBudget(1);
  await expect(createSourceRequestBroker(db.pool, grant(budget, { override: { maxRedirects: 1 } }), new AbortController().signal, publicAddressGuard)(call(gmailProfileUrl())))
    .rejects.toMatchObject({ code: "source_budget_exhausted" });
  expect(seen.map((s) => s.url)).toEqual([gmailProfileUrl()]);
  vi.restoreAllMocks();

  const sent = stubFetch(() => new Response("{}"));
  const page = createGmailSendBudget();
  const broker = createSourceRequestBroker(db.pool, grant(page), new AbortController().signal, publicAddressGuard);
  for (let i = 1; i <= 21; i += 1) await broker(call(gmailProfileUrl(), i));
  await expect(broker(call(gmailProfileUrl(), 22))).rejects.toMatchObject({ code: "source_budget_exhausted" });
  expect(sent).toHaveLength(21);
});

// Broker-level only: a new scopeId and credential callback stand in for a new connection. The real
// forget/reconnect lifecycle proof is in gmailConnectionDb.test.ts.
it("keeps a Google cooldown across new broker scopes and credential callbacks for the same subject", async () => {
  const subject = `1${Date.now()}`, owner = randomUUID();
  stubFetch(() => new Response("busy", { status: 429, headers: { "retry-after": "120" } }));
  await createSourceRequestBroker(db.pool, grant(createGmailSendBudget(), { subject, owner }), new AbortController().signal, publicAddressGuard)(call(gmailProfileUrl()));
  vi.restoreAllMocks();
  const seen = stubFetch(() => new Response("{}"));
  // Reconnected: new scopeId and credential, same Google subject.
  await expect(createSourceRequestBroker(db.pool, grant(createGmailSendBudget(), { subject, owner }), new AbortController().signal, publicAddressGuard)(call(gmailProfileUrl())))
    .rejects.toMatchObject({ code: "source_quota_exhausted", retryAt: expect.any(String) });
  expect(seen).toHaveLength(0);
  // The same subject reached by another owner/Space shares Google's per-account cooldown.
  await expect(createSourceRequestBroker(db.pool, grant(createGmailSendBudget(), { subject }), new AbortController().signal, publicAddressGuard)(call(gmailProfileUrl())))
    .rejects.toMatchObject({ code: "source_quota_exhausted" });
  // A different Google account of a different owner is not cooled.
  await createSourceRequestBroker(db.pool, grant(createGmailSendBudget(), { subject: `2${Date.now()}` }), new AbortController().signal, publicAddressGuard)(call(gmailProfileUrl()));
  expect(seen).toHaveLength(1);
});

it("derives opaque quota keys only from the Google subject and owner", () => {
  const a = gmailQuotaGroups({ googleSubject: "109876543210987654321", ownerUserId: "owner-1" });
  expect(gmailQuotaGroups({ googleSubject: "109876543210987654321", ownerUserId: "owner-1" })).toEqual(a);
  expect(gmailQuotaGroups({ googleSubject: "109876543210987654321", ownerUserId: "owner-2" }).account).toBe(a.account);
  expect(gmailQuotaGroups({ googleSubject: "209876543210987654321", ownerUserId: "owner-1" }).account).not.toBe(a.account);
  expect(a.account).toMatch(/^[a-f0-9]{64}$/);
  expect(a.account).not.toContain("109876543210987654321");
  for (const bad of ["", "a b", "x".repeat(256), "a\nb"]) expect(() => gmailQuotaGroups({ googleSubject: bad, ownerUserId: "o" })).toThrow();
});
