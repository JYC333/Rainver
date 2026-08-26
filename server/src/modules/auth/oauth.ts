import { randomBytes, timingSafeEqual } from "node:crypto";
import { request as undiciRequest } from "undici";
import type { ServerConfig } from "../../config.js";

export const OAUTH_STATE_COOKIE = "oauth_state";
export const POST_LOGIN_NEXT_COOKIE = "post_login_next";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export interface GoogleTokens {
  access_token: string;
}

export interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export interface GoogleOAuthClient {
  exchangeCode(config: ServerConfig, code: string): Promise<GoogleTokens>;
  getUserInfo(accessToken: string): Promise<GoogleUserInfo>;
}

let clientOverride: GoogleOAuthClient | null = null;

export function __setGoogleOAuthClientForTests(client: GoogleOAuthClient | null): void {
  clientOverride = client;
}

export function googleOAuthClient(): GoogleOAuthClient {
  return clientOverride ?? defaultGoogleOAuthClient;
}

export function googleConfigured(config: ServerConfig): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

export function randomOAuthState(): string {
  return randomBytes(16).toString("hex");
}

export function buildGoogleAuthUrl(config: ServerConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export function safeNextUrl(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "";
  return raw;
}

export function loginErrorUrl(config: ServerConfig, reason: string): string {
  return `${config.frontendUrl}/login?error=${encodeURIComponent(reason)}`;
}

export function sameState(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(response: Awaited<ReturnType<typeof undiciRequest>>): Promise<unknown> {
  const text = await response.body.text();
  return text ? JSON.parse(text) : {};
}

const defaultGoogleOAuthClient: GoogleOAuthClient = {
  async exchangeCode(config, code) {
    const response = await undiciRequest(GOOGLE_TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: config.googleRedirectUri,
        grant_type: "authorization_code",
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      bodyTimeout: 10_000,
      headersTimeout: 10_000,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`google token exchange failed with ${response.statusCode}`);
    }
    const body = (await readJson(response)) as Record<string, unknown>;
    if (typeof body.access_token !== "string") {
      throw new Error("google token response missing access_token");
    }
    return { access_token: body.access_token };
  },

  async getUserInfo(accessToken) {
    const response = await undiciRequest(GOOGLE_USERINFO_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      bodyTimeout: 10_000,
      headersTimeout: 10_000,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`google userinfo failed with ${response.statusCode}`);
    }
    return (await readJson(response)) as GoogleUserInfo;
  },
};
