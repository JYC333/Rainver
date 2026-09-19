import { describe, expect, it } from "vitest";
import {
  ConversationInputResourceMessagePartSchema,
  ConversationInputResourcePartSchema,
  InputResourceReadInputSchema,
  InputResourceSearchInputSchema,
  ProjectFileDraftMutationSchema,
  StrictTextFileMetadataSchema,
} from "../src/index.js";

const hash = "a".repeat(64);

describe("draft and immutable input-resource contracts", () => {
  it("accepts saved and draft sources without accepting a body", () => {
    const saved = ConversationInputResourcePartSchema.parse({
      kind: "input_resource",
      source_state: "saved",
      project_folder_id: "folder-1",
      workspace_location_id: "location-1",
      relative_path: "src/App.tsx",
      display_name: "App.tsx",
      media_type: "text/typescript",
      byte_size: 18,
      sha256: hash,
    });
    expect(saved.source_state).toBe("saved");

    const draft = ConversationInputResourcePartSchema.parse({
      kind: "input_resource",
      source_state: "draft",
      draft_id: "draft-1",
      draft_version: 3,
      content_sha256: hash,
      display_name: "App.tsx",
      media_type: "text/typescript",
      byte_size: 18,
    });
    expect(draft.source_state).toBe("draft");
    expect(ConversationInputResourcePartSchema.safeParse({ ...draft, content: "secret body" }).success).toBe(false);
  });

  it("keeps text admission metadata strict and bounded", () => {
    expect(StrictTextFileMetadataSchema.safeParse({
      encoding: "utf8",
      byte_size: 10,
      sha256: hash,
      line_count: 2,
      has_bom: false,
      line_ending_mode: "lf",
      writable: true,
      conversion_available: false,
    }).success).toBe(true);
    expect(StrictTextFileMetadataSchema.safeParse({
      encoding: "latin1",
      byte_size: 10,
      sha256: hash,
      line_count: 2,
      has_bom: false,
      line_ending_mode: "lf",
      writable: true,
      conversion_available: false,
    }).success).toBe(false);
  });

  it("enforces optimistic draft payload bounds and read/search budgets", () => {
    const mutation = {
      expected_version: 2,
      target_kind: "existing" as const,
      relative_path: "README.md",
      base_exists: true,
      base_sha256: hash,
      content: "hello\n",
      content_sha256: hash,
      byte_size: 6,
      source_encoding: "utf8" as const,
      preserve_bom: false,
      line_ending_mode: "lf" as const,
    };
    expect(ProjectFileDraftMutationSchema.safeParse(mutation).success).toBe(true);
    expect(ProjectFileDraftMutationSchema.safeParse({ ...mutation, byte_size: 1024 * 1024 + 1 }).success).toBe(false);

    expect(InputResourceReadInputSchema.parse({ resource_id: "resource-1" })).toMatchObject({
      start_line: 1,
      line_count: 400,
    });
    expect(InputResourceReadInputSchema.safeParse({ resource_id: "resource-1", line_count: 401 }).success).toBe(false);
    expect(InputResourceSearchInputSchema.safeParse({ resource_id: "resource-1", query: "TODO", max_results: 20 }).success).toBe(true);
    expect(InputResourceSearchInputSchema.safeParse({ resource_id: "resource-1", query: "" }).success).toBe(false);
    expect(ConversationInputResourcePartSchema.safeParse({
      kind: "input_resource",
      source_state: "saved",
      project_folder_id: "folder-1",
      workspace_location_id: "location-1",
      relative_path: "README.md",
      display_name: "README.md",
      media_type: "text/markdown",
      byte_size: 1,
      sha256: hash,
      selection: { start_line: 3, start_column: 8, end_line: 3, end_column: 7 },
    }).success).toBe(false);
  });

  it("requires immutable message metadata but never requires resource content", () => {
    expect(ConversationInputResourceMessagePartSchema.safeParse({
      kind: "input_resource",
      id: "part-1",
      resource_id: "resource-1",
      source_state: "draft",
      display_name: "README.md",
      media_type: "text/markdown",
      byte_size: 8,
      sha256: hash,
      relative_path: "README.md",
      captured_at: "2026-09-17T00:00:00.000Z",
    }).success).toBe(true);
  });
});
