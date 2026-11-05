import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";
import { executeRemoteHostCliAdapter, NO_PROVIDER_BINDINGS } from "../src/modules/runs/remoteHostCliAdapter.js";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";
import { ordinaryAccountKey } from "../src/modules/hosts/ordinaryToolAccountRoutes.js";
import { loadConfig } from "../src/config.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

// The adapter's boundary for ordinary CLI tools: what reaches the launch
// frame depends on the Host read in `ordinaryToolsForLaunch`. The database is
// a scripted Queryable, as in `remoteHostCliAdapter.test.ts`; nothing durable
// is involved (the DB-backed decision itself is `ordinaryToolLaunchDb.test.ts`).

const ORDINARY_HOST_READ = "SELECT kind, owner_user_id, capabilities_json FROM hosts";
const OWNER = "user-1";

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1", space_id: "space-1", agent_id: "agent-1", agent_version_id: "agent-version-1",
    execution_kind: "agent", status: "queued", mode: "live", prompt: "read my calendar", instruction: null,
    project_folder_id: "folder-1", session_id: null, project_id: null, runtime_key: "opencode",
    model_provider_id: null, required_sandbox_level: "none", trigger_origin: "manual",
    instructed_by_user_id: OWNER, owner_user_id: OWNER, started_at: null, ended_at: null,
    ...overrides,
  } as AgentRunRecord;
}

class FakeSink implements HostFrameSink {
  sent: Record<string, unknown>[] = [];
  send(frame: Record<string, unknown>): void { this.sent.push(frame); }
  close(): void {}
}

const CURRENT = {
  ordinary_tools: { protocol: "ordinary-tools-v1", tools: [{ tool_id: "lark_cli", status: "available", source: "managed", version: "1.0.99", version_text: "lark-cli version 1.0.99", managed_version: "1.0.99", registered: false, managed_installable: true, managed_catalog_version: "1.0.99" }] },
  ordinary_tool_accounts: { protocol: "ordinary-tool-accounts-v1", supported: true, reason: null },
  ordinary_tools_runs: { protocol: "ordinary-tools-runs-v1" },
};

/** A trusted paired Host owned by the Run's instructing person; `ordinary` answers the ordinary-tools read. */
function hostDb(ordinary: () => unknown[]): Queryable {
  return {
    async query<Row = Record<string, unknown>>(sql: string) {
      const rows: unknown[] = sql.startsWith(ORDINARY_HOST_READ) ? ordinary()
        : sql.startsWith("SELECT kind FROM hosts") ? [{ kind: "remote" }]
          : sql.startsWith("UPDATE run_attempts") ? [{ id: "attempt-1" }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
}

function start(db: Queryable, registry: HostConnectionRegistry) {
  return executeRemoteHostCliAdapter(
    { run: run(), prompt: "read my calendar", model: null, resume_session_id: null },
    "host-1",
    "folder-1",
    {
      connectionRegistry: registry,
      bindings: NO_PROVIDER_BINDINGS,
      config: loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver", SERVER_INTERNAL_TOKEN: "internal-token" }),
      db,
    },
  );
}

/** Lets a launch go out, returns its frame, then ends the attempt. */
async function launchFrame(db: Queryable) {
  const registry = new HostConnectionRegistry();
  const sink = new FakeSink();
  registry.registerConnection("host-1", sink);
  const execution = start(db, registry);
  await vi.waitUntil(() => sink.sent.some((frame) => frame.type === "launch"));
  const launch = sink.sent.find((frame) => frame.type === "launch")!;
  registry.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: "test ends here" }, String(launch.launch_id));
  await execution;
  return launch;
}

const savedLark = process.env.LARKSUITE_CLI_CONFIG_DIR;
afterEach(() => {
  if (savedLark === undefined) delete process.env.LARKSUITE_CLI_CONFIG_DIR;
  else process.env.LARKSUITE_CLI_CONFIG_DIR = savedLark;
});

describe("ordinary CLI tools on a Run's launch", () => {
  it("does not launch when the Host's ordinary-tools read fails, even with a machine Lark selection around", async () => {
    // The machine has its own lark-cli selection; a launch without the field
    // would leave it to the Run instead of a fresh empty state.
    process.env.LARKSUITE_CLI_CONFIG_DIR = "/home/host-user/.lark-cli";
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const result = await start(hostDb(() => { throw new Error("password authentication failed for user \"server\""); }), registry);
    expect(result).toMatchObject({ success: false, error_code: "ordinary_tools_unavailable" });
    // Says what happened without the database's own words.
    expect(result.error_message).toMatch(/ordinary CLI tools/);
    expect(result.error_message).not.toMatch(/password|authentication|server/);
    expect(sink.sent.some((frame) => frame.type === "launch")).toBe(false);
  });

  it("sends the instructing person's account to a daemon that supports it", async () => {
    const launch = await launchFrame(hostDb(() => [{ kind: "remote", owner_user_id: OWNER, capabilities_json: CURRENT }]));
    expect(launch.ordinary_tools).toEqual({ accounts: [{ tool_id: "lark_cli", account_key: ordinaryAccountKey(OWNER) }] });
  });

  it("sends an empty account list when the Run has nobody to act for", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const execution = executeRemoteHostCliAdapter(
      { run: run({ instructed_by_user_id: null }), prompt: "scheduled", model: null, resume_session_id: null },
      "host-1",
      "folder-1",
      {
        connectionRegistry: registry,
        bindings: NO_PROVIDER_BINDINGS,
        config: loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver", SERVER_INTERNAL_TOKEN: "internal-token" }),
        db: hostDb(() => [{ kind: "remote", owner_user_id: OWNER, capabilities_json: CURRENT }]),
      },
    );
    await vi.waitUntil(() => sink.sent.some((frame) => frame.type === "launch"));
    const launch = sink.sent.find((frame) => frame.type === "launch")!;
    expect(launch.ordinary_tools).toEqual({ accounts: [] });
    registry.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: "test ends here" }, String(launch.launch_id));
    await execution;
  });

  it("still launches an older daemon, read successfully, without the field", async () => {
    const launch = await launchFrame(hostDb(() => [{ kind: "remote", owner_user_id: OWNER, capabilities_json: { runtimes: [], versions: {}, installations: {} } }]));
    expect(launch).not.toHaveProperty("ordinary_tools");
  });
});
