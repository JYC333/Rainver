import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function migrationSql(): string {
  return readFileSync(join(MIGRATIONS_DIR, "0006_file_drafts_and_input_resources.sql"), "utf8");
}

describe("Files & Code persistence migration", () => {
  it("keeps all schema work in the single Phase 0 migration", () => {
    const sql = migrationSql();
    expect(sql).toContain('CREATE TABLE "project_file_drafts"');
    expect(sql).toContain('CREATE TABLE "conversation_input_resource_blobs"');
    expect(sql).toContain('CREATE TABLE "conversation_input_resources"');
    expect(sql).toContain('ALTER TABLE "message_input_parts" ADD COLUMN "resource_id"');
    expect(sql).toContain('ALTER TABLE "conversation_file_snapshots" DROP CONSTRAINT');
  });

  it("pins draft ownership, byte/hash integrity, and one-row uniqueness", () => {
    const sql = migrationSql();
    expect(sql).toContain('CONSTRAINT "project_file_drafts_project_scope_fkey" FOREIGN KEY');
    expect(sql).toContain('CONSTRAINT "project_file_drafts_owner_fkey" FOREIGN KEY');
    expect(sql).toContain('CONSTRAINT "ck_project_file_drafts_size" CHECK');
    expect(sql).toContain("octet_length(content) = byte_size");
    expect(sql).toContain('CREATE UNIQUE INDEX "uq_project_file_drafts_existing_path"');
    expect(sql).toContain('CREATE UNIQUE INDEX "uq_project_file_drafts_new_file"');
  });

  it("keeps message resources immutable and discriminator-safe", () => {
    const sql = migrationSql();
    expect(sql).toContain('CONSTRAINT "conversation_input_resources_message_scope_fkey" FOREIGN KEY');
    expect(sql).toContain('CONSTRAINT "conversation_input_resources_blob_scope_fkey" FOREIGN KEY');
    // The Space-scoped key that foreign key references. Without it PostgreSQL
    // refuses the whole migration, so every database stays on the previous
    // schema and nothing in this slice can be applied at all.
    expect(sql).toContain('CONSTRAINT "uq_conversation_input_resource_blobs_id_space" UNIQUE("id","space_id")');
    expect(sql).toContain('CONSTRAINT "ck_conversation_input_resources_draft" CHECK');
    expect(sql).toContain('CONSTRAINT "ck_message_input_parts_kind" CHECK (kind IN (\'image\', \'file_reference\', \'input_resource\'))');
    expect(sql).toContain('CONSTRAINT "ck_message_input_parts_reference" CHECK');
    expect(sql).toContain('AND resource_id IS NOT NULL');
  });

  it("removes live Folder/Location blockers without rewriting legacy snapshots", () => {
    const sql = migrationSql();
    expect(sql).toContain('DROP CONSTRAINT "conversation_file_snapshots_folder_scope_fkey"');
    expect(sql).toContain('DROP CONSTRAINT "conversation_file_snapshots_location_scope_fkey"');
    expect(sql).not.toContain("DROP TABLE \"conversation_file_snapshots\"");
    expect(sql).not.toContain("DELETE FROM \"conversation_file_snapshots\"");
  });
});
