import { describe, expect, it } from "vitest";
import { claudeSubscriptionIdentity, codexRpcSubscriptionIdentity, claudeSubscriptionDisplay, codexSubscriptionDisplay } from "../src/subscriptionIdentity.js";

describe("subscription identity follows the vendor account and quota scope", () => {
  it("matches Claude copies without disclosing profile fields or merging organizations", () => {
    const profile = { account: { uuid: "person-a", email: "private@example.test" }, organization: { uuid: "org-a" } };
    const identity = claudeSubscriptionIdentity(profile);
    expect(identity).toEqual(claudeSubscriptionIdentity({ ...profile, token: "different-secret" }));
    expect(identity).not.toEqual(claudeSubscriptionIdentity({ ...profile, organization: { uuid: "org-b" } }));
    expect(JSON.stringify(identity)).not.toMatch(/person-a|private|org-a|secret/);
    expect(claudeSubscriptionIdentity({ account: profile.account })).toBeNull();
  });
  it("uses the Codex 0.166 experimental account/read shape without an invented userId", () => {
    const response = {
      account: { type: "chatgpt", email: "private@example.test", planType: "pro", workspaceName: "Personal" },
      requiresOpenaiAuth: true,
      workspaceRouting: { chatgptAccountId: "workspace-a", accountRoutingOverride: "NO_CONSTRAINT", backendOrigin: "https://chatgpt.com" },
    };
    const identity = codexRpcSubscriptionIdentity(response);
    expect(identity).toMatchObject({ provider: "openai", product: "codex", identity_kind: "email" });
    expect(identity?.account_id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toMatch(/private|workspace-a|chatgpt.com/);
    expect(codexRpcSubscriptionIdentity({ ...response, account: { ...response.account, email: "PRIVATE@example.test", planType: "plus", workspaceName: "Renamed" } })).toEqual(identity);
    expect(codexRpcSubscriptionIdentity({ ...response, workspaceRouting: { ...response.workspaceRouting, chatgptAccountId: "workspace-b" } })).not.toEqual(identity);
    expect(codexRpcSubscriptionIdentity({ ...response, account: { ...response.account, email: "other@example.test" } })).not.toEqual(identity);
    expect(codexRpcSubscriptionIdentity({ ...response, workspaceRouting: null })).toBeNull();
    for (const email of [null, "", "invalid", "a b@example.test", "a".repeat(255) + "@example.test"]) {
      expect(codexRpcSubscriptionIdentity({ ...response, account: { ...response.account, email } })).toBeNull();
    }
    expect(codexRpcSubscriptionIdentity({ ...response, account: { type: "apiKey", email: "private@example.test" } })).toBeNull();
    expect(codexRpcSubscriptionIdentity({ ...response, account: null })).toBeNull();
  });
});

it("whitelists readable login metadata independently of pool identity", () => {
  expect(claudeSubscriptionDisplay({ account: { email_address: "person@example.test", uuid: "private-id", token: "secret" }, organization: { name: "Team", uuid: "org" } }))
    .toEqual({ email: "person@example.test", workspace_name: "Team" });
  expect(codexSubscriptionDisplay({ account: { type: "chatgpt", email: "person@example.test", workspaceName: "Personal", accessToken: "secret" } }))
    .toEqual({ email: "person@example.test", workspace_name: "Personal" });
  expect(codexSubscriptionDisplay({ account: { type: "apiKey", email: "person@example.test" } })).toBeNull();
  expect(claudeSubscriptionDisplay({ account: { email: "bad\nvalue" } })).toBeNull();
});
