import { describe, expect, it } from "vitest";
import { ProjectPublicSummaryGenerator } from "../src/modules/projects/publicSummaryGenerator.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import type { ProviderCommandStore } from "../src/modules/providers/commands/store.js";
import type { QueryResult, Queryable, SpaceUserIdentity } from "../src/modules/routeUtils/common.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface SummaryFixture {
  id: string;
  space_id: string;
  project_id: string;
  project_name: string;
  summary_text: string;
  topics_json: string[];
  highlights_json: string[];
  source_refs_json: Array<Record<string, string>>;
  redaction_version: string;
}

interface DraftFixture extends SummaryFixture {
  draft_version: number;
  updated_by_user_id: string | null;
  generated_by_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PublicationFixture extends SummaryFixture {
  source_draft_version: number;
  published_by_user_id: string | null;
  published_at: string;
}

/**
 * SQL-shape fake for the authorization and validation paths that fail before
 * any write; durable publish/revoke behavior is covered against real Postgres
 * in `projectPublicGroup.test.ts`.
 */
class ProjectSummaryFakeDb implements Queryable {
  readonly writes: string[] = [];
  private draft: DraftFixture | null = null;
  private publication: PublicationFixture | null = null;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SELECT id, name, description, current_focus FROM projects")) {
      return result([{
        id: PROJECT,
        name: "Aster",
        description: "Builds project-level public discovery.",
        current_focus: "Cross-project high-level summaries",
      }] as Row[]);
    }
    if (norm.startsWith("SELECT id FROM projects") || norm.startsWith("SELECT id, status FROM projects")) {
      return result([{ id: PROJECT, status: "active" }] as Row[]);
    }
    if (norm.startsWith("SELECT id, space_id, owner_user_id, name, description, status, current_focus")) {
      return result([{ id: PROJECT, space_id: SPACE, owner_user_id: OWNER, name: "Aster", status: "active" }] as Row[]);
    }
    if (norm.startsWith("SELECT owner_user_id FROM projects")) {
      return result([{ owner_user_id: OWNER }] as Row[]);
    }
    if (norm.startsWith("SELECT role FROM space_memberships")) {
      return result([{ role: "member" }] as Row[]);
    }
    if (norm.startsWith("SELECT role FROM project_members")) {
      const [, , userId] = params as [string, string, string];
      const role = userId === MEMBER ? "member" : userId === VIEWER ? "viewer" : null;
      return result((role ? [{ role }] : []) as Row[]);
    }
    if (norm.startsWith("SELECT count(pub.id)::text AS total FROM project_public_summary_publications")) {
      return result([{ total: this.publication ? "1" : "0" }] as Row[]);
    }
    if (norm.startsWith("SELECT pub.id, pub.space_id")) {
      return result((this.publication ? [this.publication] : []) as Row[]);
    }
    if (norm.startsWith("SELECT ps.id, ps.space_id")) {
      return result((this.draft ? [this.draft] : []) as Row[]);
    }
    if (norm.startsWith("WITH upserted AS")) {
      this.writes.push("upsert");
      const [
        id,
        spaceId,
        projectId,
        summaryText,
        topicsJson,
        highlightsJson,
        sourceRefsJson,
        redactionVersion,
        updatedByUserId,
        generatedByRunId,
        now,
      ] = params as [string, string, string, string, string, string, string, string, string, string | null, string];
      this.draft = {
        id: this.draft?.id ?? id,
        space_id: spaceId,
        project_id: projectId,
        project_name: "Aster",
        summary_text: summaryText,
        topics_json: JSON.parse(topicsJson) as string[],
        highlights_json: JSON.parse(highlightsJson) as string[],
        source_refs_json: JSON.parse(sourceRefsJson) as Array<Record<string, string>>,
        redaction_version: redactionVersion,
        draft_version: (this.draft?.draft_version ?? 0) + 1,
        updated_by_user_id: updatedByUserId,
        generated_by_run_id: generatedByRunId,
        created_at: this.draft?.created_at ?? now,
        updated_at: now,
      };
      return result([this.draft] as Row[]);
    }
    if (norm.startsWith("WITH published AS")) {
      this.writes.push("publish");
      const [id, spaceId, projectId, summaryText, topicsJson, highlightsJson, sourceRefsJson, redactionVersion, sourceDraftVersion, publishedBy, now] =
        params as [string, string, string, string, string, string, string, string, number, string, string];
      this.publication = {
        id,
        space_id: spaceId,
        project_id: projectId,
        project_name: "Aster",
        summary_text: summaryText,
        topics_json: JSON.parse(topicsJson) as string[],
        highlights_json: JSON.parse(highlightsJson) as string[],
        source_refs_json: JSON.parse(sourceRefsJson) as Array<Record<string, string>>,
        redaction_version: redactionVersion,
        source_draft_version: sourceDraftVersion,
        published_by_user_id: publishedBy,
        published_at: now,
      };
      return result([this.publication] as Row[]);
    }
    if (norm.startsWith("DELETE FROM project_public_summary_publications")) {
      this.writes.push("revoke");
      const had = this.publication !== null;
      this.publication = null;
      return { rows: [] as Row[], rowCount: had ? 1 : 0 };
    }
    if (norm.startsWith("SELECT pub.project_id")) {
      return result((this.publication ? [{
        project_id: this.publication.project_id,
        name: this.publication.project_name,
        description: "Public project description",
        current_focus: "Improve project-level discovery",
        owner_user_id: OWNER,
        status: "active",
        summary_text: this.publication.summary_text,
        topics_json: this.publication.topics_json,
        highlights_json: this.publication.highlights_json,
        source_refs_json: this.publication.source_refs_json,
        published_at: this.publication.published_at,
      }] : []) as Row[]);
    }
    if (norm.startsWith("DELETE FROM retrieval_edges") || norm.startsWith("DELETE FROM retrieval_objects")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_objects")) {
      return result([{ id: "retrieval-object-1" }] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_aliases") || norm.startsWith("INSERT INTO retrieval_chunks")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("SELECT DISTINCT object_type, object_id FROM retrieval_aliases")) {
      return result([] as Row[]);
    }
    if (norm.includes("FROM memory_entries")) {
      return result([
        {
          id: "memory-1",
          space_id: SPACE,
          subject_user_id: null,
          owner_user_id: OWNER,
          project_folder_id: null,
          scope_type: "user",
          namespace: "project",
          memory_type: "fact",
          title: "Retrieval substrate",
          content: "Builds high-level public project summaries for discovery.",
          visibility: "space_shared",
          sensitivity_level: "normal",
          access_level: "full",
          tags: ["retrieval", "summary"],
          importance: 0.9,
          updated_at: "2026-06-22T00:00:00.000Z",
          source_trust: "user_confirmed",
          project_id: PROJECT,
          deleted_at: null,
        },
        {
          id: "memory-2",
          space_id: SPACE,
          subject_user_id: null,
          owner_user_id: OWNER,
          project_folder_id: null,
          scope_type: "user",
          namespace: "project",
          memory_type: "fact",
          title: "Sensitive launch code",
          content: "SECRET_CUSTOMER_ACCOUNT",
          visibility: "space_shared",
          sensitivity_level: "sensitive",
          access_level: "full",
          tags: ["secret"],
          importance: 0.8,
          updated_at: "2026-06-22T00:00:00.000Z",
          source_trust: "user_confirmed",
          project_id: PROJECT,
          deleted_at: null,
        },
      ] as Row[]);
    }
    if (norm.includes("FROM activity_records")) {
      return result([
        {
          id: "activity-1",
          activity_type: "user_capture",
          title: "Design discussion",
          content: "Use public high-level summaries to inspire other projects.",
          visibility: "space_shared",
          owner_user_id: OWNER,
          user_id: OWNER,
          subject_user_id: null,
          occurred_at: "2026-06-22T00:00:00.000Z",
        },
      ] as Row[]);
    }
    if (norm.includes("FROM artifacts")) {
      return result([
        {
          id: "artifact-1",
          artifact_type: "summary",
          title: "Project ACL notes",
          mime_type: "text/markdown",
          visibility: "space_shared",
          owner_user_id: OWNER,
          created_at: "2026-06-22T00:00:00.000Z",
        },
      ] as Row[]);
    }
    if (norm.includes("FROM proposals p")) {
      return result([
        {
          id: "proposal-1",
          proposal_type: "memory_create",
          status: "approved",
          title: "Remember retrieval ACL decision",
          rationale: "Project summary should stay public and redacted.",
          visibility: "space_shared",
          created_by_user_id: OWNER,
          instructed_by_user_id: OWNER,
          created_at: "2026-06-22T00:00:00.000Z",
        },
      ] as Row[]);
    }
    throw new Error(`unexpected SQL: ${norm}`);
  }
}

const ownerIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

describe("Project public summaries", () => {
  it("lets the project owner stage a sanitized draft and publish that version", async () => {
    const db = new ProjectSummaryFakeDb();
    const repo = new PgProjectRepository(db);
    const draft = await repo.upsertPublicSummary(ownerIdentity, PROJECT, {
      summary_text: "Builds a shared retrieval substrate for cross-project idea discovery.",
      topics: ["Retrieval", "retrieval", "ACL"],
      highlights: ["Indexes only public project summaries."],
      source_refs: [
        {
          source_type: "project",
          source_id: PROJECT,
          label: "Owner-approved project brief",
          content: "must not be persisted",
        },
      ],
    });

    expect(draft).toMatchObject({
      project_id: PROJECT,
      project_name: "Aster",
      topics: ["Retrieval", "ACL"],
      source_refs: [
        {
          source_type: "project",
          source_id: PROJECT,
          label: "Owner-approved project brief",
        },
      ],
      draft_version: 1,
    });
    expect(JSON.stringify(draft)).not.toContain("must not be persisted");
    expect(db.writes).toEqual(["upsert"]);

    const published = await repo.publishPublicSummary(ownerIdentity, PROJECT, 1);
    expect(published).toMatchObject({
      project_id: PROJECT,
      topics: ["Retrieval", "ACL"],
      source_draft_version: 1,
      published_by_user_id: OWNER,
    });
    expect(db.writes).toEqual(["upsert", "publish"]);
  });

  it("stages a draft for a member and blocks them from publishing or revoking", async () => {
    const db = new ProjectSummaryFakeDb();
    const repo = new PgProjectRepository(db);

    const draft = await repo.upsertPublicSummary(
      { spaceId: SPACE, userId: MEMBER },
      PROJECT,
      { summary_text: "Member-staged brief." },
    );
    expect(draft).toMatchObject({ draft_version: 1 });
    expect(db.writes).toEqual(["upsert"]);

    await expect(repo.publishPublicSummary({ spaceId: SPACE, userId: MEMBER }, PROJECT, 1))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(repo.revokePublicSummary({ spaceId: SPACE, userId: MEMBER }, PROJECT))
      .rejects.toMatchObject({ statusCode: 403 });
    // No second write: both attempts failed before any statement.
    expect(db.writes).toEqual(["upsert"]);
  });

  it("rejects project viewers when mutating the public summary", async () => {
    const db = new ProjectSummaryFakeDb();

    await expect(
      new PgProjectRepository(db).upsertPublicSummary(
        { spaceId: SPACE, userId: VIEWER },
        PROJECT,
        { summary_text: "Not authorized." },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(db.writes).toHaveLength(0);
  });

  it("does not expose drafts through the public list or read", async () => {
    const db = new ProjectSummaryFakeDb();
    const repo = new PgProjectRepository(db);
    await repo.upsertPublicSummary(ownerIdentity, PROJECT, { summary_text: "Draft brief." });

    const list = await repo.listPublicSummaries(
      { spaceId: SPACE, userId: MEMBER },
      { limit: 50, offset: 0 },
    );
    expect(list).toMatchObject({ total: 0, items: [] });
    expect(await repo.getPublicSummary({ spaceId: SPACE, userId: MEMBER }, PROJECT)).toBeNull();
  });

  it("requires source_refs to identify a public source, not embed source content", async () => {
    const db = new ProjectSummaryFakeDb();

    await expect(
      new PgProjectRepository(db).upsertPublicSummary(ownerIdentity, PROJECT, {
        summary_text: "Public brief.",
        source_refs: [{ source_type: "memo", excerpt: "raw content" }],
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "source_refs entries require source_type and source_id",
    });
    expect(db.writes).toHaveLength(0);
  });

  it("generates a draft summary without exposing sensitive memory content or hallucinated source refs", async () => {
    const db = new ProjectSummaryFakeDb();
    const fakeStore = {
      getTaskChain: async () => null,
    } as unknown as ProviderCommandStore;
    let observedPrompt = "";
    const generator = new ProjectPublicSummaryGenerator(db, fakeStore, async (_spaceId, input) => {
      observedPrompt = `${input.system}\n${input.user}`;
      return {
        text: JSON.stringify({
          summary_text: "Aster explores safe, high-level project discovery across project boundaries.",
          topics: ["project discovery", "public summary"],
          highlights: ["Uses a redacted summary layer instead of exposing project memory."],
          source_refs: [
            {
              source_type: "memory",
              source_id: "memory-1",
              label: "Retrieval substrate",
              trust_level: "derived",
              content: "must be dropped",
            },
            {
              source_type: "memory",
              source_id: "missing-memory",
              label: "Hallucinated",
            },
          ],
        }),
        model: "test-model",
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    });

    const out = await generator.generateDraft(ownerIdentity, PROJECT, {
      providerId: "provider-1",
    });

    expect(observedPrompt).toContain("memory:memory-1");
    expect(observedPrompt).not.toContain("SECRET_CUSTOMER_ACCOUNT");
    expect(out).toMatchObject({
      project_id: PROJECT,
      draft_version: 1,
      summary_text: "Aster explores safe, high-level project discovery across project boundaries.",
      source_refs: [
        {
          source_type: "memory",
          source_id: "memory-1",
          label: "Retrieval substrate",
          trust_level: "derived",
        },
      ],
      generator: {
        prompt_version: "project_public_summary.prompt.v1",
        model: "test-model",
      },
    });
    expect(JSON.stringify(out)).not.toContain("must be dropped");
    expect(JSON.stringify(out)).not.toContain("missing-memory");
  });
});

function result<Row>(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}
