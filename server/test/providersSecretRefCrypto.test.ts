import { describe, expect, it } from "vitest";
import {
  decryptModelProviderApiKeySecretRefV1,
  decryptModelProviderOAuthSecretRefV1,
  encryptModelProviderOAuthSecretRefV1,
  MODEL_PROVIDER_API_KEY_AUTH_TAG_BYTES,
  MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES,
  MODEL_PROVIDER_API_KEY_NONCE_BYTES,
  MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX,
  MODEL_PROVIDER_OAUTH_SECRET_REF_V1_PREFIX,
  parseModelProviderApiKeySecretRefV1,
  SecretRefCompatibilityError,
} from "../src/modules/providers";

const FIXTURE_MASTER_KEY = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
);
const FIXTURE_SECRET_REF =
  "model_provider_api_key:v1:oVGLAwn7aGtuUTCrpzWXlr05jeiq6waXBB8NaziyEau+8NEkDLy0ww==:ICEiIyQlJicoKSor";

describe("model-provider secret_ref crypto compatibility", () => {
  it("parses the model-provider secret_ref v1 envelope", () => {
    const parsed = parseModelProviderApiKeySecretRefV1(FIXTURE_SECRET_REF);

    expect(MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX).toBe("model_provider_api_key:v1:");
    expect(MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES).toBe(32);
    expect(parsed.nonce.length).toBe(MODEL_PROVIDER_API_KEY_NONCE_BYTES);
    expect(parsed.encryptedKeyWithTag.length).toBeGreaterThan(
      MODEL_PROVIDER_API_KEY_AUTH_TAG_BYTES,
    );
  });

  it("decrypts the fixed AES-256-GCM ciphertext||tag fixture", () => {
    expect(decryptModelProviderApiKeySecretRefV1(FIXTURE_SECRET_REF, FIXTURE_MASTER_KEY))
      .toBe("sk-secret-ref-compat-key");
  });

  it("fails closed with sanitized errors for malformed or undecryptable refs", () => {
    expect(() => parseModelProviderApiKeySecretRefV1("stub://no-secret")).toThrow(
      SecretRefCompatibilityError,
    );
    expect(() => decryptModelProviderApiKeySecretRefV1(FIXTURE_SECRET_REF, Buffer.alloc(31)))
      .toThrow(SecretRefCompatibilityError);

    const tampered = FIXTURE_SECRET_REF.replace("oVGL", "oVGM");
    expect(() => decryptModelProviderApiKeySecretRefV1(tampered, FIXTURE_MASTER_KEY))
      .toThrow(SecretRefCompatibilityError);
  });

  it("round-trips a managed OAuth credential in a distinct encrypted envelope", () => {
    const credential = {
      type: "oauth" as const,
      access: "oauth-access-secret",
      refresh: "oauth-refresh-secret",
      expires: 1_800_000_000_000,
      accountId: "account-1",
    };

    const secretRef = encryptModelProviderOAuthSecretRefV1(credential, FIXTURE_MASTER_KEY);

    expect(secretRef.startsWith(MODEL_PROVIDER_OAUTH_SECRET_REF_V1_PREFIX)).toBe(true);
    expect(secretRef).not.toContain(credential.access);
    expect(secretRef).not.toContain(credential.refresh);
    expect(decryptModelProviderOAuthSecretRefV1(secretRef, FIXTURE_MASTER_KEY)).toEqual(credential);

    const tampered = `${secretRef.slice(0, -1)}${secretRef.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptModelProviderOAuthSecretRefV1(tampered, FIXTURE_MASTER_KEY))
      .toThrow(SecretRefCompatibilityError);
  });
});
