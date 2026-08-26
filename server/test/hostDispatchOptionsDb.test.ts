import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository, type CurrentUser } from "../src/modules/auth/identity.js";
import { PgHostRuntimeProviderBindingRepository } from "../src/modules/hosts/runtimeProviderBindingRepository.js";
import { PgHostTaskThreadRepository } from "../src/modules/hosts/taskThreadRepository.js";
import { PgHostThreadMessageRepository } from "../src/modules/hosts/threadMessageRepository.js";
import type { DispatchOptions } from "../src/modules/hosts/dispatchOptions.js";

// Real-Postgres coverage for what a dispatch can choose from on a host: the
// backend list and its usability are decided here, not reconstructed in the
// browser. These cases used to live in the composer's tests.

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOLDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CLAUDE_PROVIDER = "11111111-1111-4111-8111-111111111111";
const OPENAI_PROVIDER = "22222222-2222-4222-8222-222222222222";
const TASK = "bbbb2222-2222-4222-8222-222222222222";
const OWNER_TOKEN = "owner-session";

let app: FastifyInstance | undefined;
let hostId = "";
let locationId = "";
const db = useTestDatabase(import.meta.filename);

function stubAuth(): AuthRepository {
  const user: CurrentUser = { id: OWNER, email: "owner@example.test", display_name: "Owner", avatar_url: null, is_instance_admin: false, created_at: new Date().toISOString(), last_login_at: null };
  return {
    async getCurrentUser(sessionToken?: string) {
      return sessionToken === OWNER_TOKEN ? user : { statusCode: 401, detail: "Not authenticated" };
    },
  } as unknown as AuthRepository;
}

const CAPABILITIES = {
  runtimes: ["claude", "opencode", "git"],
  installations: {
    claude_code: [
      { id: "own", version: "2.1.0", logged_in: true, options: { models: [{ value: "claude-fable-5[1m]", name: "Fable", description: null }, { value: "sonnet", name: "Sonnet", description: null }], current_model: "claude-fable-5[1m]", efforts: [{ value: "high", name: "high", description: null }, { value: "max", name: "max", description: null }], current_effort: "high" } },
      { id: "managed:0.70.0", version: "0.70.0", logged_in: false, options: null },
    ],
    opencode: [{ id: "own", version: "1.18.11", logged_in: true, options: { models: [{ value: "opencode/big-pickle", name: "Big Pickle", description: null }], current_model: "opencode/big-pickle", efforts: [], current_effort: null } }],
  },
};

async function options(query: string): Promise<DispatchOptions> {
  const response = await app!.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/dispatch-options${query}` });
  expect(response.statusCode).toBe(200);
  return response.json() as DispatchOptions;
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [hostsModule]);
});

const MACHINE = "99999999-9999-4999-8999-999999999999";

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["host_runtime_provider_bindings", "host_thread_messages", "host_task_threads", "tasks", "workspace_locations", "project_folders", "projects", "model_provider_space_grants", "model_providers", "hosts", "machines", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, email, display_name, status, created_at, updated_at) VALUES ($1, 'owner@example.test', 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, OWNER, now]);
  await db.pool.query(`INSERT INTO machines (id, owner_user_id, display_name, created_at, updated_at) VALUES ($1,$2,'Laptop',$3,$3)`, [MACHINE, OWNER, now]);
  hostId = randomUUID();
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, environment_kind, name, kind, status, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'linux_native','Laptop','remote','online',$4::jsonb,$5,$5)`,
    [hostId, OWNER, MACHINE, JSON.stringify(CAPABILITIES), now],
  );
  __setAuthRepositoryForTests(stubAuth());
  __setAuthIdentityForTests({ userId: OWNER, spaceId: SPACE });

  const providers = [
    [CLAUDE_PROVIDER, "MiniMax", { claude_compatible_base_url: "https://api.minimaxi.com/anthropic" }, "MiniMax-M3", ["MiniMax-M3", "MiniMax-M2"]],
    [OPENAI_PROVIDER, "DeepSeek", { openai_compatible_base_url: "https://api.deepseek.com/v1" }, "deepseek-chat", []],
  ] as const;
  for (const [id, name, config, defaultModel, models] of providers) {
    await db.pool.query(
      `INSERT INTO model_providers (id, space_id, owner_user_id, name, provider_type, enabled, default_model, capabilities_json, config_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'custom',true,$5,$6::jsonb,$7::jsonb,$8,$8)`,
      [id, SPACE, OWNER, name, defaultModel, JSON.stringify({ models }), JSON.stringify(config), now],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (id, space_id, provider_id, granted_by_user_id, enabled, is_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4,true,false,$5,$5)`,
      [randomUUID(), SPACE, id, OWNER, now],
    );
  }

  await db.pool.query(`INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Work','active',$4,$4)`, [PROJECT, SPACE, OWNER, now]);
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
     VALUES ($1,$2,$3,'repo','code','active',false,false,$4,$4)`,
    [FOLDER, SPACE, PROJECT, now],
  );
  locationId = randomUUID();
  await db.pool.query(
    `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       display_path, preferred, execution_ready, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'remote','/home/u/repo',true,true,'active',$5,$5)`,
    [locationId, SPACE, FOLDER, hostId, now],
  );
  await db.pool.query(
    `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status, task_role, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Do the thing','ready','source',$5,$6,$6)`,
    [TASK, SPACE, PROJECT, FOLDER, OWNER, now],
  );
});

afterEach(() => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
});

afterAll(async () => {
  await app?.close();
});

describe("dispatch options", () => {
  it("lists the host's copies, defaults to the machine's own copy, and names what the host default stands for", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const result = await options("?adapter_type=claude_code");
    expect(result.adapters.map((a) => a.adapter_type)).toEqual(["claude_code", "opencode"]);
    expect(result).toMatchObject({ adapter_type: "claude_code", installation: "own" });
    const ids = result.backends.map((b) => b.id);
    // Claude takes Claude-compatible providers only; the OpenAI-only one is not offered.
    expect(ids).toEqual(["inherit", "ambient", CLAUDE_PROVIDER]);
    expect(result.backends[0]).toMatchObject({
      label: "This host's default · this machine's login · Fable · high", usable: true, resolves_to: "ambient",
      current_model: "claude-fable-5[1m]", current_effort: "high",
    });
    expect(result.backends[0].efforts.map((e) => e.value)).toEqual(["high", "max"]);
    expect(result.backends[2]).toMatchObject({ label: "MiniMax", current_model: "MiniMax-M3" });
    expect(result.backends[2].models.map((m) => m.value)).toEqual(["MiniMax-M3", "MiniMax-M2"]);
  });

  it("offers the host default's provider and its models when one is bound", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await new PgHostRuntimeProviderBindingRepository(db.pool).upsert({ hostId, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: "MiniMax-M2", createdByUserId: OWNER });
    const result = await options("?adapter_type=claude_code");
    expect(result.backends[0]).toMatchObject({ label: "This host's default · MiniMax · MiniMax-M2", usable: true, resolves_to: CLAUDE_PROVIDER, current_model: "MiniMax-M2" });
  });

  it("makes an unlogged copy's own login unusable — and the host default with it when that is what it stands for", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const result = await options("?adapter_type=claude_code&installation=managed:0.70.0");
    expect(result.installation).toBe("managed:0.70.0");
    expect(result.backends[1]).toMatchObject({ id: "ambient", usable: false, reason: expect.stringMatching(/managed:0.70.0 copy is not logged in/) });
    expect(result.backends[0]).toMatchObject({ id: "inherit", usable: false, resolves_to: "ambient" });
    expect(result.backends[2]).toMatchObject({ id: CLAUDE_PROVIDER, usable: true });
  });

  it("follows a thread's pin and names the conversation's own backend", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const thread = await new PgHostTaskThreadRepository(db.pool).create({ workspaceLocationId: locationId, adapterType: "opencode", runtimeInstallation: "own", createdByUserId: OWNER });
    await new PgHostThreadMessageRepository(db.pool).enqueue(thread.id, TASK, "hi", OWNER, { provider_id: OPENAI_PROVIDER, model: "deepseek-chat" });
    // The query's adapter is ignored: the thread decides.
    const result = await options(`?adapter_type=claude_code&thread_id=${thread.id}`);
    expect(result).toMatchObject({ adapter_type: "opencode", installation: "own" });
    expect(result.backends[0]).toMatchObject({ id: "inherit", label: "Keep this conversation's backend · DeepSeek · deepseek-chat", resolves_to: OPENAI_PROVIDER, usable: true });
    // OpenCode takes OpenAI-compatible providers only.
    expect(result.backends.map((b) => b.id)).toEqual(["inherit", "ambient", OPENAI_PROVIDER]);
  });

  it("offers no providers to a runtime that takes none, and nothing for a runtime the host lacks", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const missing = await options("?adapter_type=codex_cli");
    expect(missing.backends).toEqual([]);
    expect(missing.installation).toBeNull();
  });
});
