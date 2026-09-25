import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { ServerConfig } from "../../config.js";
import type { Pool } from "../../db/pool.js";
import { rainverPgAdapter } from "../../db/betterAuthPgAdapter.js";
import { PASSWORD_MAX_LENGTH, hashPassword, passwordMinimumLength, verifyPassword } from "./securityPolicy.js";
import { storeManualResetLink } from "./recovery.js";

function authBaseUrl(config: ServerConfig): string {
  return config.frontendUrl.replace(/\/$/, "");
}

export function googleAuthConfigured(config: ServerConfig): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

function scrubAccount(account: Record<string, unknown>): Record<string, unknown> {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

/**
 * Build one Better Auth instance for the server composition root. The caller
 * owns its lifetime; this function intentionally has no process-global cache
 * so a new instance always reflects the complete validated configuration and
 * the supplied pool identity.
 */
export function createBetterAuth(config: ServerConfig, pool: Pool) {
  if (!config.betterAuthSecret) throw new Error("BETTER_AUTH_SECRET is required for Better Auth");
  const minimumPasswordLength = passwordMinimumLength(config.rainverEnv);
  const options: BetterAuthOptions = {
    appName: "Rainver",
    baseURL: authBaseUrl(config),
    basePath: "/api/v1/auth",
    secret: config.betterAuthSecret,
    database: rainverPgAdapter(pool),
    user: {
      modelName: "user",
      fields: {
        name: "display_name", emailVerified: "email_verified", image: "avatar_url",
        createdAt: "created_at", updatedAt: "updated_at",
      },
      additionalFields: {
        status: { type: "string", fieldName: "status", required: false, defaultValue: "pending", input: false },
        registrationSource: { type: "string", fieldName: "registration_source", required: false, defaultValue: "system", input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: minimumPasswordLength,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      password: {
        hash: (password) => hashPassword(password, minimumPasswordLength),
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => { storeManualResetLink(user.email, url); },
    },
    socialProviders: googleAuthConfigured(config)
      ? {
          google: {
            clientId: config.googleClientId,
            clientSecret: config.googleClientSecret,
            disableImplicitSignUp: true,
            overrideUserInfoOnSignIn: false,
          },
        }
      : undefined,
    account: {
      modelName: "auth_account",
      fields: {
        accountId: "account_id", providerId: "provider_id", userId: "user_id",
        accessToken: "access_token", refreshToken: "refresh_token", idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at", refreshTokenExpiresAt: "refresh_token_expires_at",
        scope: "scope", password: "password", createdAt: "created_at", updatedAt: "updated_at",
      },
      updateAccountOnSignIn: false,
      accountLinking: { disableImplicitLinking: true },
    },
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: scrubAccount(account) }) },
        update: { before: async (account) => ({ data: scrubAccount(account) }) },
      },
      session: {
        create: { after: async (session) => {
          await pool.query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [session.userId]);
        } },
      },
    },
    session: {
      modelName: "user_session",
      fields: {
        userId: "user_id", token: "token_hash", expiresAt: "expires_at", createdAt: "created_at",
        updatedAt: "updated_at", ipAddress: "ip_address", userAgent: "user_agent",
      },
      expiresIn: config.sessionExpireDays * 86_400,
      updateAge: 86_400,
    },
    verification: {
      modelName: "auth_verification",
      fields: { identifier: "identifier", value: "value", expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
      storeIdentifier: "hashed",
    },
    trustedOrigins: [config.frontendUrl],
    rateLimit: { enabled: true, window: 60, max: 20 },
  };
  return betterAuth(options);
}
