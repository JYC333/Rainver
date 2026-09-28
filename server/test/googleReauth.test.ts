import { describe, expect, it } from "vitest";
import { consumeGoogleReauth, issueGoogleReauth, markGoogleReauthVerified } from "../src/modules/auth/googleReauth.js";

describe("Google reauthentication nonce", () => {
  it("binds each one-time nonce to the user who initiated it", () => {
    const nonce = issueGoogleReauth("user-1", "session-1");
    markGoogleReauthVerified(nonce, "oauth-session-hash");
    expect(consumeGoogleReauth(nonce)).toMatchObject({ userId: "user-1", previousSessionId: "session-1", verifiedSessionTokenHash: "oauth-session-hash" });
    expect(consumeGoogleReauth(nonce)).toBeNull();
  });
});
