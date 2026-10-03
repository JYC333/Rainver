/**
 * At-rest encryption for Custom Source fetch credentials — a third credential
 * class alongside ModelProvider API keys and CLI login state (see
 * `.agent/architecture/CREDENTIAL_STORAGE.md`). Stored in the same generic
 * `credentials` table (`credential_type = 'custom_source_fetch_credential'`)
 * and protected by the same instance master key
 * (`loadOrCreateModelProviderApiKeyMasterKey`) as ModelProvider API keys,
 * since both live in that one table and the master key already protects it
 * as a whole.
 *
 * Deliberately not layered on top of `secretRefCrypto.ts`'s ModelProvider
 * functions — that module is explicitly a compatibility-pinned format for
 * one existing credential class (see its own header comment); duplicating
 * ~15 lines of AES-256-GCM here with a distinct `secret_ref` prefix keeps
 * each credential class's at-rest format independently readable and
 * independently versionable, rather than introducing a shared abstraction
 * two call sites don't yet need.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const CUSTOM_SOURCE_FETCH_CREDENTIAL_SECRET_REF_V1_PREFIX = "custom_source_fetch_credential:v1:" as const;
const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

class CustomSourceCredentialCryptoError extends Error {
  constructor(
    readonly code: "malformed_secret_ref" | "invalid_base64" | "invalid_master_key" | "invalid_nonce" | "invalid_ciphertext" | "decryption_failed",
  ) {
    super(`custom source fetch credential secret_ref error: ${code}`);
    this.name = "CustomSourceCredentialCryptoError";
  }
}

export function encryptCustomSourceFetchCredential(plaintext: string, masterKey: Buffer): string {
  if (masterKey.length !== MASTER_KEY_BYTES) throw new CustomSourceCredentialCryptoError("invalid_master_key");
  const value = plaintext.trim();
  if (!value) throw new CustomSourceCredentialCryptoError("decryption_failed");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const encryptedWithTag = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${CUSTOM_SOURCE_FETCH_CREDENTIAL_SECRET_REF_V1_PREFIX}${encryptedWithTag.toString("base64")}:${nonce.toString("base64")}`;
}

export function decryptCustomSourceFetchCredential(secretRef: string, masterKey: Buffer): string {
  if (masterKey.length !== MASTER_KEY_BYTES) throw new CustomSourceCredentialCryptoError("invalid_master_key");
  if (!secretRef.startsWith(CUSTOM_SOURCE_FETCH_CREDENTIAL_SECRET_REF_V1_PREFIX)) {
    throw new CustomSourceCredentialCryptoError("malformed_secret_ref");
  }
  const payload = secretRef.slice(CUSTOM_SOURCE_FETCH_CREDENTIAL_SECRET_REF_V1_PREFIX.length);
  const [encryptedB64, nonceB64, ...extra] = payload.split(":");
  if (!encryptedB64 || !nonceB64 || extra.length > 0) throw new CustomSourceCredentialCryptoError("malformed_secret_ref");
  if (!BASE64_RE.test(encryptedB64) || !BASE64_RE.test(nonceB64)) {
    throw new CustomSourceCredentialCryptoError("invalid_base64");
  }
  const encryptedWithTag = Buffer.from(encryptedB64, "base64");
  const nonce = Buffer.from(nonceB64, "base64");
  if (nonce.length !== NONCE_BYTES) throw new CustomSourceCredentialCryptoError("invalid_nonce");
  if (encryptedWithTag.length <= AUTH_TAG_BYTES) throw new CustomSourceCredentialCryptoError("invalid_ciphertext");

  const authTag = encryptedWithTag.subarray(encryptedWithTag.length - AUTH_TAG_BYTES);
  const ciphertext = encryptedWithTag.subarray(0, encryptedWithTag.length - AUTH_TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
    if (!plaintext) throw new CustomSourceCredentialCryptoError("decryption_failed");
    return plaintext;
  } catch (error) {
    if (error instanceof CustomSourceCredentialCryptoError) throw error;
    throw new CustomSourceCredentialCryptoError("decryption_failed");
  }
}
