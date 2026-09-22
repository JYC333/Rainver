import { describe, expect, it } from "vitest";
import { baselineSql } from "./support/baselineSql.js";

describe("Files & Code persistence baseline", () => {
  it("contains the final input-resource and draft schema", () => {
    const sql = baselineSql();
    expect(sql).toContain("CREATE TABLE public.project_file_drafts");
    expect(sql).toContain("CREATE TABLE public.conversation_input_resource_blobs");
    expect(sql).toContain("CREATE TABLE public.conversation_input_resources");
    expect(sql).toContain("resource_id character varying(36)");
    expect(sql).not.toContain("conversation_file_snapshots_folder_scope_fkey");
    expect(sql).not.toContain("conversation_file_snapshots_location_scope_fkey");
  });

  it("pins draft ownership, byte/hash integrity, and one-row uniqueness", () => {
    const sql = baselineSql();
    expect(sql).toContain("ADD CONSTRAINT project_file_drafts_project_scope_fkey FOREIGN KEY");
    expect(sql).toContain("ADD CONSTRAINT project_file_drafts_owner_fkey FOREIGN KEY");
    expect(sql).toContain("CONSTRAINT ck_project_file_drafts_size CHECK");
    expect(sql).toContain("octet_length(content) = byte_size");
    expect(sql).toContain("CREATE UNIQUE INDEX uq_project_file_drafts_existing_path");
    expect(sql).toContain("CREATE UNIQUE INDEX uq_project_file_drafts_new_file");
  });

  it("keeps message resources immutable and discriminator-safe", () => {
    const sql = baselineSql();
    expect(sql).toContain("ADD CONSTRAINT conversation_input_resources_message_scope_fkey FOREIGN KEY");
    expect(sql).toContain("ADD CONSTRAINT conversation_input_resources_blob_scope_fkey FOREIGN KEY");
    // The Space-scoped key is the target of the resource-to-blob composite FK.
    expect(sql).toContain("CONSTRAINT uq_conversation_input_resource_blobs_id_space UNIQUE(id, space_id)");
    expect(sql).toContain("CONSTRAINT ck_conversation_input_resources_draft CHECK");
    expect(sql).toContain("CONSTRAINT ck_message_input_parts_kind CHECK");
    expect(sql).toContain("CONSTRAINT ck_message_input_parts_reference CHECK");
    expect(sql).toContain("resource_id IS NOT NULL");
});
});
