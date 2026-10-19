import { describe, expect, it } from "vitest";
import { consumeGoogleReauth, issueGoogleReauth, markGoogleReauthVerified } from "../src/modules/auth/googleReauth.js";

describe("Google reauthentication nonce", () => {
  it("binds each one-time nonce to the user who initiated it", () => {
    const nonce = issueGoogleReauth("user-1", "session-1");
    markGoogleReauthVerified(nonce, "oauth-session-hash");
    expect(consumeGoogleReauth(nonce)).toMatchObject({ userId: "user-1", previousSessionId: "session-1", verifiedSessionTokenHash: "oauth-session-hash" });
    expect(consumeGoogleReauth(nonce)).toBeNull();
  });

  it("bounds the pending nonces, dropping the oldest, so a flood cannot grow the table for ten minutes", () => {
    const oldest = issueGoogleReauth("user-flood", "session-flood");
    for (let index = 0; index < 2048; index += 1) issueGoogleReauth(`user-${index}`, `session-${index}`);
    expect(consumeGoogleReauth(oldest)).toBeNull();
    const latest = issueGoogleReauth("user-last", "session-last");
    expect(consumeGoogleReauth(latest)).toMatchObject({ userId: "user-last" });
  });
});
