import { describe, expect, it } from "vitest";
import { HostDaemonFrameSchema, HostFolderWriteFrameSchema, HostServerFrameSchema } from "../src/hostWire.js";

describe("folder_write wire contract", () => {
  it("accepts direct writes and deletion frames", () => {
    expect(HostFolderWriteFrameSchema.safeParse({
      type: "folder_write",
      request_id: "request-1",
      workspace_location_id: "location-1",
      path: "notes/today.md",
      content: "hello",
      expected_exists: false,
      expected_sha256: null,
      protected: false,
    }).success).toBe(true);
    expect(HostServerFrameSchema.safeParse({
      type: "folder_write",
      request_id: "request-1",
      workspace_location_id: "location-1",
      path: "notes/today.md",
      content: null,
      expected_exists: true,
      expected_sha256: "a".repeat(64),
      protected: true,
    }).success).toBe(true);
  });

  it("requires a hexadecimal SHA-256 when a preimage hash is supplied", () => {
    expect(HostServerFrameSchema.safeParse({
      type: "folder_write",
      request_id: "request-1",
      workspace_location_id: "location-1",
      path: "notes/today.md",
      content: "hello",
      expected_exists: true,
      expected_sha256: "not-a-hash",
      protected: false,
    }).success).toBe(false);
    expect(HostDaemonFrameSchema.safeParse({
      type: "folder_write_result",
      request_id: "request-1",
      ok: true,
      path: "notes/today.md",
      exists: true,
      sha256: "b".repeat(64),
      size: 5,
      line_count: 1,
    }).success).toBe(true);
  });
});
