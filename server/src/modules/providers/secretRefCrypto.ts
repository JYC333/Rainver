/**
 * Compatibility helpers for the model-provider API-key secret_ref format.
 *
 * Keeps the at-rest representation stable so credential rows do not need a
 * rewrite when credential-store internals change.
 */

import { createDecipheriv } from "node:crypto";
import { randomBytes, createCipheriv } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX = "model_provider_api_key:v1:" as const;
export const MODEL_PROVIDER_OAUTH_SECRET_REF_V1_PREFIX = "model_provider_oauth:v1:" as const;
export const MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES = 32;
export const MODEL_PROVIDER_API_KEY_NONCE_BYTES = 12;
export const MODEL_PROVIDER_API_KEY_AUTH_TAG_BYTES = 16;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export class SecretRefCompatibilityError extends Error {
  constructor(
    readonly code:
      | "malformed_secret_ref"
      | "invalid_base64"
      | "invalid_master_key"
      | "invalid_nonce"
      | "invalid_ciphertext"
      | "invalid_key_path"
      | "decryption_failed",
  ) {
    super(`model-provider secret_ref compatibility check failed: ${code}`);
    this.name = "SecretRefCompatibilityError";
  }
}

export type ParsedModelProviderSecretRefV1 = {
  encryptedKeyWithTag: Buffer;
  nonce: Buffer;
};

export function parseModelProviderApiKeySecretRefV1(
  secretRef: string,
): ParsedModelProviderSecretRefV1 {
  if (!secretRef.startsWith(MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX)) {
    throw new SecretRefCompatibilityError("malformed_secret_ref");
  }

  const payload = secretRef.slice(MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX.length);
  const [encryptedKeyB64, nonceB64, ...extra] = payload.split(":");
  if (!encryptedKeyB64 || !nonceB64 || extra.length > 0) {
    throw new SecretRefCompatibilityError("malformed_secret_ref");
  }
  if (!BASE64_RE.test(encryptedKeyB64) || !BASE64_RE.test(nonceB64)) {
    throw new SecretRefCompatibilityError("invalid_base64");
  }

  const encryptedKeyWithTag = Buffer.from(encryptedKeyB64, "base64");
  const nonce = Buffer.from(nonceB64, "base64");
  if (nonce.length !== MODEL_PROVIDER_API_KEY_NONCE_BYTES) {
    throw new SecretRefCompatibilityError("invalid_nonce");
  }
  if (encryptedKeyWithTag.length <= MODEL_PROVIDER_API_KEY_AUTH_TAG_BYTES) {
    throw new SecretRefCompatibilityError("invalid_ciphertext");
  }

  return { encryptedKeyWithTag, nonce };
}

export function decryptModelProviderApiKeySecretRefV1(
  secretRef: string,
  masterKey: Buffer,
): string {
  if (masterKey.length !== MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES) {
    throw new SecretRefCompatibilityError("invalid_master_key");
  }

  const { encryptedKeyWithTag, nonce } = parseModelProviderApiKeySecretRefV1(secretRef);
  const authTag = encryptedKeyWithTag.subarray(
    encryptedKeyWithTag.length - MODEL_PROVIDER_API_KEY_AUTH_TAG_BYTES,
  );
  const ciphertext = encryptedKeyWithTag.subarray(
    0,
    encryptedKeyWithTag.length - MODEL_PROVIDER_API_KEY_AUTH_TAG_BYTES,
  );

  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      .toString("utf8")
      .trim();
    if (!plaintext) {
      throw new SecretRefCompatibilityError("decryption_failed");
    }
    return plaintext;
  } catch (error) {
    if (error instanceof SecretRefCompatibilityError) throw error;
    throw new SecretRefCompatibilityError("decryption_failed");
  }
}

export async function loadOrCreateModelProviderApiKeyMasterKey(
  agentSpaceHome: string,
): Promise<Buffer> {
  if (!agentSpaceHome || !agentSpaceHome.startsWith("/")) {
    throw new SecretRefCompatibilityError("invalid_key_path");
  }
  const keyPath = join(agentSpaceHome, "secrets", "provider_keys.key");
  try {
    const key = await readFile(keyPath);
    if (key.length !== MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES) {
      throw new SecretRefCompatibilityError("invalid_master_key");
    }
    return key;
  } catch (error) {
    if (error instanceof SecretRefCompatibilityError) throw error;
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") throw error;
  }

  const key = randomBytes(MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES);
  await mkdir(join(agentSpaceHome, "secrets"), { recursive: true });
  await writeFile(keyPath, key, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return key;
}

export function encryptModelProviderApiKeySecretRefV1(
  plaintext: string,
  masterKey: Buffer,
  nonce: Buffer = randomBytes(MODEL_PROVIDER_API_KEY_NONCE_BYTES),
): string {
  if (masterKey.length !== MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES) {
    throw new SecretRefCompatibilityError("invalid_master_key");
  }
  if (nonce.length !== MODEL_PROVIDER_API_KEY_NONCE_BYTES) {
    throw new SecretRefCompatibilityError("invalid_nonce");
  }
  const value = plaintext.trim();
  if (!value) {
    throw new SecretRefCompatibilityError("decryption_failed");
  }
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const encryptedKeyWithTag = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX}${encryptedKeyWithTag.toString("base64")}:${nonce.toString("base64")}`;
}

export interface ModelProviderOAuthSecretV1 {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export function encryptModelProviderOAuthSecretRefV1(
  credential: ModelProviderOAuthSecretV1,
  masterKey: Buffer,
  nonce: Buffer = randomBytes(MODEL_PROVIDER_API_KEY_NONCE_BYTES),
): string {
  const encoded = encryptModelProviderApiKeySecretRefV1(
    JSON.stringify(credential),
    masterKey,
    nonce,
  );
  return `${MODEL_PROVIDER_OAUTH_SECRET_REF_V1_PREFIX}${encoded.slice(MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX.length)}`;
}

export function decryptModelProviderOAuthSecretRefV1(
  secretRef: string,
  masterKey: Buffer,
): ModelProviderOAuthSecretV1 {
  if (!secretRef.startsWith(MODEL_PROVIDER_OAUTH_SECRET_REF_V1_PREFIX)) {
    throw new SecretRefCompatibilityError("malformed_secret_ref");
  }
  const apiKeyRef = `${MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX}${secretRef.slice(MODEL_PROVIDER_OAUTH_SECRET_REF_V1_PREFIX.length)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptModelProviderApiKeySecretRefV1(apiKeyRef, masterKey));
  } catch (error) {
    if (error instanceof SecretRefCompatibilityError) throw error;
    throw new SecretRefCompatibilityError("decryption_failed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretRefCompatibilityError("decryption_failed");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.type !== "oauth"
    || typeof value.refresh !== "string" || !value.refresh
    || typeof value.access !== "string" || !value.access
    || typeof value.expires !== "number" || !Number.isFinite(value.expires)
  ) {
    throw new SecretRefCompatibilityError("decryption_failed");
  }
  return parsed as ModelProviderOAuthSecretV1;
}
