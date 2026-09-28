import { describe, expect, it } from "vitest";
import { createConfigSnapshot, loadConfig } from "../src/config.js";
import { createServerApp, registerGatewayConventions, registerUnknownApiRoute } from "../src/gateway/appShell.js";
import type { AuthRuntime } from "../src/modules/auth/identity.js";
import { registerRoutes } from "../src/modules/auth/routes.js";
import { consumeGoogleReauth, issueGoogleReauth } from "../src/modules/auth/googleReauth.js";
import { hashOpaqueToken } from "../src/modules/auth/securityPolicy.js";

describe("Google reauthentication callback", () => {
  it("recognizes only a successful OAuth callback that issues the replacement session", async () => {
    const config = loadConfig({ FRONTEND_URL: "https://rainver.example.test" });
    const app = createServerApp(config, { logger: false });
    registerGatewayConventions(app, config);
    let callbackResponse = new Response(null, { status: 302 });
    const runtime = {
      auth: {
        options: { baseURL: config.frontendUrl, basePath: "/api/v1/auth" },
        handler: async () => callbackResponse,
      },
    } as unknown as AuthRuntime;
    registerRoutes(app, { config, snapshot: createConfigSnapshot(config), authRuntime: runtime });
    registerUnknownApiRoute(app);
    const callbackUrl = "/api/v1/auth/callback/google?state=valid&code=valid";
    const reauthUrl = `${config.frontendUrl}/settings/security?google_reauth=1`;
    const sessionCookie = "__Secure-better-auth.session_token=new-token.signature; Path=/; Secure; HttpOnly";
    try {
      const noSession = issueGoogleReauth("user-1", "old-session-1");
      callbackResponse = new Response(null, { status: 302, headers: { location: reauthUrl } });
      await app.inject({ method: "GET", url: callbackUrl, headers: { cookie: `rainver.google_reauth=${noSession}` } });
      expect(consumeGoogleReauth(noSession)?.verifiedSessionTokenHash).toBeNull();

      const errorRedirect = issueGoogleReauth("user-1", "old-session-2");
      callbackResponse = new Response(null, { status: 302, headers: { location: `${config.frontendUrl}/login?error=google_failed`, "set-cookie": sessionCookie } });
      await app.inject({ method: "GET", url: callbackUrl, headers: { cookie: `rainver.google_reauth=${errorRedirect}` } });
      expect(consumeGoogleReauth(errorRedirect)?.verifiedSessionTokenHash).toBeNull();

      const success = issueGoogleReauth("user-1", "old-session-3");
      callbackResponse = new Response(null, { status: 302, headers: { location: reauthUrl, "set-cookie": sessionCookie } });
      const result = await app.inject({ method: "GET", url: callbackUrl, headers: { cookie: `rainver.google_reauth=${success}` } });
      expect(result.statusCode).toBe(302);
      expect(consumeGoogleReauth(success)?.verifiedSessionTokenHash).toBe(hashOpaqueToken("new-token"));
    } finally {
      await app.close();
    }
  });
});
