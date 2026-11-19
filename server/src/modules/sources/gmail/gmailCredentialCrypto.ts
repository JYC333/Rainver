/**
 * At-rest encryption for the `gmail_oauth` credential class (a fourth class in
 * the shared `credentials` table; see `.agent/architecture/CREDENTIAL_STORAGE.md`).
 * AES-256-GCM under the shared instance master key with
 * AAD = `gmail_oauth:v1|<credential_id>|<gmail_connection_id>`, so a ciphertext
 * copied to another credential row or connection does not decrypt.
 *
 * Deliberately separate from `providers/secretRefCrypto.ts` and the Custom
 * Source envelope: each class keeps its own prefix and version.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "gmail_oauth:v1:" as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface GmailOAuthSecretV1 {
  refresh_token: string;
  access_token: string;
  /** Epoch milliseconds. */
  access_token_expires_at: number;
}

export class GmailCredentialCryptoError extends Error {
  constructor(readonly code: "gmail_credential_malformed" | "gmail_credential_undecryptable") {
    super(code);
    this.name = "GmailCredentialCryptoError";
  }
}

function aad(purpose: "gmail_oauth:v1", rowId: string, connectionId: string): Buffer {
  if (!rowId || !connectionId || rowId.includes("|") || connectionId.includes("|")) {
    throw new GmailCredentialCryptoError("gmail_credential_malformed");
  }
  return Buffer.from(`${purpose}|${rowId}|${connectionId}`, "utf8");
}

function seal(prefix: string, plaintext: string, masterKey: Buffer, additional: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  cipher.setAAD(additional);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${prefix}${body.toString("base64")}:${nonce.toString("base64")}`;
}

function open(prefix: string, secretRef: string, masterKey: Buffer, additional: () => Buffer): unknown {
  if (masterKey.length !== 32 || !secretRef.startsWith(prefix)) throw new GmailCredentialCryptoError("gmail_credential_malformed");
  const [bodyB64, nonceB64, ...extra] = secretRef.slice(prefix.length).split(":");
  if (!bodyB64 || !nonceB64 || extra.length || !BASE64.test(bodyB64) || !BASE64.test(nonceB64)) {
    throw new GmailCredentialCryptoError("gmail_credential_malformed");
  }
  const body = Buffer.from(bodyB64, "base64");
  const nonce = Buffer.from(nonceB64, "base64");
  if (nonce.length !== NONCE_BYTES || body.length <= TAG_BYTES) throw new GmailCredentialCryptoError("gmail_credential_malformed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
    decipher.setAAD(additional());
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return JSON.parse(Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8"));
  } catch {
    throw new GmailCredentialCryptoError("gmail_credential_undecryptable");
  }
}

function validSecret(value: unknown): value is GmailOAuthSecretV1 {
  const v = value as GmailOAuthSecretV1;
  return !!v && typeof v === "object" && typeof v.refresh_token === "string" && v.refresh_token.length > 0
    && typeof v.access_token === "string" && v.access_token.length > 0
    && Number.isFinite(v.access_token_expires_at);
}

export function encryptGmailOAuthSecret(secret: GmailOAuthSecretV1, masterKey: Buffer, binding: { credentialId: string; connectionId: string }): string {
  if (masterKey.length !== 32 || !validSecret(secret)) throw new GmailCredentialCryptoError("gmail_credential_malformed");
  return seal(PREFIX, JSON.stringify({
    refresh_token: secret.refresh_token,
    access_token: secret.access_token,
    access_token_expires_at: secret.access_token_expires_at,
  }), masterKey, aad("gmail_oauth:v1", binding.credentialId, binding.connectionId));
}

export function decryptGmailOAuthSecret(secretRef: string, masterKey: Buffer, binding: { credentialId: string; connectionId: string }): GmailOAuthSecretV1 {
  const parsed = open(PREFIX, secretRef, masterKey, () => aad("gmail_oauth:v1", binding.credentialId, binding.connectionId));
  if (!validSecret(parsed)) throw new GmailCredentialCryptoError("gmail_credential_undecryptable");
  return parsed;
}
