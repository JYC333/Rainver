import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConversationInputService } from "../src/modules/sessions/conversationInputService.js";
import { useTestDatabase } from "./support/testDatabase.js";

const db = useTestDatabase(import.meta.filename, { max: 4 });
let testRoot: string | undefined;

beforeAll(async () => {
  if (db.available) testRoot = await mkdtemp(join("/tmp", "rainver-conversation-input-db-"));
});

afterAll(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

function pngBytes(): Buffer {
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
}

async function seedConversation(): Promise<{ spaceId: string; userId: string; outsiderId: string; sessionId: string; messageId: string }> {
  const spaceId = randomUUID();
  const userId = randomUUID();
  const outsiderId = randomUUID();
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Input Owner', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system'), ($2, 'Input Outsider', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [userId, outsiderId, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Input Space', 'team', $2, $3, $3)`,
    [spaceId, userId, now],
  );
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, user_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, $4)`,
    [sessionId, spaceId, userId, now],
  );
  await db.pool.query(
    `INSERT INTO messages (
       id, space_id, session_id, user_id, role, content, path_depth, branch_path, created_at
     ) VALUES ($1, $2, $3, $4, 'user', '', 0, '/', $5)`,
    [messageId, spaceId, sessionId, userId, now],
  );
  return { spaceId, userId, outsiderId, sessionId, messageId };
}

describe("conversation input persistence on real Postgres", () => {
  it("claims media for a message and enforces the message audience", async () => {
    const ids = await seedConversation();
    const service = new ConversationInputService(db.pool, loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      RAINVER_HOME: testRoot!,
    }));
    const media = await service.uploadImage({
      spaceId: ids.spaceId,
      userId: ids.userId,
      filename: "preview.png",
      mediaType: "image/png",
      stream: Readable.from([pngBytes()]),
    });
    await db.pool.query(
      `UPDATE conversation_input_media
          SET lifecycle = 'claimed', message_id = $2, claimed_at = now()
        WHERE id = $1 AND space_id = $3`,
      [media.media_id, ids.messageId, ids.spaceId],
    );

    await expect(service.getVisibleMedia(ids.spaceId, ids.userId, media.media_id)).resolves.toMatchObject({
      media_id: media.media_id,
      message_id: ids.messageId,
    });
    await expect(service.getVisibleMedia(ids.spaceId, ids.outsiderId, media.media_id)).resolves.toBeNull();
  });

  it("removes expired media rows only after the filesystem object is removable", async () => {
    const ids = await seedConversation();
    const service = new ConversationInputService(db.pool, loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      RAINVER_HOME: testRoot!,
    }));
    const media = await service.uploadImage({
      spaceId: ids.spaceId,
      userId: ids.userId,
      filename: "expired.png",
      mediaType: "image/png",
      stream: Readable.from([pngBytes()]),
    });
    await db.pool.query(
      `UPDATE conversation_input_media SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [media.media_id],
    );
    await expect(service.cleanupExpiredMedia()).resolves.toBe(1);
    await expect(db.pool.query("SELECT 1 FROM conversation_input_media WHERE id = $1", [media.media_id]))
      .resolves.toMatchObject({ rows: [] });
    await expect(readFile(join(testRoot!, "storage", "conversation-inputs", ids.spaceId, `${media.media_id}.bin`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
