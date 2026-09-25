import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";
import Fastify from "fastify";
import {
  hashPassword,
  hashOpaqueToken,
  verifyPassword,
} from "../src/modules/auth/securityPolicy.js";

const BASE_URL = "http://localhost:8010";
const BASE_PATH = "/internal-auth";

function jsonRequest(path: string, body: Record<string, unknown>, headers?: Record<string, string>): Request {
  return new Request(`${BASE_URL}${BASE_PATH}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function getRequest(path: string, headers?: Record<string, string>): Request {
  return new Request(`${BASE_URL}${BASE_PATH}${path}`, { headers });
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const value = setCookie!.split(";")[0];
  expect(value).toMatch(/^better-auth\.session_token=/);
  return value;
}

function testAuth() {
  const memoryDb = { users: [], user_sessions: [], auth_accounts: [], auth_verifications: [] };
  const baseMemoryAdapter = memoryAdapter(memoryDb);
  const hashingMemoryAdapter = (options: Parameters<typeof betterAuth>[0]) => {
    const logicalTokens = new Map<string, string>();
    const wrap = (adapter: any): any => {
      const source = adapter;
      const hashSessionToken = (token: string): string => hashOpaqueToken(token);
      const restoreSessionToken = (row: any, fallback?: string): any => {
        if (!row || typeof row !== "object") return row;
        const storedToken = typeof row.token === "string" ? row.token
          : typeof row.token_hash === "string" ? row.token_hash : undefined;
        const logicalToken = storedToken ? logicalTokens.get(storedToken) : undefined;
        return logicalToken || fallback ? { ...row, token: logicalToken ?? fallback } : row;
      };
      const hashWhere = <T extends { field: string; value: unknown }>(where: T[]): T[] =>
        where.map((clause) => {
          if (!["token", "token_hash"].includes(clause.field)) return clause;
          if (typeof clause.value === "string") return { ...clause, value: hashSessionToken(clause.value) };
          if (Array.isArray(clause.value)) {
            return { ...clause, value: clause.value.map((value) => typeof value === "string" ? hashSessionToken(value) : value) };
          }
          return clause;
        });
      return {
        ...adapter,
        create: async (input: any) => {
          const field = typeof input.data.token === "string" ? "token" : "token_hash";
          if (typeof input.data[field] !== "string") return source.create(input);
          const logicalToken = input.data[field] as string;
          const storedToken = hashSessionToken(logicalToken);
          logicalTokens.set(storedToken, logicalToken);
          const result = await source.create({
            ...input,
            data: { ...input.data, [field]: storedToken },
          });
          return { ...result, [field]: logicalToken };
        },
        findOne: async (input: any) => {
          const logicalToken = input.where.find((clause: any) => clause.field === "token" && typeof clause.value === "string")?.value;
          const result = await source.findOne({ ...input, where: hashWhere(input.where) });
          return input.model === "session" ? restoreSessionToken(result, logicalToken) : result;
        },
        findMany: async (input: any) => {
          const result = await source.findMany({ ...input, where: hashWhere(input.where ?? []) });
          return input.model === "session" ? result.map((row: any) => restoreSessionToken(row)) : result;
        },
        update: async (input: any) => {
          const logicalToken = input.where.find((clause: any) => clause.field === "token" && typeof clause.value === "string")?.value;
          const update = { ...input.update };
          for (const field of ["token", "token_hash"]) {
            if (typeof update[field] === "string") {
              const logicalToken = update[field];
              const storedToken = hashSessionToken(logicalToken);
              logicalTokens.set(storedToken, logicalToken);
              update[field] = storedToken;
            }
          }
          const result = await source.update({ ...input, where: hashWhere(input.where), update });
          return input.model === "session" ? restoreSessionToken(result, logicalToken) : result;
        },
        delete: async (input: any) =>
          source.delete({ ...input, where: hashWhere(input.where) }),
        deleteMany: async (input: any) =>
          source.deleteMany({ ...input, where: hashWhere(input.where) }),
        transaction: async (callback: any) =>
          source.transaction!(async (transactionAdapter: any) => callback(wrap(transactionAdapter))),
      };
    };
    return wrap(baseMemoryAdapter(options));
  };
  const scrubProviderTokens = async (account: Record<string, unknown>) => ({
    data: {
      ...account,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    },
  });

  const auth = betterAuth({
    appName: "Rainver",
    baseURL: BASE_URL,
    basePath: BASE_PATH,
    secret: "phase-one-auth-secret-that-is-long-enough",
    database: hashingMemoryAdapter,
    user: {
      modelName: "users",
      fields: {
        name: "display_name",
        emailVerified: "email_verified",
        image: "avatar_url",
        status: "status",
        registrationSource: "registration_source",
      },
      additionalFields: {
        status: { type: "string", fieldName: "status", required: false, defaultValue: "pending", input: false },
        registrationSource: { type: "string", fieldName: "registration_source", required: false, defaultValue: "system", input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 15,
      maxPasswordLength: 128,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    account: {
      modelName: "auth_accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      updateAccountOnSignIn: false,
      accountLinking: { disableImplicitLinking: true },
    },
    databaseHooks: {
      account: {
        create: { before: scrubProviderTokens },
        update: { before: scrubProviderTokens },
      },
    },
    session: {
      modelName: "user_sessions",
      fields: {
        userId: "user_id",
        token: "token_hash",
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
      },
      expiresIn: 30 * 86_400,
      updateAge: 86_400,
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        identifier: "identifier",
        value: "value",
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    trustedOrigins: [BASE_URL],
    rateLimit: { enabled: false },
  });
  return { auth, memoryDb };
}

describe("Better Auth integration proof", () => {
  it("mounts the private Better Auth handler on an explicit Fastify route", async () => {
    const { auth } = testAuth();
    const app = Fastify();
    app.post("/internal-auth/sign-up/email", async (request, reply) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const response = await auth.handler(new Request(`${BASE_URL}${request.url}`, {
        method: request.method,
        headers,
        body: JSON.stringify(request.body),
      }));
      response.headers.forEach((value, name) => reply.header(name, value));
      return reply.code(response.status).send(await response.text());
    });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/internal-auth/sign-up/email",
      payload: { email: "fastify@example.test", password: "a valid password with spaces", name: "Fastify" },
    });
    expect(response.statusCode).toBe(200);
    expect(app.printRoutes()).not.toContain("*");
    await app.close();
  });

  it("uses the configured password policy, mapped fields, and explicit base path", async () => {
    const { auth, memoryDb } = testAuth();
    const password = "a valid password with spaces";
    const signUp = await auth.handler(jsonRequest("/sign-up/email", {
      email: "  owner@example.test ".trim(),
      password,
      name: "Owner",
    }));
    expect(signUp.status).toBe(200);
    const signUpBody = await signUp.json() as { user: { email: string; name: string }; token: string };
    expect(signUpBody.user).toMatchObject({ email: "owner@example.test", name: "Owner" });
    expect(memoryDb.users[0]).toMatchObject({ status: "pending", registration_source: "system" });
    expect(signUpBody.token).toBeTruthy();
    const cookie = cookieFrom(signUp);

    const session = await auth.handler(new Request(`${BASE_URL}${BASE_PATH}/get-session`, {
      headers: { cookie },
    }));
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      user: { email: "owner@example.test", name: "Owner" },
    });

    const signIn = await auth.handler(jsonRequest("/sign-in/email", {
      email: "owner@example.test",
      password,
      rememberMe: true,
    }));
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("set-cookie")).toMatch(/Max-Age=/);
    const rememberCookie = cookieFrom(signIn);
    const storedSession = memoryDb.user_sessions.at(-1) as { token_hash?: string } | undefined;
    expect(storedSession?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedSession?.token_hash).not.toContain(rememberCookie.split("=", 2)[1]);

    const browserSession = await auth.handler(jsonRequest("/sign-in/email", {
      email: "owner@example.test",
      password,
      rememberMe: false,
    }));
    expect(browserSession.status).toBe(200);
    expect(browserSession.headers.get("set-cookie")).not.toMatch(/Max-Age=/);

    const sessions = await auth.handler(getRequest("/list-sessions", { cookie: rememberCookie }));
    expect(sessions.status).toBe(200);
    const sessionRows = await sessions.json() as Array<{ id: string }>;
    expect(sessionRows.length).toBeGreaterThanOrEqual(2);

    const revokeOthers = await auth.handler(new Request(`${BASE_URL}${BASE_PATH}/revoke-other-sessions`, {
      method: "POST",
      headers: { cookie: rememberCookie },
    }));
    expect(revokeOthers.status).toBe(200);
    const remaining = await auth.handler(getRequest("/list-sessions", { cookie: rememberCookie }));
    expect(remaining.status).toBe(200);
    await expect(remaining.json()).resolves.toHaveLength(1);
  });

  it("keeps implicit account linking disabled in the resolved auth options", () => {
    const { auth } = testAuth();
    expect(auth.options.user?.modelName).toBe("users");
    expect(auth.options.user?.fields).toMatchObject({
      name: "display_name",
      emailVerified: "email_verified",
      image: "avatar_url",
      status: "status",
      registrationSource: "registration_source",
    });
    expect(auth.options.account?.modelName).toBe("auth_accounts");
    expect(auth.options.account?.fields).toMatchObject({ accountId: "account_id", providerId: "provider_id" });
    expect(auth.options.session?.modelName).toBe("user_sessions");
    expect(auth.options.session?.fields).toMatchObject({ token: "token_hash", userId: "user_id" });
    expect(auth.options.verification?.modelName).toBe("auth_verifications");
    expect(auth.options.account?.accountLinking?.disableImplicitLinking).toBe(true);
    expect(auth.options.account?.updateAccountOnSignIn).toBe(false);
    expect(auth.options.basePath).toBe(BASE_PATH);
  });

  it("supports scrubbing provider tokens in the account persistence hooks", async () => {
    const { auth } = testAuth();
    const hook = auth.options.databaseHooks?.account?.create?.before;
    expect(hook).toBeTypeOf("function");
    const result = await hook?.({
      id: "account-1",
      accountId: "google-sub-1",
      providerId: "google",
      userId: "user-1",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "id-secret",
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      scope: "openid",
      password: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result).toMatchObject({ data: {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    } });
  });
});
