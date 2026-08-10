import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedPayloadBinding {
  spaceId: string;
  snapshotId: string;
  payloadId: string;
  retentionDeadline: string;
}

export class SealedPayloadCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Sealed Payload key must be exactly 32 bytes");
  }

  encrypt(value: unknown, binding: SealedPayloadBinding): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(bindingBytes(binding));
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `sealed.v1.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
  }

  decrypt(value: string, binding: SealedPayloadBinding): unknown {
    const prefix = "sealed.v1.";
    if (!value.startsWith(prefix)) throw new Error("Unsupported Sealed Payload format");
    const packed = Buffer.from(value.slice(prefix.length), "base64url");
    if (packed.length <= NONCE_BYTES + TAG_BYTES) throw new Error("Malformed Sealed Payload");
    const nonce = packed.subarray(0, NONCE_BYTES);
    const tag = packed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = packed.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(bindingBytes(binding));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  }
}

function bindingBytes(binding: SealedPayloadBinding): Buffer {
  return Buffer.from(JSON.stringify([
    "sealed-payload-binding.v1",
    binding.spaceId,
    binding.snapshotId,
    binding.payloadId,
    binding.retentionDeadline,
  ]), "utf8");
}
