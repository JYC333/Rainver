import {PUBLICATION_OPERATION_SCHEMAS} from '../src/publicationOperations.js';
import { describe, expect, it } from "vitest";
import {
  ContentPublicationSchema,
  CreatePublicationRequestSchema,
  PublicationImportSchema,
  PublicationSnapshotSchema,
} from "../src/publications.js";

describe("publication contracts", () => {
  it("accepts an immutable targeted publication response", () => {
    const snapshot = {
      schema_version: 1,
      resource_type: "artifact",
      title: "Report",
      payload: { artifact_type: "markdown", content: "# Report" },
    };
    expect(PublicationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(ContentPublicationSchema.parse({
      id: "publication-1",
      source_space_id: "space-1",
      source_resource_type: "artifact",
      source_resource_id: "artifact-1",
      version: 1,
      snapshot_schema_version: 1,
      snapshot_hash: "a".repeat(64),
      title: "Report",
      snapshot,
      published_by_user_id: "user-1",
      target_space_ids: ["space-2"],
      status: "active",
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:00:00.000Z",
      revoked_at: null,
      revoked_by_user_id: null,
      import: null,
    }).target_space_ids).toEqual(["space-2"]);
  });

  it("rejects duplicate targets and unregistered resource types", () => {
    expect(CreatePublicationRequestSchema.safeParse({
      resource_type: "artifact",
      resource_id: "artifact-1",
      target_space_ids: ["space-2", "space-2"],
    }).success).toBe(false);
    expect(CreatePublicationRequestSchema.safeParse({
      resource_type: "run",
      resource_id: "run-1",
      target_space_ids: ["space-2"],
    }).success).toBe(false);
  });

  it("requires complete provenance on an import response", () => {
    expect(PublicationImportSchema.parse({
      id: "import-1",
      publication_id: "publication-1",
      target_space_id: "space-2",
      publication_version: 1,
      snapshot_hash: "b".repeat(64),
      imported_resource_type: "task",
      imported_resource_id: "task-2",
      imported_by_user_id: "user-2",
      created_at: "2026-07-10T12:00:00.000Z",
    }).publication_version).toBe(1);
  });
});

it('keeps all three command inputs strict and preserves a concealed import receipt',()=>{
 expect(Object.keys(PUBLICATION_OPERATION_SCHEMAS)).toEqual(['publication.create','publication.import','publication.revoke']);
 for(const key of ['publication.import','publication.revoke'] as const){
  expect(PUBLICATION_OPERATION_SCHEMAS[key].input.safeParse({publication_id:'publication',user_id:'other'}).success).toBe(false);
 }
 expect(PublicationImportSchema.safeParse({id:'import',publication_id:'publication',target_space_id:'space',publication_version:1,snapshot_hash:'a'.repeat(64),imported_resource_type:'task',imported_resource_id:null,imported_by_user_id:'other',created_at:'2026-07-10T12:00:00.000Z'}).success).toBe(true);
});
