import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer";
import { projectsModule } from "../src/modules/projects";
import { projectFoldersModule } from "../src/modules/projectFolders";
import { loadConfig } from "../src/config";
import {
  __setProjectFolderIdentityForTests,
  __setProjectFolderServicesFactoryForTests,
} from "../src/modules/projectFolders";
import type { PgProjectFolderRepository } from "../src/modules/projectFolders/repository";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setProjectFolderIdentityForTests(null);
  __setProjectFolderServicesFactoryForTests(null);
  await app?.close();
  app = undefined;
});

describe("project folder routes", () => {
  it("serves Project Folder routes from server-owned services", async () => {
    __setProjectFolderIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProjectFolderServicesFactoryForTests(() => ({
      repository: fakeRepository(),
    }));
    app = buildModuleServer(loadConfig({}), [projectFoldersModule, projectsModule]);

    await expectJson("GET", "/api/v1/projects/project-1/folders", {
      items: [{ id: "folder-1", name: "Folder" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    await expectJson("GET", "/api/v1/projects/project-1/folders/folder-1", {
      id: "folder-1",
      name: "Folder",
    });
    await expectJson("GET", "/api/v1/projects/project-1/folders/folder-1/tree", {
      name: "folder", path: ".", type: "dir", children: [],
    });
    await expectJson("GET", "/api/v1/projects/project-1/folders/folder-1/file?path=README.md", {
      path: "README.md",
      content: "hello",
      size: 5,
      line_count: 1,
    });
    await expectJson("GET", "/api/v1/projects/project-1/folders/folder-1/git/status", {
      is_repo: false, branch: null, files: [],
    });
    await expectJson("GET", "/api/v1/projects/project-1/folders/folder-1/git/diff", {
      diff: "", path: null, truncated: false, redacted: false,
    });
  });

});

async function expectJson(method: "GET", url: string, expected: unknown): Promise<void> {
  if (!app) throw new Error("test app not initialized");
  const response = await app.inject({ method, url });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(expected);
}

function fakeRepository(): Pick<
  PgProjectFolderRepository,
  | "list"
  | "create"
  | "scanCandidates"
  | "get"
  | "update"
  | "archive"
  | "unregister"
  | "getTree"
  | "getFile"
  | "getGitStatus"
  | "getGitDiff"
> {
  return {
    async list() {
      return { items: [{ id: "folder-1", name: "Folder" }], total: 1, limit: 50, offset: 0 };
    },
    async create() {
      return { id: "folder-1", name: "Folder" };
    },
    async scanCandidates() {
      return [];
    },
    async get() {
      return { id: "folder-1", name: "Folder" };
    },
    async update() {
      return { id: "folder-1", name: "Folder" };
    },
    async archive() {
      return true;
    },
    async unregister() {
      return true;
    },
    async getTree() {
      return { name: "folder", path: ".", type: "dir", children: [] };
    },
    async getFile(_identity: unknown, _projectId: unknown, _folderId: unknown, requestedPath: string) {
      return { path: requestedPath, content: "hello", size: 5, line_count: 1 };
    },
    async getGitStatus() {
      return { is_repo: false, branch: null, files: [] };
    },
    async getGitDiff() {
      return { diff: "", path: null, truncated: false, redacted: false };
    },
  } as unknown as Pick<
    PgProjectFolderRepository,
    | "list"
    | "create"
    | "scanCandidates"
    | "get"
    | "update"
    | "archive"
    | "unregister"
    | "getTree"
    | "getFile"
    | "getGitStatus"
    | "getGitDiff"
  >;
}
