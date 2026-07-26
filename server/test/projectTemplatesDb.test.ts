import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { ProjectTemplatesRepository } from "../src/modules/projectTemplates/repository";
import { ProjectTemplatesService } from "../src/modules/projectTemplates/service";
import { __setProjectTemplateRegistryForTests } from "../src/modules/projectTemplates/registry";

// Real-Postgres coverage for Project Template infrastructure:
// descriptors are code-owned, and a Project's selected Template is stored at
// creation time in the first-class `projects.template_key` column, not in
// settings_json.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    console.warn(`[project-templates-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE projects, users, spaces CASCADE");
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'User', 'active', now(), now())`,
    [USER],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Preset Space', 'household', $2, now(), now())`,
    [SPACE, USER],
  );
  __setProjectTemplateRegistryForTests([
    {
      key: "blank",
      name: "Blank (test stand-in)",
      description: "Test-only default template.",
      sections: [],
      extraction_profile_key: null,
      graph_lens_id: null,
      initial_primary_mode: "inquiry",
      starter_workflow_template_keys: [],
    },
    {
      key: "test_template",
      name: "Test Template",
      description: "A test-only Template descriptor.",
      sections: ["overview"],
      extraction_profile_key: null,
      graph_lens_id: null,
      initial_primary_mode: "inquiry",
      starter_workflow_template_keys: [],
    },
  ]);
});

afterEach(() => {
  __setProjectTemplateRegistryForTests(null);
});

function service(): ProjectTemplatesService {
  return new ProjectTemplatesService(new ProjectTemplatesRepository(pool as Pool));
}

const identity = { spaceId: SPACE, userId: USER };

describe("project templates module (real Postgres)", () => {
  it("lists code-owned Project Template descriptors sorted by key", () => {
    if (!available) return;
    expect(service().listAvailableTemplates().map((t) => t.key)).toEqual(["blank", "test_template"]);
  });

  it("reads the template selected at project creation time", async () => {
    if (!available) return;
    const projectRepo = new PgProjectRepository(pool as Pool);
    const project = await projectRepo.create(identity, {
      name: "Research Project",
      settings_json: { custom: "value" },
      template_key: "test_template",
    });
    expect(await service().getProjectTemplate(identity, project.id as string)).toBe("test_template");
  });

  it("defaults to the blank template when no template_key is given", async () => {
    if (!available) return;
    const projectRepo = new PgProjectRepository(pool as Pool);
    const project = await projectRepo.create(identity, { name: "Research Project" });
    expect(await service().getProjectTemplate(identity, project.id as string)).toBe("blank");
    expect(project.primary_mode).toBe("inquiry");
  });

  it("rejects an unknown template_key", async () => {
    if (!available) return;
    const projectRepo = new PgProjectRepository(pool as Pool);
    await expect(
      projectRepo.create(identity, { name: "Research Project", template_key: "does_not_exist" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
