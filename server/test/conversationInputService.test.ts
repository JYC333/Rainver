import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_MAX_IMAGE_BYTES,
} from "@rainver/protocol";
import { loadConfig } from "../src/config.js";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import { ConversationInputError, ConversationInputService } from "../src/modules/sessions/conversationInputService.js";
import { PgProjectFolderRepository } from "../src/modules/projectFolders/repository.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeDb(handler: (sql: string, params: readonly unknown[]) => unknown = () => undefined): Queryable {
  const query = vi.fn(async <Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => ({
    rows: (handler(sql, params) ?? []) as Row[],
    rowCount: sql.startsWith("DELETE FROM conversation_input_media") ? 1 : 0,
  } satisfies QueryResult<Row>));
  return {
    query: query as Queryable["query"],
  };
}

function pngBytes(): Buffer {
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
}

async function serviceWithRoot(db: Queryable): Promise<{ root: string; service: ConversationInputService }> {
  const root = await mkdtemp(join("/tmp", "rainver-conversation-input-"));
  tempRoots.push(root);
  return {
    root,
    service: new ConversationInputService(db, loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
      SERVER_INTERNAL_TOKEN: "internal-token",
      RAINVER_HOME: root,
    })),
  };
}

describe("ConversationInputService image storage", () => {
  it("streams accepted image bytes to a generated space-scoped name", async () => {
    const db = fakeDb();
    const { root, service } = await serviceWithRoot(db);
    const bytes = pngBytes();
    const uploaded = await service.uploadImage({
      spaceId: "space-1",
      userId: "user-1",
      filename: "C:\\fake\\folder\\preview.png",
      mediaType: "image/png",
      stream: Readable.from([bytes]),
    });

    expect(uploaded.filename).toBe("C:_fake_folder_preview.png");
    expect(uploaded.media_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(uploaded.byte_size).toBe(bytes.byteLength);
    const stored = await service.readStoragePath(`${"space-1"}/${uploaded.media_id}.bin`);
    expect(stored).toEqual(bytes);
    expect(await readFile(resolve(root, "storage", "conversation-inputs", "space-1", `${uploaded.media_id}.bin`))).toEqual(bytes);
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain("INSERT INTO conversation_input_media");
  });

  it("rejects content-type mismatches and over-limit uploads without leaving a file", async () => {
    const db = fakeDb();
    const { root, service } = await serviceWithRoot(db);
    await expect(service.uploadImage({
      spaceId: "space-1", userId: "user-1", filename: "fake.png", mediaType: "image/png",
      stream: Readable.from([Buffer.from("not a png")]),
    })).rejects.toMatchObject({ statusCode: 415 });
    await expect(service.uploadImage({
      spaceId: "space-1", userId: "user-1", filename: "huge.png", mediaType: "image/png",
      stream: Readable.from([Buffer.concat([pngBytes(), Buffer.alloc(CONVERSATION_MAX_IMAGE_BYTES)])]),
    })).rejects.toMatchObject({ statusCode: 413 });
    const spaceDir = resolve(root, "storage", "conversation-inputs", "space-1");
    await expect(readdir(spaceDir)).resolves.toEqual([]);
    expect((db.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("rejects path traversal when reading a database storage reference", async () => {
    const { service } = await serviceWithRoot(fakeDb());
    await expect(service.readStoragePath("../outside.bin")).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.readStoragePath("/etc/passwd")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps unavailable input errors typed for route-level atomic rollback", async () => {
    const service = new ConversationInputService(fakeDb(() => []), loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
      SERVER_INTERNAL_TOKEN: "internal-token",
    }));
    await expect(service.prepareMessageParts({
      spaceId: "space-1", userId: "user-1", sessionId: "session-1",
      parts: [{
        kind: "image", media_id: "media-1", filename: "x.png", media_type: "image/png",
        byte_size: 12,
      }],
    })).rejects.toBeInstanceOf(ConversationInputError);
  });

  it("rejects binary-looking text files before snapshotting them", async () => {
    const db = fakeDb((sql) => {
      if (sql.startsWith("SELECT project_id FROM sessions")) return [{ project_id: "project-1" }];
      if (sql.startsWith("SELECT true AS ok")) return [{ ok: true }];
      return [];
    });
    vi.spyOn(PgProjectFolderRepository.prototype, "getFile").mockResolvedValueOnce({
      path: "assets/data.bin",
      content: "header\u0000payload",
      size: 14,
      line_count: 1,
      sha256: "d".repeat(64),
    });
    const { service } = await serviceWithRoot(db);
    await expect(service.prepareMessageParts({
      spaceId: "space-1", userId: "user-1", sessionId: "session-1",
      parts: [{
        kind: "file_reference", project_folder_id: "folder-1", workspace_location_id: "location-1",
        relative_path: "assets/data.bin", display_name: "data.bin", media_type: "text/plain",
        byte_size: Buffer.byteLength("header\u0000payload", "utf8"), sha256: "d".repeat(64),
      }],
    })).rejects.toMatchObject({ statusCode: 415 });
  });

  it("searches the execution context's pinned Location rather than the Folder's current Location", async () => {
    const db = fakeDb((sql) => {
      if (sql.startsWith("SELECT s.id")) return [{ id: "session-1", space_id: "space-1", project_id: "project-1", room_id: null, project_folder_id: null }];
      if (sql.startsWith("SELECT id, space_id")) return [{
        state: "initialized", primary_workspace_mode: "location", primary_project_folder_id: "folder-1",
        primary_workspace_location_id: "location-pinned",
      }];
      if (sql.startsWith("SELECT location.id")) return [{
        id: "location-pinned", project_folder_id: "folder-1", folder_name: "repo", status: "active",
      }];
      return [];
    });
    const getTree = vi.spyOn(PgProjectFolderRepository.prototype, "getTree").mockResolvedValue({
      name: "repo", path: ".", type: "dir", children: [{ name: "App.tsx", path: "src/App.tsx", type: "file", size: 20 }],
    });
    const { service } = await serviceWithRoot(db);

    await expect(service.searchFiles({
      spaceId: "space-1", userId: "user-1", sessionId: "session-1", query: "App", limit: 20,
    })).resolves.toMatchObject({ items: [{ relative_path: "src/App.tsx", workspace_location_id: "location-pinned" }] });
    expect(getTree).toHaveBeenCalledWith(
      { spaceId: "space-1", userId: "user-1" },
      "project-1",
      "folder-1",
      { workspaceLocationId: "location-pinned", signal: undefined },
    );
  });

  it("keeps a cleanup tombstone until its file is actually removable", async () => {
    const storagePath = "space-1/media-1.bin";
    const db = fakeDb((sql) => sql.startsWith("UPDATE conversation_input_media")
      ? [{ id: "media-1", storage_path: storagePath }]
      : undefined);
    const { root, service } = await serviceWithRoot(db);
    const file = resolve(root, "storage", "conversation-inputs", storagePath);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, "media");

    await expect(service.cleanupExpiredMedia()).resolves.toBe(1);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toContain("DELETE FROM conversation_input_media");
  });

  it("delivers a managed file as a path reference without hydrating its body", async () => {
    const db = fakeDb((sql) => sql.startsWith("SELECT part.id AS part_id") ? [{
      part_id: "part-1",
      kind: "file_reference",
      media_id: null,
      display_name: "App.tsx",
      media_type: "text/plain",
      byte_size: 20,
      storage_path: null,
      relative_path: "src/App.tsx",
      workspace_location_id: "location-1",
      snapshot_id: "snapshot-1",
      location_root_path: null,
      location_host_id: "host-1",
      location_host_kind: "remote",
    }] : []);
    const { service } = await serviceWithRoot(db);

    const hydrated = await service.loadPromptParts({
      spaceId: "space-1",
      messageId: "message-1",
      embeddedContext: true,
      executionHostId: "host-1",
    });

    expect(hydrated.blocks).toEqual([
      {
        type: "resource_link",
        uri: "rainver:conversation-input:part-1",
        name: "src/App.tsx",
        mimeType: "text/plain",
        size: 20,
      },
      { type: "text", text: "[Referenced file: src/App.tsx]" },
    ]);
    expect(JSON.stringify(hydrated.blocks)).not.toContain("original contents");
    expect(hydrated.resources).toMatchObject([{
      input_id: "part-1",
      workspace_location_id: "location-1",
      relative_path: "src/App.tsx",
      name: "src/App.tsx",
    }]);
    const promptQuery = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(promptQuery).not.toContain("snapshot.content AS snapshot_content");
  });

  it("hydrates the immutable file snapshot for a manual retry", async () => {
    const db = fakeDb((sql) => sql.startsWith("SELECT part.id AS part_id") ? [{
      part_id: "part-1",
      kind: "file_reference",
      media_id: null,
      display_name: "README.md",
      media_type: "text/markdown",
      byte_size: 12,
      storage_path: null,
      relative_path: "README.md",
      workspace_location_id: "location-1",
      snapshot_id: "snapshot-1",
      snapshot_content: "original contents",
      location_root_path: null,
      location_host_id: "host-1",
      location_host_kind: "remote",
    }] : []);
    const { service } = await serviceWithRoot(db);

    const hydrated = await service.loadPromptParts({
      spaceId: "space-1",
      messageId: "message-1",
      embeddedContext: false,
      useImmutableSnapshot: true,
      executionHostId: "host-1",
    });

    expect(hydrated.blocks).toEqual([
      {
        type: "resource_link",
        uri: "rainver:conversation-input:part-1",
        name: "README.md",
        mimeType: "text/markdown",
        size: 12,
      },
      { type: "text", text: "[Attached file snapshot: README.md]\noriginal contents" },
    ]);
    const promptQuery = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(promptQuery).toContain("snapshot.content AS snapshot_content");
  });
});
