import { createHash } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

export const PRODUCTION_PASSWORD_MIN_LENGTH = 15;
export const DEVELOPMENT_PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const ARGON2ID_OPTIONS = Object.freeze({
  // @node-rs/argon2 declares Algorithm as a const enum and exports an empty
  // runtime object under ESM; keep the documented Argon2id value explicit.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

export class PasswordPolicyError extends Error {
  readonly code: "password_required" | "password_too_short" | "password_too_long";

  constructor(code: PasswordPolicyError["code"]) {
    super(code);
    this.name = "PasswordPolicyError";
    this.code = code;
  }
}

/** The only email normalization Rainver applies: trim and lowercase. */
export function normalizeAuthEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("email_required");
  return normalized;
}

/**
 * Development and test instances trade some password length for iteration
 * speed. Unknown or missing environment names fail closed to production.
 */
export function passwordMinimumLength(rainverEnv: string): number {
  return rainverEnv === "dev" || rainverEnv === "test"
    ? DEVELOPMENT_PASSWORD_MIN_LENGTH
    : PRODUCTION_PASSWORD_MIN_LENGTH;
}

/** Validate without composition rules; Unicode code points are the contract. */
export function assertPasswordPolicy(password: string, minimumLength = PRODUCTION_PASSWORD_MIN_LENGTH): void {
  if (password.length === 0) throw new PasswordPolicyError("password_required");
  const length = [...password].length;
  if (length < minimumLength) throw new PasswordPolicyError("password_too_short");
  if (length > PASSWORD_MAX_LENGTH) throw new PasswordPolicyError("password_too_long");
}

export async function hashPassword(password: string, minimumLength = PRODUCTION_PASSWORD_MIN_LENGTH): Promise<string> {
  assertPasswordPolicy(password, minimumLength);
  return argon2Hash(password, ARGON2ID_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash || !password) return false;
  return argon2Verify(hash, password);
}

/** Store only a digest for opaque cookies, invitations, and action tokens. */
export function hashOpaqueToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
