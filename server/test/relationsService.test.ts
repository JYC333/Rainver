import { describe, expect, it } from "vitest";
import { RelationsService } from "../src/modules/relations/service.js";
import { RelationsRepository, type RelationSourceLinkRow } from "../src/modules/relations/repository.js";

const NOW = "2026-07-08T00:00:00.000Z";

class FakeRelationsRepository {
  readonly createdLinks: Array<{
    spaceId: string;
    objectId: string;
    linkType: string;
    activityId: string | null;
    sourceItemId: string | null;
    evidenceId: string | null;
    externalRef: string | null;
  }> = [];

  constructor(
    private readonly refs: {
      relationObjects?: Set<string>;
      activities?: Set<string>;
      sourceItems?: Set<string>;
      evidence?: Set<string>;
    } = {},
  ) {}

  async existsRelationObject(_spaceId: string, objectId: string): Promise<boolean> {
    return (this.refs.relationObjects ?? new Set(["person-1"])).has(objectId);
  }

  async isOwnedRelationObject(_spaceId: string, objectId: string): Promise<boolean> {
    return (this.refs.relationObjects ?? new Set(["person-1"])).has(objectId);
  }

  async activityExistsInSpace(_spaceId: string, activityId: string): Promise<boolean> {
    return (this.refs.activities ?? new Set()).has(activityId);
  }

  async sourceItemExistsInSpace(_spaceId: string, sourceItemId: string, _userId: string): Promise<boolean> {
    return (this.refs.sourceItems ?? new Set()).has(sourceItemId);
  }

  async evidenceExistsInSpace(_spaceId: string, evidenceId: string, _userId: string): Promise<boolean> {
    return (this.refs.evidence ?? new Set()).has(evidenceId);
  }

  async createSourceLink(input: {
    spaceId: string;
    objectId: string;
    linkType: string;
    activityId: string | null;
    sourceItemId: string | null;
    evidenceId: string | null;
    externalRef: string | null;
    note: string | null;
    createdByUserId: string | null;
    createdByAgentId: string | null;
  }): Promise<RelationSourceLinkRow> {
    this.createdLinks.push(input);
    return {
      id: "link-1",
      space_id: input.spaceId,
      object_id: input.objectId,
      link_type: input.linkType,
      activity_id: input.activityId,
      source_item_id: input.sourceItemId,
      evidence_id: input.evidenceId,
      external_ref: input.externalRef,
      note: input.note,
      created_by_user_id: input.createdByUserId,
      created_by_agent_id: input.createdByAgentId,
      created_at: NOW,
    };
  }
}

function service(repository: FakeRelationsRepository): RelationsService {
  return new RelationsService({} as never, repository as unknown as RelationsRepository);
}

describe("RelationsService source link boundaries", () => {
  it("requires source_item source links to reference a source item in the current space", async () => {
    const repo = new FakeRelationsRepository({ sourceItems: new Set(["item-local"]) });

    await expect(
      service(repo).createSourceLink({ spaceId: "space-1", userId: "user-1" }, "person-1", {
        link_type: "source_item",
        source_item_id: "item-other-space",
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "source_item_id does not reference a source item in this space",
    });
    expect(repo.createdLinks).toHaveLength(0);

    const created = await service(repo).createSourceLink({ spaceId: "space-1", userId: "user-1" }, "person-1", {
      link_type: "source_item",
      source_item_id: "item-local",
    });
    expect(created.source_item_id).toBe("item-local");
    expect(repo.createdLinks).toHaveLength(1);
  });

  it("requires the reference field that matches the source link type", async () => {
    const repo = new FakeRelationsRepository();

    await expect(
      service(repo).createSourceLink({ spaceId: "space-1", userId: "user-1" }, "person-1", {
        link_type: "evidence",
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "evidence_id is required for evidence source links",
    });
    expect(repo.createdLinks).toHaveLength(0);
  });

  it("requires exactly one source-link target", async () => {
    const repo = new FakeRelationsRepository({
      activities: new Set(["activity-local"]),
      evidence: new Set(["evidence-local"]),
    });

    await expect(
      service(repo).createSourceLink({ spaceId: "space-1", userId: "user-1" }, "person-1", {
        link_type: "external",
        external_ref: "https://example.com/profile",
        activity_id: "activity-local",
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "Exactly one source link target is required",
    });
    expect(repo.createdLinks).toHaveLength(0);

    const created = await service(repo).createSourceLink({ spaceId: "space-1", userId: "user-1" }, "person-1", {
      link_type: "evidence",
      evidence_id: "evidence-local",
    });
    expect(created.evidence_id).toBe("evidence-local");
  });
});
