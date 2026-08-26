import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { loadConfig } from "../src/config.js";
import { resolveProvidersDbPort } from "../src/modules/providers/dbReader.js";
import { PgHostRuntimeProviderBindingRepository } from "../src/modules/hosts/runtimeProviderBindingRepository.js";
import {
  resolveHostProviderBinding,
  assertProviderUsable,
  type ProviderLookupPort,
} from "../src/modules/hosts/runtimeProviderBindingResolution.js";
import { HttpError } from "../src/modules/routeUtils/common.js";
import { advanceThreadQueue } from "../src/modules/hosts/queueAdvance.js";
import { PgHostThreadMessageRepository } from "../src/modules/hosts/threadMessageRepository.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { runToOut } from "../src/modules/runs/runReadModel.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import { resolveRunRemoteness } from "../src/modules/runs/runRemoteness.js";
import { ExecutionControlSnapshotRepository } from "../src/modules/policy/executionControlSnapshots.js";
import { hostProviderProxyBaseUrl } from "../src/modules/runs/hostProviderProxyAddress.js";
import {
  buildRemoteProviderBinding,
  resolveRemoteRunBinding,
  RemoteProviderBindingError,
  recordRemoteRunBackend,
  PROFILE_ROOT_PLACEHOLDER,
} from "../src/modules/runs/remoteProviderBinding.js";
import { codexModelCatalog } from "../src/modules/runs/codexProviderConfig.js";
import {
  ProviderProxyLeaseRegistry,
  setProviderProxyBaseUrlForProcess,
} from "../src/modules/providers/proxy/lease.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";

// Real-Postgres coverage for which model backend the control plane picks for a
// host's runtime adapter, and what it refuses. Precedence and validation are
// the whole contract here: execution reads what dispatch decided, so these are
// the assertions that keep a wrong backend from silently becoming a run on
// someone's laptop.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MACHINE = "33333333-3333-4333-8333-333333333333";
const HOST = "44444444-4444-4444-8444-444444444444";
const PROJECT = "77777777-7777-4777-8777-777777777777";
const FOLDER = "88888888-8888-4888-8888-888888888888";
const LOCATION = "99999999-9999-4999-8999-999999999999";
const THREAD = "aaaa1111-1111-4111-8111-111111111111";
const TASK = "bbbb2222-2222-4222-8222-222222222222";
const CLAUDE_PROVIDER = "55555555-5555-4555-8555-555555555555";
const OPENAI_PROVIDER = "66666666-6666-4666-8666-666666666666";

let app: FastifyInstance | undefined;
/** Which user the next HTTP request authenticates as. */
let actingUser = OWNER;

const db = useTestDatabase(import.meta.filename);

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

beforeAll(async () => {
  if (!db.available) return;
  __setAuthIdentityForTests(() => ({ spaceId: SPACE, userId: actingUser } as never));
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [hostsModule]);
  await app.listen({ port: 0, host: "127.0.0.1" });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["host_runtime_provider_bindings", "host_thread_messages", "host_task_threads", "runs", "agent_versions", "agents", "tasks", "workspace_locations", "project_folders", "projects", "model_provider_space_grants", "model_providers", "hosts", "machines", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  for (const space of [SPACE, OTHER_SPACE]) {
    await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [space, now]);
  }
  actingUser = OWNER;
  for (const user of [OWNER, STRANGER]) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [user, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [randomUUID(), SPACE, user, user === OWNER ? "owner" : "member", now],
    );
  }
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, created_at, updated_at) VALUES ($1,$2,'Laptop',$3,$3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, environment_kind, name, kind, status, created_at, updated_at)
     VALUES ($1,$2,$3,'linux_native','Laptop','remote','online',$4,$4)`,
    [HOST, OWNER, MACHINE, now],
  );
  // MiniMax is Claude-compatible, DeepSeek OpenAI-compatible — the compatible
  // base URLs live in `config_json`, which is where `dbReader` reads them.
  const providers = [
    [CLAUDE_PROVIDER, "MiniMax", { claude_compatible_base_url: "https://api.minimaxi.com/anthropic" }],
    [OPENAI_PROVIDER, "DeepSeek", { openai_compatible_base_url: "https://api.deepseek.com/v1" }],
  ] as const;
  for (const [id, name, config] of providers) {
    await db.pool.query(
      `INSERT INTO model_providers (id, space_id, owner_user_id, name, provider_type, enabled, capabilities_json, config_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'custom',true,'{}'::jsonb,$5::jsonb,$6,$6)`,
      [id, SPACE, OWNER, name, JSON.stringify(config), now],
    );
    // A provider is only reachable through a grant; without this row the real
    // read port returns null, which is the point of using it here.
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (id, space_id, provider_id, granted_by_user_id, enabled, is_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4,true,false,$5,$5)`,
      [randomUUID(), SPACE, id, OWNER, now],
    );
  }
});

function repo(): PgHostRuntimeProviderBindingRepository {
  return new PgHostRuntimeProviderBindingRepository(db.pool);
}

/**
 * The **real** providers read port, against the same database. Using a fake
 * here would mean the Space-grant assertions below pass because a stub said
 * so; what has to hold is the actual predicate in `dbReader.getProvider` —
 * enabled grant, enabled provider, and the `subscription_oauth` exclusion the
 * resolution code deliberately relies on.
 */
function providerPort(): ProviderLookupPort {
  const port = resolveProvidersDbPort(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
  if (!port) throw new Error("providers read port unavailable");
  return port;
}

async function resolve(input: {
  adapterType?: string;
  override?: { model_provider_id?: unknown; model?: string | null; reasoning_effort?: string | null };
  overrideProvided?: boolean;
  modelOverrideProvided?: boolean;
  spaceId?: string;
  providers?: ProviderLookupPort | null;
}) {
  return resolveHostProviderBinding({
    db: db.pool,
    providers: input.providers === undefined ? providerPort() : input.providers,
    spaceId: input.spaceId ?? SPACE,
    hostId: HOST,
    adapterType: input.adapterType ?? "claude_code",
    override: input.override ?? {},
    overrideProvided: input.overrideProvided ?? false,
    modelOverrideProvided: input.modelOverrideProvided ?? false,
  });
}


function httpBaseUrl(): string {
  const address = app!.server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening on a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${httpBaseUrl()}${path}`, {
    method,
    headers: { "content-type": "application/json", "X-Agent-Space-Id": SPACE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const BINDINGS = `/api/v1/hosts/${HOST}/runtime-provider-bindings`;

describe("host runtime provider binding", () => {
  it("defaults to ambient login when the host has no binding", async () => {
    if (!db.available) return;
    await expect(resolve({})).resolves.toEqual({ provider_id: null, model: null, reasoning_effort: null });
  });

  it("resolves the host default for the adapter, and only that adapter", async () => {
    if (!db.available) return;
    await repo().upsert({
      hostId: HOST,
      adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER,
      model: "MiniMax-M2",
      createdByUserId: OWNER,
    });

    await expect(resolve({ adapterType: "claude_code" })).resolves.toEqual({
      provider_id: CLAUDE_PROVIDER,
      model: "MiniMax-M2",
      reasoning_effort: null,
    });
    // A binding is per adapter: codex on the same host is untouched.
    await expect(resolve({ adapterType: "codex_cli" })).resolves.toEqual({ provider_id: null, model: null, reasoning_effort: null });
  });

  it("lets a dispatch override the host default, including back to ambient login", async () => {
    if (!db.available) return;
    await repo().upsert({
      hostId: HOST,
      adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER,
      model: "MiniMax-M2",
      createdByUserId: OWNER,
    });

    // An explicit null is a choice, not an absent field — one dispatch on the
    // machine's own login despite the host default.
    await expect(resolve({
      override: { model_provider_id: null },
      overrideProvided: true,
    })).resolves.toEqual({ provider_id: null, model: null, reasoning_effort: null });

    // And an explicit model narrows the same provider for one dispatch.
    await expect(resolve({
      override: { model_provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2.1" },
      overrideProvided: true,
    })).resolves.toEqual({ provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2.1", reasoning_effort: null });
  });

  it("refuses a provider that cannot serve the adapter's protocol", async () => {
    if (!db.available) return;
    // DeepSeek is configured OpenAI-compatible only; claude_code needs a
    // Claude-compatible URL. Caught at dispatch, not on the host.
    await expect(resolve({
      adapterType: "claude_code",
      override: { model_provider_id: OPENAI_PROVIDER },
      overrideProvided: true,
    })).rejects.toMatchObject({ statusCode: 422 });

    await expect(resolve({
      adapterType: "codex_cli",
      override: { model_provider_id: OPENAI_PROVIDER },
      overrideProvided: true,
    })).resolves.toEqual({ provider_id: OPENAI_PROVIDER, model: null, reasoning_effort: null });
  });

  it("refuses a provider whose Space grant has been disabled", async () => {
    if (!db.available) return;
    await repo().upsert({
      hostId: HOST,
      adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER,
      model: null,
      createdByUserId: OWNER,
    });
    // Removing a provider through the product is a soft delete: the grant is
    // disabled and the binding row survives. Dispatch must fail loudly, and
    // name the host default as the cause, rather than quietly running on the
    // machine's own login.
    await db.pool.query(`UPDATE model_provider_space_grants SET enabled = false WHERE provider_id = $1`, [CLAUDE_PROVIDER]);
    await expect(resolve({})).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("host's configured model backend"),
    });
    // The binding itself is untouched — it is still what the user chose, and
    // still visible for them to change.
    await expect(repo().listForHost(HOST)).resolves.toHaveLength(1);
  });

  it("refuses a disabled provider even when the grant is still enabled", async () => {
    if (!db.available) return;
    await db.pool.query(`UPDATE model_providers SET enabled = false WHERE id = $1`, [CLAUDE_PROVIDER]);
    await expect(resolve({
      override: { model_provider_id: CLAUDE_PROVIDER },
      overrideProvided: true,
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a malformed provider id instead of falling back to ambient login", async () => {
    if (!db.available) return;
    for (const bad of ["", "   ", 42, {}]) {
      await expect(resolve({
        override: { model_provider_id: bad },
        overrideProvided: true,
      })).rejects.toMatchObject({ statusCode: 422 });
    }
  });

  it("lets a model-only override narrow the host default's model", async () => {
    if (!db.available) return;
    await repo().upsert({
      hostId: HOST,
      adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER,
      model: "MiniMax-M2",
      createdByUserId: OWNER,
    });
    await expect(resolve({
      override: { model: "MiniMax-M2.1" },
      modelOverrideProvided: true,
    })).resolves.toEqual({ provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2.1", reasoning_effort: null });
  });

  it("carries a dispatch's reasoning_effort through with the provider it overrides", async () => {
    if (!db.available) return;
    await expect(resolve({
      override: { model_provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2.1", reasoning_effort: "high" },
      overrideProvided: true,
      modelOverrideProvided: true,
    })).resolves.toEqual({ provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2.1", reasoning_effort: "high" });
  });

  it("refuses a provider that is not reachable from the dispatching Space", async () => {
    if (!db.available) return;
    await repo().upsert({
      hostId: HOST,
      adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER,
      model: null,
      createdByUserId: OWNER,
    });
    // The binding is keyed by host and adapter only, so a dispatch from a
    // Space the provider was never granted to must fail loudly rather than
    // fall back to ambient login.
    await expect(resolve({ spaceId: OTHER_SPACE })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses rather than silently unbinding when the providers port is unavailable", async () => {
    if (!db.available) return;
    await repo().upsert({
      hostId: HOST,
      adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER,
      model: null,
      createdByUserId: OWNER,
    });
    await expect(resolve({ providers: null })).rejects.toMatchObject({ statusCode: 503 });
    // With no binding there is nothing to validate, so the same outage does
    // not block an ambient-login dispatch.
    await repo().clear(HOST, "claude_code");
    await expect(resolve({ providers: null })).resolves.toEqual({ provider_id: null, model: null, reasoning_effort: null });
  });

  it("rejects an adapter that has no provider binding shape at all", async () => {
    if (!db.available) return;
    await expect(assertProviderUsable({
      providers: providerPort(),
      spaceId: SPACE,
      adapterType: "model_api",
      providerId: CLAUDE_PROVIDER,
    })).rejects.toBeInstanceOf(HttpError);
  });

  it("keeps one default per host and adapter, replacing on re-set", async () => {
    if (!db.available) return;
    await repo().upsert({ hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: "a", createdByUserId: OWNER });
    await repo().upsert({ hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: "b", createdByUserId: OWNER });

    const bindings = await repo().listForHost(HOST);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.model).toBe("b");

    expect(await repo().clear(HOST, "claude_code")).toBe(true);
    expect(await repo().clear(HOST, "claude_code")).toBe(false);
    await expect(repo().listForHost(HOST)).resolves.toEqual([]);
  });

  it("drops a host's bindings when its provider is deleted, rather than stranding them", async () => {
    if (!db.available) return;
    await repo().upsert({ hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER });
    await db.pool.query(`DELETE FROM model_providers WHERE id = $1`, [CLAUDE_PROVIDER]);
    // The cascade is a referential backstop for a hard delete. Product removal
    // is a soft delete, covered by the disabled-grant case above.
    await expect(repo().listForHost(HOST)).resolves.toEqual([]);
  });

  it("drops bindings with the host they belong to", async () => {
    if (!db.available) return;
    await repo().upsert({ hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER });
    await db.pool.query(`DELETE FROM hosts WHERE id = $1`, [HOST]);
    await expect(repo().listForHost(HOST)).resolves.toEqual([]);
  });
});

describe("host runtime provider binding routes", () => {
  it("sets, lists, and clears a binding for a host the caller owns", async () => {
    if (!db.available) return;
    const set = await api("PUT", `${BINDINGS}/claude_code`, { model_provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2" });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({
      host_id: HOST,
      adapter_type: "claude_code",
      model_provider_id: CLAUDE_PROVIDER,
      model: "MiniMax-M2",
    });

    const listed = await api("GET", BINDINGS);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { items: unknown[] }).items).toHaveLength(1);

    expect((await api("DELETE", `${BINDINGS}/claude_code`)).status).toBe(204);
    expect((await api("DELETE", `${BINDINGS}/claude_code`)).status).toBe(404);
    expect((await (await api("GET", BINDINGS)).json() as { items: unknown[] }).items).toEqual([]);
  });

  it("hides another user's host behind 404 on every verb (B63)", async () => {
    if (!db.available) return;
    // A Space member who does not own the host must not be able to read its
    // configuration, change what it runs against, or learn that it exists —
    // hence 404 rather than 403, matching revoke.
    actingUser = STRANGER;
    expect((await api("GET", BINDINGS)).status).toBe(404);
    expect((await api("PUT", `${BINDINGS}/claude_code`, { model_provider_id: CLAUDE_PROVIDER })).status).toBe(404);
    expect((await api("DELETE", `${BINDINGS}/claude_code`)).status).toBe(404);

    actingUser = OWNER;
    await api("PUT", `${BINDINGS}/claude_code`, { model_provider_id: CLAUDE_PROVIDER });
    actingUser = STRANGER;
    // Still 404 after a binding exists: ownership is checked before anything
    // about the binding is read.
    expect((await api("GET", BINDINGS)).status).toBe(404);
  });

  it("answers 404 for a revoked host, so a revoked pairing cannot be reconfigured", async () => {
    if (!db.available) return;
    await db.pool.query(`UPDATE hosts SET status = 'revoked' WHERE id = $1`, [HOST]);
    expect((await api("GET", BINDINGS)).status).toBe(404);
  });

  it("rejects a provider the adapter cannot use, and an adapter that cannot be dispatched remotely", async () => {
    if (!db.available) return;
    const wrongProtocol = await api("PUT", `${BINDINGS}/claude_code`, { model_provider_id: OPENAI_PROVIDER });
    expect(wrongProtocol.status).toBe(422);

    const notRemote = await api("PUT", `${BINDINGS}/model_api`, { model_provider_id: CLAUDE_PROVIDER });
    expect(notRemote.status).toBe(422);

    const missingProvider = await api("PUT", `${BINDINGS}/claude_code`, {});
    expect(missingProvider.status).toBe(422);

    // Nothing was stored by any of the three.
    expect((await (await api("GET", BINDINGS)).json() as { items: unknown[] }).items).toEqual([]);
  });
});

/**
 * Everything `advanceThreadQueue` needs to turn a queued message into a Run:
 * a Project, a Folder with a remote Location on this Host, a Task, and a
 * thread pinned to that Location.
 */
async function seedDispatchableThread(): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Work','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
     VALUES ($1,$2,$3,'repo','code','active',false,false,$4,$4)`,
    [FOLDER, SPACE, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       display_path, preferred, execution_ready, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'remote','/home/u/repo',true,true,'active',$5,$5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
  await db.pool.query(
    `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status, task_role,
       created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Do the thing','ready','source',$5,$6,$6)`,
    [TASK, SPACE, PROJECT, FOLDER, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO host_task_threads (id, workspace_location_id, adapter_type, status, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,'claude_code','active',$3,$4,$4)`,
    [THREAD, LOCATION, OWNER, now],
  );
  // The capability probe is rechecked when the queue advances, not only at
  // dispatch, so the host has to still report the runtime here.
  await db.pool.query(
    `UPDATE hosts SET capabilities_json = '{"runtimes":["claude"]}'::jsonb, last_heartbeat_at = now() WHERE id = $1`,
    [HOST],
  );
}

describe("binding carried onto the Run", () => {
  it("stamps the message's resolved binding onto the Run the queue creates", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(
      THREAD, TASK, "go", OWNER,
      { provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2" },
    );

    const result = await advanceThreadQueue(db.pool, THREAD);
    expect(result.advanced).toBe(true);

    const run = await db.pool.query<{ model_provider_id: string | null; model_override_json: { model?: string; source?: string } | null }>(
      `SELECT model_provider_id, model_override_json FROM runs WHERE host_task_thread_id = $1`,
      [THREAD],
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]?.model_provider_id).toBe(CLAUDE_PROVIDER);
    // `source` matters: without it the Run read model normalizes to "none" and
    // shows a chosen model with no provenance.
    expect(run.rows[0]?.model_override_json).toEqual({ model: "MiniMax-M2", source: "request" });

    // The control plane records the binding, but nothing on the trusted-host
    // path injects it yet, so the read model must not tell a reader the
    // adapter used it — that is the "recorded provider is a lie" failure B67
    // exists to prevent, and the read model is what a person sees.
    const full = await db.pool.query<RunRecord>(
      `SELECT * FROM runs WHERE host_task_thread_id = $1`, [THREAD],
    );
    const view = runToOut(full.rows[0]!).resolved_model as Record<string, unknown>;
    expect(view.provider_id).toBe(CLAUDE_PROVIDER);
    expect(view.model).toBe("MiniMax-M2");
    expect(view.source).toBe("request");
    expect(view.used_by_adapter).toBe(false);
    expect(view.disclosure_note).toContain("remote execution host");
  });

  it("qualifies a remote run whose trust_mode was never set", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    // The failure this guards: only the thread-dispatch path writes
    // `trust_mode`, so an Automation, Room, Workflow or evolution run on a
    // remote-preferred Folder has it null and still executes remotely, with a
    // provider the router stamped and nothing ever injected. Remoteness must
    // come from the Location.
    const runId = randomUUID();
    const now = new Date().toISOString();
    // The system dispatch Agent is created lazily by the queue, so drive one
    // ordinary advance first and reuse its identity for the hand-built run.
    await new PgHostThreadMessageRepository(db.pool).enqueue(THREAD, TASK, "seed", OWNER);
    await advanceThreadQueue(db.pool, THREAD);
    const agent = await db.pool.query<{ id: string; current_version_id: string }>(
      `SELECT id, current_version_id FROM agents WHERE space_id = $1 LIMIT 1`, [SPACE],
    );
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         project_id, project_folder_id, workspace_location_id, adapter_type, required_sandbox_level,
         model_provider_id, model_override_json, owner_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'agent','manual','queued','live',
         $5,$6,$7,'claude_code','none',$8,'{"model":"MiniMax-M2","source":"runtime_profile"}'::jsonb,$9,$10,$10)`,
      [runId, SPACE, agent.rows[0]!.id, agent.rows[0]!.current_version_id,
       PROJECT, FOLDER, LOCATION, CLAUDE_PROVIDER, OWNER, now],
    );
    const row = await db.pool.query<RunRecord>(`SELECT * FROM runs WHERE id = $1`, [runId]);
    expect(row.rows[0]?.trust_mode ?? null).toBeNull();

    // Thread the resolved value rather than hard-coding it, so the resolver
    // and the read model are tested together.
    const remote = await resolveRunRemoteness(db.pool, [row.rows[0]!]);
    expect(remote.has(runId)).toBe(true);
    const view = runToOut(row.rows[0]!, null, { executes_remotely: remote.has(runId) }).resolved_model as Record<string, unknown>;
    expect(view.used_by_adapter).toBe(false);
    expect(view.disclosure_note).toContain("remote execution host");
  });

  it("leaves the Run unbound when the message carried no binding", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(THREAD, TASK, "go", OWNER);

    expect((await advanceThreadQueue(db.pool, THREAD)).advanced).toBe(true);
    const run = await db.pool.query<{ model_provider_id: string | null; model_override_json: unknown }>(
      `SELECT model_provider_id, model_override_json FROM runs WHERE host_task_thread_id = $1`,
      [THREAD],
    );
    expect(run.rows[0]?.model_provider_id).toBeNull();
    expect(run.rows[0]?.model_override_json).toBeNull();
  });

  it("uses the snapshot, not the host default as it stands when the queue advances", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(
      THREAD, TASK, "go", OWNER,
      { provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2" },
    );
    // Someone re-points the host while the message waits its turn. The queued
    // message must run against what it was validated for.
    await repo().upsert({
      hostId: HOST, adapterType: "claude_code",
      modelProviderId: OPENAI_PROVIDER, model: "deepseek-chat", createdByUserId: OWNER,
    });

    expect((await advanceThreadQueue(db.pool, THREAD)).advanced).toBe(true);
    const run = await db.pool.query<{ model_provider_id: string | null }>(
      `SELECT model_provider_id FROM runs WHERE host_task_thread_id = $1`,
      [THREAD],
    );
    expect(run.rows[0]?.model_provider_id).toBe(CLAUDE_PROVIDER);
  });
});

describe("carrying the binding to the executing host", () => {
  const EXTERNAL = "http://control-plane.local:8021";

  function config() {
    return loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
  }

  async function boundRun(): Promise<RunRecord> {
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(
      THREAD, TASK, "go", OWNER,
      { provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2" },
    );
    await advanceThreadQueue(db.pool, THREAD);
    const row = await db.pool.query<RunRecord>(
      `SELECT * FROM runs WHERE host_task_thread_id = $1`, [THREAD],
    );
    return row.rows[0]!;
  }

  it("reads a dispatched run's binding from its message", async () => {
    if (!db.available) return;
    const run = await boundRun();
    await expect(resolveRemoteRunBinding(db.pool, run, HOST, "claude_code")).resolves.toEqual({
      provider_id: CLAUDE_PROVIDER,
      model: "MiniMax-M2",
      origin: "dispatch",
    });
  });

  it("marks where a binding came from, because that decides what an unusable one costs", async () => {
    if (!db.available) return;
    await repo().upsert({
      hostId: HOST, adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER,
    });
    await expect(
      resolveRemoteRunBinding(db.pool, { id: randomUUID() }, HOST, "claude_code"),
    ).resolves.toMatchObject({ origin: "host_default" });

    // A Host is user-scoped and can back Locations in several Spaces, so a
    // host default may name a provider granted in a different one. Failing
    // that run would regress something that used to work on ambient login;
    // a provider the dispatch explicitly asked for still fails.
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(
      THREAD, TASK, "go", OWNER, { provider_id: CLAUDE_PROVIDER, model: null },
    );
    await advanceThreadQueue(db.pool, THREAD);
    const row = await db.pool.query<RunRecord>(
      `SELECT * FROM runs WHERE host_task_thread_id = $1`, [THREAD],
    );
    await expect(
      resolveRemoteRunBinding(db.pool, row.rows[0]!, HOST, "claude_code"),
    ).resolves.toMatchObject({ origin: "dispatch" });
  });

  it("falls back to the host default for a run that never went through dispatch", async () => {
    if (!db.available) return;
    // An Automation, Room, Workflow or evolution run on a remote-preferred
    // Folder has no message. Ignoring the host default there would make the
    // Command Center's per-host setting a lie for every run but one kind.
    await repo().upsert({
      hostId: HOST, adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER, model: "MiniMax-M2", createdByUserId: OWNER,
    });
    await expect(
      resolveRemoteRunBinding(db.pool, { id: randomUUID() }, HOST, "claude_code"),
    ).resolves.toEqual({ provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2", origin: "host_default" });
    // Per adapter, as configured.
    await expect(
      resolveRemoteRunBinding(db.pool, { id: randomUUID() }, HOST, "codex_cli"),
    ).resolves.toBeNull();
  });

  it("honors a dispatch that chose ambient login over the host default", async () => {
    if (!db.available) return;
    await repo().upsert({
      hostId: HOST, adapterType: "claude_code",
      modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER,
    });
    await seedDispatchableThread();
    // The message was resolved at dispatch and deliberately unbound; the host
    // default must not resurrect itself at execution.
    await new PgHostThreadMessageRepository(db.pool).enqueue(THREAD, TASK, "go", OWNER);
    await advanceThreadQueue(db.pool, THREAD);
    const row = await db.pool.query<RunRecord>(
      `SELECT * FROM runs WHERE host_task_thread_id = $1`, [THREAD],
    );
    await expect(
      resolveRemoteRunBinding(db.pool, row.rows[0]!, HOST, "claude_code"),
    ).resolves.toBeNull();
  });

  it("hands the host a lease URL it can reach and a token, never the provider key", async () => {
    if (!db.available) return;
    setProviderProxyBaseUrlForProcess("http://server:8021", EXTERNAL);
    const registry = new ProviderProxyLeaseRegistry();
    const run = await boundRun();

    const binding = await buildRemoteProviderBinding({
      config: config(),
      run,
      hostId: HOST,
      adapterType: "claude_code",
      binding: { provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2", origin: "dispatch" },
      ttlSeconds: 60,
      leaseRegistry: registry,
      db: db.pool,
    });

    expect(binding.frame.env.ANTHROPIC_BASE_URL.startsWith(`${EXTERNAL}/anthropic/`)).toBe(true);
    expect(binding.frame.env.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
    expect(binding.frame.env.ANTHROPIC_MODEL).toBe("MiniMax-M2");
    // Claude has no config file; what it needs is an empty profile so this
    // machine's own login is not visible.
    expect(binding.frame.files).toEqual([]);
    expect(binding.frame.profile_env).toEqual({ HOME: ".", CLAUDE_CONFIG_DIR: ".claude" });
    // Keyed by adapter and provider, never by run. Claude Code keeps its
    // session transcripts inside CLAUDE_CONFIG_DIR, so a per-run profile is
    // deleted along with the conversation the next turn resumes — which made
    // every turn after the first fail with "no conversation found".
    expect(binding.frame.profile_key).toBe(`claude_code/${CLAUDE_PROVIDER}`);
    expect(binding.frame.profile_key).not.toContain(run.id);
    // The upstream key is resolved inside the proxy; nothing here carries it.
    expect(JSON.stringify(binding.frame)).not.toContain("api.minimaxi.com");
    expect(registry.size()).toBe(1);

    binding.revoke();
    expect(registry.size()).toBe(0);
  });

  it("binds the lease to the host, so revoking that host cuts its leases off", async () => {
    if (!db.available) return;
    setProviderProxyBaseUrlForProcess("http://server:8021", EXTERNAL);
    const registry = new ProviderProxyLeaseRegistry();
    const run = await boundRun();
    await buildRemoteProviderBinding({
      config: config(), run, hostId: HOST, adapterType: "claude_code",
      binding: { provider_id: CLAUDE_PROVIDER, model: null, origin: "dispatch" },
      ttlSeconds: 60, leaseRegistry: registry, db: db.pool,
    });

    // Cutting the WebSocket stops new work; the lease is plain HTTP and would
    // otherwise keep spending this space's credential until it expired.
    expect(registry.revokeHost(HOST)).toBe(1);
    expect(registry.size()).toBe(0);
    expect(registry.revokeHost(HOST)).toBe(0);
  });

  it("refuses when this deployment has published no address a host could reach", async () => {
    if (!db.available) return;
    // In-network URL only: the Compose service name a paired machine cannot
    // resolve. Handing that out would fail on the host with no explanation.
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    const registry = new ProviderProxyLeaseRegistry();
    const run = await boundRun();

    await expect(buildRemoteProviderBinding({
      config: config(), run, hostId: HOST, adapterType: "claude_code",
      binding: { provider_id: CLAUDE_PROVIDER, model: null, origin: "dispatch" },
      ttlSeconds: 60, leaseRegistry: registry, db: db.pool,
    })).rejects.toBeInstanceOf(RemoteProviderBindingError);
    // And it does not leave the lease it had already created behind.
    expect(registry.size()).toBe(0);
  });

  it("refuses a provider that cannot serve the adapter, without leaking a lease", async () => {
    if (!db.available) return;
    setProviderProxyBaseUrlForProcess("http://server:8021", EXTERNAL);
    const registry = new ProviderProxyLeaseRegistry();
    const run = await boundRun();

    await expect(buildRemoteProviderBinding({
      config: config(), run, hostId: HOST, adapterType: "claude_code",
      binding: { provider_id: OPENAI_PROVIDER, model: null, origin: "dispatch" },
      ttlSeconds: 60, leaseRegistry: registry, db: db.pool,
    })).rejects.toMatchObject({ code: "claude_compatible_base_url_required" });
    expect(registry.size()).toBe(0);
  });
});

describe("the files a bound host is told to write", () => {
  const EXTERNAL = "http://control-plane.local:8021";

  async function frameFor(adapterType: string, providerId: string) {
    setProviderProxyBaseUrlForProcess("http://server:8021", EXTERNAL);
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(THREAD, TASK, "go", OWNER, { provider_id: providerId, model: "m-1" });
    await advanceThreadQueue(db.pool, THREAD);
    const row = await db.pool.query<RunRecord>(`SELECT * FROM runs WHERE host_task_thread_id = $1`, [THREAD]);
    const built = await buildRemoteProviderBinding({
      config: loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      run: row.rows[0]!, hostId: HOST, adapterType,
      binding: { provider_id: providerId, model: "m-1", origin: "dispatch" },
      ttlSeconds: 60, leaseRegistry: new ProviderProxyLeaseRegistry(), db: db.pool,
    });
    return built.frame;
  }

  it("gives Codex a config that actually references the catalog it also writes", async () => {
    if (!db.available) return;
    const frame = await frameFor("codex_cli", OPENAI_PROVIDER);
    const toml = frame.files.find((f) => f.relative_path === ".codex/config.toml")!.contents;
    const catalogPath = ".codex/model-catalogs/agent-space-provider.json";
    expect(frame.files.some((f) => f.relative_path === catalogPath)).toBe(true);
    // A catalog nothing points at is a catalog Codex never reads, and the
    // model then resolves against its built-in list instead of the provider's.
    expect(toml).toContain("model_catalog_json");
    expect(toml).toContain(`${PROFILE_ROOT_PLACEHOLDER}/${catalogPath}`);
    expect(toml).toContain('wire_api = "responses"');
    // Codex is an OpenAI-compatible binding, so it routes through /openai/.
    expect(toml).toContain(`base_url = "${EXTERNAL}/openai/`);
    expect(frame.profile_env.CODEX_HOME).toBe(".codex");
    expect(frame.profile_key).toBe(`codex_cli/${OPENAI_PROVIDER}`);

    // Byte-for-byte what the server-host path writes for the same inputs. A
    // second implementation here is how the catalog shape silently diverged
    // into something Codex does not read.
    const catalog = JSON.parse(frame.files.find((f) => f.relative_path === catalogPath)!.contents);
    expect(catalog).toEqual(codexModelCatalog("DeepSeek", "m-1", []));
  });

  it("gives OpenCode the npm field that makes a non-registry provider loadable", async () => {
    if (!db.available) return;
    const frame = await frameFor("opencode", OPENAI_PROVIDER);
    const config = JSON.parse(frame.files.find((f) => f.relative_path === "opencode.json")!.contents);
    // Without `npm`, OpenCode has no SDK to load `agent_space_provider` with
    // and falls back to a registry provider — i.e. to ambient credentials.
    expect(config.provider.agent_space_provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.model).toBe("agent_space_provider/m-1");
    expect(frame.profile_env.OPENCODE_CONFIG).toBe("opencode.json");
    expect(frame.profile_key).toBe(`opencode/${OPENAI_PROVIDER}`);
  });

  it("refuses a config-file runtime with no model rather than letting it pick its own", async () => {
    if (!db.available) return;
    setProviderProxyBaseUrlForProcess("http://server:8021", EXTERNAL);
    await db.pool.query(`UPDATE model_providers SET default_model = NULL, capabilities_json = '{}'::jsonb WHERE id = $1`, [OPENAI_PROVIDER]);
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(THREAD, TASK, "go", OWNER, { provider_id: OPENAI_PROVIDER, model: null });
    await advanceThreadQueue(db.pool, THREAD);
    const row = await db.pool.query<RunRecord>(`SELECT * FROM runs WHERE host_task_thread_id = $1`, [THREAD]);
    const registry = new ProviderProxyLeaseRegistry();

    await expect(buildRemoteProviderBinding({
      config: loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      run: row.rows[0]!, hostId: HOST, adapterType: "codex_cli",
      binding: { provider_id: OPENAI_PROVIDER, model: null, origin: "dispatch" },
      ttlSeconds: 60, leaseRegistry: registry, db: db.pool,
    })).rejects.toMatchObject({ code: "codex_model_required" });
    expect(registry.size()).toBe(0);
  });
});

describe("recording what a remote run actually executed against", () => {
  async function runWithOverride(override: Record<string, unknown>): Promise<string> {
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(THREAD, TASK, "go", OWNER);
    await advanceThreadQueue(db.pool, THREAD);
    const row = await db.pool.query<{ id: string }>(
      `SELECT id FROM runs WHERE host_task_thread_id = $1`, [THREAD],
    );
    const runId = row.rows[0]!.id;
    await db.pool.query(
      `UPDATE runs SET model_provider_id = $2, model_override_json = $3::jsonb WHERE id = $1`,
      [runId, OPENAI_PROVIDER, JSON.stringify(override)],
    );
    return runId;
  }

  async function overrideOf(runId: string): Promise<Record<string, unknown> | null> {
    const row = await db.pool.query<{ model_override_json: Record<string, unknown> | null }>(
      `SELECT model_override_json FROM runs WHERE id = $1`, [runId],
    );
    return row.rows[0]?.model_override_json ?? null;
  }

  it("replaces the router's prediction with the provider that ran", async () => {
    if (!db.available) return;
    const runId = await runWithOverride({ model: "routed-model", source: "runtime_profile" });
    await recordRemoteRunBackend(db.pool, runId, { provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2" }, SPACE);

    const row = await db.pool.query<{ model_provider_id: string | null }>(
      `SELECT model_provider_id FROM runs WHERE id = $1`, [runId],
    );
    expect(row.rows[0]?.model_provider_id).toBe(CLAUDE_PROVIDER);
    await expect(overrideOf(runId)).resolves.toEqual({ model: "MiniMax-M2", source: "host_binding" });
  });

  it("marks a bound run even when no model resolved", async () => {
    if (!db.available) return;
    // claude_code binds without a model legitimately. If the marker rode on
    // the model it would vanish here, and the read model would call a provider
    // that genuinely ran a mere routing prediction.
    const runId = await runWithOverride({ model: "routed-model", source: "runtime_profile" });
    await recordRemoteRunBackend(db.pool, runId, { provider_id: CLAUDE_PROVIDER, model: null }, SPACE);
    await expect(overrideOf(runId)).resolves.toMatchObject({ source: "host_binding" });
  });

  it("clears the provider for a run that used the machine's own login", async () => {
    if (!db.available) return;
    const runId = await runWithOverride({ model: "routed-model", source: "runtime_profile" });
    await recordRemoteRunBackend(db.pool, runId, null, SPACE);
    const row = await db.pool.query<{ model_provider_id: string | null }>(
      `SELECT model_provider_id FROM runs WHERE id = $1`, [runId],
    );
    expect(row.rows[0]?.model_provider_id).toBeNull();
    await expect(overrideOf(runId)).resolves.toBeNull();
  });

  it("never destroys the rest of the run's control blob", async () => {
    if (!db.available) return;
    // `model_override_json` also carries `execution_mode`, `chat_turn` and
    // `conversation_runtime`. A Room turn on a remote-preferred Folder reaches
    // this path, and `finalizeChatTurn` re-reads the run from the database
    // afterwards — losing those keys drops the agent's reply silently, and
    // both recovery sweeps filter on `chat_turn`, so nothing could find it.
    const control = {
      execution_mode: "room_conversation.v1",
      chat_turn: { session_id: "s-1", message_id: "m-1" },
      conversation_runtime: { state_key: "k-1" },
      model: "routed-model",
      source: "runtime_profile",
    };
    const bound = await runWithOverride(control);
    await recordRemoteRunBackend(db.pool, bound, { provider_id: CLAUDE_PROVIDER, model: "MiniMax-M2" }, SPACE);
    await expect(overrideOf(bound)).resolves.toEqual({
      ...control, model: "MiniMax-M2", source: "host_binding",
    });

    // A second run on the same seeded thread, taking the unbound branch.
    const unbound = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         project_id, project_folder_id, workspace_location_id, adapter_type, required_sandbox_level,
         model_provider_id, model_override_json, owner_user_id, created_at, updated_at)
       SELECT $1, space_id, agent_id, agent_version_id, 'agent', 'manual', 'queued', 'live',
         project_id, project_folder_id, workspace_location_id, adapter_type, 'none',
         $2, $3::jsonb, owner_user_id, now(), now()
         FROM runs WHERE id = $4`,
      [unbound, OPENAI_PROVIDER, JSON.stringify(control), bound],
    );
    await recordRemoteRunBackend(db.pool, unbound, null, SPACE);
    // Unbound removes only this path's own keys.
    await expect(overrideOf(unbound)).resolves.toEqual({
      execution_mode: "room_conversation.v1",
      chat_turn: { session_id: "s-1", message_id: "m-1" },
      conversation_runtime: { state_key: "k-1" },
    });
  });
});

describe("what counts as executing remotely", () => {
  // A remote Location is not a remote run: `resolveExecutionPort` is
  // adapter-agnostic, but only a local_cli adapter is dispatched to the
  // daemon. Getting this wrong in either direction is a real defect — one way
  // the preflight fails a run for a provider it does use, the other way the
  // Run read model calls a provider unused when it was the one that ran.
  /** Seeds once per test; both runs in a test share the same Location. */
  async function seedOnce(): Promise<RunRecord> {
    const existing = await db.pool.query<RunRecord>(
      `SELECT * FROM runs WHERE host_task_thread_id = $1 LIMIT 1`, [THREAD],
    );
    if (existing.rows[0]) return existing.rows[0];
    await seedDispatchableThread();
    await new PgHostThreadMessageRepository(db.pool).enqueue(THREAD, TASK, "seed", OWNER);
    await advanceThreadQueue(db.pool, THREAD);
    const seeded = await db.pool.query<RunRecord>(
      `SELECT * FROM runs WHERE host_task_thread_id = $1`, [THREAD],
    );
    return seeded.rows[0]!;
  }

  async function runOnRemoteLocation(adapterType: string): Promise<RunRecord> {
    const seed = await seedOnce();
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         project_id, project_folder_id, workspace_location_id, adapter_type, required_sandbox_level,
         model_provider_id, owner_user_id, created_at, updated_at)
       SELECT $1, space_id, agent_id, agent_version_id, 'agent', 'manual', 'queued', 'live',
         project_id, project_folder_id, workspace_location_id, $2, 'none', $3, owner_user_id, now(), now()
         FROM runs WHERE id = $4`,
      [runId, adapterType, CLAUDE_PROVIDER, seed.id],
    );
    const row = await db.pool.query<RunRecord>(`SELECT * FROM runs WHERE id = $1`, [runId]);
    return row.rows[0]!;
  }

  it("counts a local_cli run on a remote Location, and not a managed-API one", async () => {
    if (!db.available) return;
    const cli = await runOnRemoteLocation("claude_code");
    await expect(resolveRunRemoteness(db.pool, [cli])).resolves.toEqual(new Set([cli.id]));

    // Same Location, same recorded provider — but this one executes on the
    // server against exactly that provider, so calling it remote would make
    // the read model deny a provider that was used.
    const managed = await runOnRemoteLocation("model_api");
    await expect(resolveRunRemoteness(db.pool, [managed])).resolves.toEqual(new Set());
  });

  it("does not strip a managed-API run's provider from its execution preflight", async () => {
    if (!db.available) return;
    // The regression this guards: deriving "executes remotely" from the
    // Location alone made this run's preflight throw for a provider it does
    // use, failing a run that used to work.
    const managed = await runOnRemoteLocation("model_api");
    const repository = new ExecutionControlSnapshotRepository(db.pool);
    const policy = { policy: { constraints: {} } } as never;
    await expect(
      repository.createForRun(managed, policy, { executesRemotely: true }),
    ).rejects.toThrow(/resolved model provider/);
    // With the corrected predicate this run is not remote, so its provider
    // stands and the preflight has something to evaluate.
    await expect(
      repository.createForRun(managed, policy, { executesRemotely: false }),
    ).rejects.not.toThrow(/resolved model provider/);
  });
});

describe("where a host reaches the provider proxy", () => {
  it("derives the address from what the daemon reports, so nothing has to be configured", () => {
    // The server cannot guess this: its own in-network hostname is a Compose
    // service name no paired machine can resolve. The daemon already knows the
    // address it connects to, so the proxy's address follows from it.
    expect(hostProviderProxyBaseUrl(
      { daemon_server_url: "http://192.168.1.5:3000" }, 8021,
    )).toBe("http://192.168.1.5:8021");
    // A path on the reported URL is not part of the proxy's address.
    expect(hostProviderProxyBaseUrl(
      { daemon_server_url: "https://space.example.com/api/" }, 8021,
    )).toBe("https://space.example.com:8021");
  });

  it("prefers an explicit per-host override", () => {
    expect(hostProviderProxyBaseUrl(
      { daemon_server_url: "http://192.168.1.5:3000", provider_proxy_base_url: "https://proxy.example.com" },
      8021,
    )).toBe("https://proxy.example.com");
  });

  it("declines to guess when it has nothing to derive from", () => {
    // A daemon that has not reconnected since this field existed, an
    // OS-assigned proxy port, or an unparseable report: the caller falls back
    // to the instance-wide setting rather than inventing an address.
    expect(hostProviderProxyBaseUrl({ daemon_server_url: null }, 8021)).toBeNull();
    expect(hostProviderProxyBaseUrl({ daemon_server_url: "http://192.168.1.5:3000" }, 0)).toBeNull();
    expect(hostProviderProxyBaseUrl({ daemon_server_url: "not a url" }, 8021)).toBeNull();
    expect(hostProviderProxyBaseUrl(null, 8021)).toBeNull();
  });
});

describe("setting a host's proxy address", () => {
  const PROXY_URL = `/api/v1/hosts/${HOST}/provider-proxy-url`;

  it("stores an override and clears it back to derived", async () => {
    if (!db.available) return;
    const set = await api("PUT", PROXY_URL, { base_url: "https://proxy.example.com/" });
    expect(set.status).toBe(200);
    // Trailing slash normalized, so the stored value concatenates cleanly.
    await expect(set.json()).resolves.toMatchObject({ provider_proxy_base_url: "https://proxy.example.com" });

    const cleared = await api("PUT", PROXY_URL, { base_url: "" });
    await expect(cleared.json()).resolves.toMatchObject({ provider_proxy_base_url: null });
  });

  it("refuses a value that is not an absolute http(s) URL", async () => {
    if (!db.available) return;
    for (const bad of ["proxy.example.com", "ftp://proxy.example.com", "not a url"]) {
      expect((await api("PUT", PROXY_URL, { base_url: bad })).status, bad).toBe(422);
    }
  });

  it("hides another user's host behind 404, like every other host setting", async () => {
    if (!db.available) return;
    actingUser = STRANGER;
    expect((await api("PUT", PROXY_URL, { base_url: "https://proxy.example.com" })).status).toBe(404);
  });
});

describe("a thread keeps the backend it started with", () => {
  // Resolution used to re-read the Host x adapter default on every dispatch,
  // so changing that default moved every existing thread on the host onto a
  // new backend — and the vendor session lives inside the new provider's
  // profile, so each of them lost its conversation as well.
  const SECOND_PROVIDER = "cccc3333-3333-4333-8333-333333333333";

  async function dispatch(body: Record<string, unknown>) {
    const repo = new PgTaskRepository(
      db.pool,
      resolveProvidersDbPort(loadConfig({ SERVER_DATABASE_URL: db.connectionUri })),
    );
    // `createTaskRun` returns either a server-host Run or a queued remote
    // message; these dispatches are all remote, so narrow it once here rather
    // than at every call.
    const result = await repo.createTaskRun(
      { spaceId: SPACE, userId: OWNER },
      TASK,
      {
        adapter_type: "claude_code",
        workspace_location_id: LOCATION,
        project_folder_id: FOLDER,
        thread_id: THREAD,
        prompt: "go",
        ...body,
      },
    ) as { message_id?: unknown };
    if (typeof result.message_id !== "string") {
      throw new Error("remote dispatch did not queue a thread message");
    }
    return { message_id: result.message_id };
  }

  async function messageBinding(messageId: string) {
    const row = await db.pool.query<{ model_provider_id: string | null; model: string | null }>(
      `SELECT model_provider_id, model FROM host_thread_messages WHERE id = $1`,
      [messageId],
    );
    return row.rows[0]!;
  }

  /**
   * `createTaskRun` advances the queue itself, but a Run has to reach a
   * terminal state before the next message may advance. Settle it so the
   * following dispatch sees a thread that has actually dispatched something.
   */
  async function settle(messageId: string) {
    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = now()
        WHERE id = (SELECT run_id FROM host_thread_messages WHERE id = $1)`,
      [messageId],
    );
  }

  beforeEach(async () => {
    if (!db.available) return;
    await db.pool.query(
      `INSERT INTO model_providers (id, space_id, owner_user_id, name, provider_type, base_url, default_model,
         enabled, capabilities_json, config_json, created_at, updated_at)
       VALUES ($1,$2,$3,'Second','minimax','https://second.example/anthropic','Second-M1',true,
               '{"models":["Second-M1","Second-M2"]}'::jsonb,
               '{"claude_compatible_base_url":"https://second.example/anthropic"}'::jsonb, now(), now())`,
      [SECOND_PROVIDER, SPACE, OWNER],
    );
    // Without a grant row the real read port returns null — a provider is only
    // reachable through one.
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (id, space_id, provider_id, granted_by_user_id, enabled, is_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4,true,false,now(),now())`,
      [randomUUID(), SPACE, SECOND_PROVIDER, OWNER],
    );
  });

  it("does not move an existing thread when the host default changes", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    const bindings = new PgHostRuntimeProviderBindingRepository(db.pool);
    await bindings.upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER,
    });

    const first = await dispatch({});
    expect((await messageBinding(first.message_id)).model_provider_id).toBe(CLAUDE_PROVIDER);
    await settle(first.message_id);

    // The operator repoints the host at a different backend.
    await bindings.upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: SECOND_PROVIDER, model: null, createdByUserId: OWNER,
    });

    const second = await dispatch({});
    expect((await messageBinding(second.message_id)).model_provider_id).toBe(CLAUDE_PROVIDER);
  });

  it("uses the host default for a thread that has never dispatched", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    await new PgHostRuntimeProviderBindingRepository(db.pool).upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: SECOND_PROVIDER, model: null, createdByUserId: OWNER,
    });
    const queued = await dispatch({});
    expect((await messageBinding(queued.message_id)).model_provider_id).toBe(SECOND_PROVIDER);
  });

  it("honors an explicit override and inherits it next time", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    await new PgHostRuntimeProviderBindingRepository(db.pool).upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER,
    });

    const overridden = await dispatch({ model_provider_id: SECOND_PROVIDER, model: "Second-M1" });
    expect(await messageBinding(overridden.message_id)).toMatchObject({
      model_provider_id: SECOND_PROVIDER,
      model: "Second-M1",
    });
    await settle(overridden.message_id);

    const following = await dispatch({});
    expect(await messageBinding(following.message_id)).toMatchObject({
      model_provider_id: SECOND_PROVIDER,
      model: "Second-M1",
    });
  });

  it("keeps a queued override rather than resolving the next message against the older backend", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    const bindings = new PgHostRuntimeProviderBindingRepository(db.pool);
    await bindings.upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER,
    });

    const first = await dispatch({});
    expect((await messageBinding(first.message_id)).model_provider_id).toBe(CLAUDE_PROVIDER);

    // Sent while the first run is still active: it enqueues rather than
    // dispatching, and its binding is frozen now.
    const override = await dispatch({ model_provider_id: SECOND_PROVIDER });
    expect((await messageBinding(override.message_id)).model_provider_id).toBe(SECOND_PROVIDER);

    // A plain message behind it must land on the override, not on what the
    // thread last *dispatched* — the queue drains FIFO, so resolving against
    // the older backend would run them B then A and flip the thread back.
    const following = await dispatch({});
    expect((await messageBinding(following.message_id)).model_provider_id).toBe(SECOND_PROVIDER);
  });

  it("ignores a withdrawn message when deciding what the thread runs on", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    await new PgHostRuntimeProviderBindingRepository(db.pool).upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER,
    });

    // The first message dispatches and holds the queue, so the override behind
    // it stays queued — which is the only state a message can be withdrawn
    // from (a dispatched one has a run_id and the check constraint forbids it).
    const running = await dispatch({});
    expect((await messageBinding(running.message_id)).model_provider_id).toBe(CLAUDE_PROVIDER);
    const withdrawn = await dispatch({ model_provider_id: SECOND_PROVIDER });
    await db.pool.query(`UPDATE host_thread_messages SET status = 'withdrawn' WHERE id = $1`, [withdrawn.message_id]);

    // A message that will never run is not what the thread runs on.
    const next = await dispatch({});
    expect((await messageBinding(next.message_id)).model_provider_id).toBe(CLAUDE_PROVIDER);
  });

  it("drops a pinned model back to the provider's default when asked", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    await new PgHostRuntimeProviderBindingRepository(db.pool).upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER,
    });

    const pinned = await dispatch({ model_provider_id: SECOND_PROVIDER, model: "Second-M2" });
    expect((await messageBinding(pinned.message_id)).model).toBe("Second-M2");
    await settle(pinned.message_id);

    // `model: null` with no provider key: keep the thread's provider, drop the
    // pin. Coalescing absent and null would make this unexpressible — the
    // thread would keep Second-M2 forever. What it resolves to is the
    // provider's default *as it stands now*, stamped concretely.
    const cleared = await dispatch({ model: null });
    expect(await messageBinding(cleared.message_id)).toMatchObject({
      model_provider_id: SECOND_PROVIDER,
      model: "Second-M1",
    });
  });

  it("stamps a concrete model when the caller took the provider's default", async () => {
    if (!db.available) return;
    // A null model here would be re-read against the provider's `default_model`
    // on every later message, so editing that field would move the model of
    // every thread that never named one — the same drift thread inheritance
    // exists to stop, one level down.
    await seedDispatchableThread();
    await new PgHostRuntimeProviderBindingRepository(db.pool).upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: SECOND_PROVIDER, model: null, createdByUserId: OWNER,
    });

    const first = await dispatch({});
    expect(await messageBinding(first.message_id)).toMatchObject({
      model_provider_id: SECOND_PROVIDER,
      model: "Second-M1",
    });
    await settle(first.message_id);

    // The provider's default changes; the thread does not follow it.
    await db.pool.query(`UPDATE model_providers SET default_model = 'Second-M9' WHERE id = $1`, [SECOND_PROVIDER]);
    const next = await dispatch({});
    expect((await messageBinding(next.message_id)).model).toBe("Second-M1");
  });

  it("validates an inherited provider exactly like an explicit one", async () => {
    if (!db.available) return;
    // B67: a thread whose provider was revoked must fail, never fall through
    // to the executing machine's own login. An implementation that trusted the
    // inherited value because it was valid once would pass every other test
    // here.
    await seedDispatchableThread();
    await new PgHostRuntimeProviderBindingRepository(db.pool).upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: SECOND_PROVIDER, model: null, createdByUserId: OWNER,
    });
    const pinned = await dispatch({});
    expect((await messageBinding(pinned.message_id)).model_provider_id).toBe(SECOND_PROVIDER);
    await settle(pinned.message_id);

    await db.pool.query(`UPDATE model_provider_space_grants SET enabled = false WHERE provider_id = $1`, [SECOND_PROVIDER]);

    await expect(dispatch({})).rejects.toMatchObject({ statusCode: 422 });
    // And the message names the conversation, not the host: changing the
    // host's backend no longer affects an existing thread, so pointing there
    // would be the one remedy that cannot work.
    await expect(dispatch({})).rejects.toThrow(/this conversation has been running on/);
  });

  it("treats an explicit null as a real choice the thread then keeps", async () => {
    if (!db.available) return;
    await seedDispatchableThread();
    await new PgHostRuntimeProviderBindingRepository(db.pool).upsert({
      hostId: HOST, adapterType: "claude_code", modelProviderId: CLAUDE_PROVIDER, model: null, createdByUserId: OWNER,
    });

    const ambient = await dispatch({ model_provider_id: null });
    expect((await messageBinding(ambient.message_id)).model_provider_id).toBeNull();
    await settle(ambient.message_id);

    // Inheriting "the machine's own login" must not fall through to the host
    // default — that is exactly the silent substitution this path forbids.
    const following = await dispatch({});
    expect((await messageBinding(following.message_id)).model_provider_id).toBeNull();
  });
});
