import { describe, expect, it } from "vitest";
import { ProjectTemplatesRepository } from "../src/modules/projectTemplates/repository";
import { ProjectTemplatesService } from "../src/modules/projectTemplates/service";

class FakeProjectTemplatesRepository {
  constructor(private readonly rows: Map<string, { template_key: string | null } | null>) {}

  async getProjectTemplateKey(_spaceId: string, projectId: string): Promise<{ template_key: string | null } | null> {
    return this.rows.get(projectId) ?? null;
  }
}

function service(rows: Map<string, { template_key: string | null } | null>): ProjectTemplatesService {
  return new ProjectTemplatesService(new FakeProjectTemplatesRepository(rows) as unknown as ProjectTemplatesRepository);
}

describe("ProjectTemplatesService", () => {
  it("reads the Project Template key through the dedicated Template repository path", async () => {
    await expect(
      service(new Map([["project-1", { template_key: "academic_research" }]])).getProjectTemplate(
        { spaceId: "space-1", userId: "viewer-1" },
        "project-1",
      ),
    ).resolves.toBe("academic_research");
  });

  it("returns 404 when the project does not exist in the current space", async () => {
    await expect(
      service(new Map()).getProjectTemplate({ spaceId: "space-1", userId: "viewer-1" }, "project-missing"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
