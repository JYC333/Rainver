import { describe, expect, it } from "vitest";
import { consumeGoogleReauth, issueGoogleReauth } from "../src/modules/auth/googleReauth.js";

describe("Google reauthentication nonce", () => {
  it("binds each one-time nonce to the user who initiated it", () => {
    const nonce = issueGoogleReauth("user-1");
    expect(consumeGoogleReauth(nonce)).toMatchObject({ userId: "user-1" });
    expect(consumeGoogleReauth(nonce)).toBeNull();
  });
});
