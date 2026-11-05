import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { ordinaryToolsForLaunch } from "../src/modules/runs/ordinaryToolLaunch.js";
import { ordinaryAccountKey } from "../src/modules/hosts/ordinaryToolAccountRoutes.js";
import { RemoteWsCliCommandExecutor } from "../src/modules/runs/remoteHostCliAdapter.js";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";

// Real-Postgres coverage for which personal account a Run's launch names:
// only the Run's instructing person, never another, only on a Host that may
// serve them, and nothing at all for a daemon without the capability.

const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOOLS = {
  protocol: "ordinary-tools-v1",
  tools: [
    { tool_id: "git", status: "available", source: "path", version: "2.43.0", version_text: "git version 2.43.0", managed_version: null, registered: false, managed_installable: false, managed_catalog_version: null },
    { tool_id: "jq", status: "missing", source: null, version: null, version_text: null, managed_version: null, registered: false, managed_installable: false, managed_catalog_version: null },
    { tool_id: "lark_cli", status: "available", source: "managed", version: "1.0.99", version_text: "lark-cli version 1.0.99", managed_version: "1.0.99", registered: false, managed_installable: true, managed_catalog_version: "1.0.99" },
  ],
};
const CURRENT = {
  runtimes: [], versions: {}, installations: {}, ordinary_tools: TOOLS,
  ordinary_tool_accounts: { protocol: "ordinary-tool-accounts-v1", supported: true, reason: null },
  ordinary_tools_runs: { protocol: "ordinary-tools-runs-v1" },
};

const db = useTestDatabase(import.meta.filename);

async function host(id: string, kind: "server" | "remote", capabilities: unknown) {
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES ($1, $2, 'M', $3, now(), now())`,
    [`machine-${id}`, kind === "remote" ? OWNER : null, kind === "server" ? "server" : "desktop"],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, $1, $4, $5, 'online', $6::jsonb, now(), now())`,
    [id, kind === "remote" ? OWNER : null, `machine-${id}`, kind, kind === "server" ? "server" : "linux_native", JSON.stringify(capabilities)],
  );
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["hosts", "machines", "users"], { cascade: true });
  for (const id of [OWNER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source) VALUES ($1, $2, $1, 'active', now(), now(), 'system')`,
      [id, `${id}@example.test`],
    );
  }
});

const launch = (hostId: string, instructedBy: string | null) =>
  ordinaryToolsForLaunch(undefined, hostId, { instructed_by_user_id: instructedBy }, db.pool);

describe("ordinary tools in a Run's launch", () => {
  it("names only the instructing person's account, and only where the Host may serve them", async (ctx) => {
    if (!db.available) return ctx.skip();
    await host("builtin", "server", CURRENT);
    await host("desk", "remote", CURRENT);

    const member = await launch("builtin", OTHER);
    expect(member.field).toEqual({ accounts: [{ tool_id: "lark_cli", account_key: ordinaryAccountKey(OTHER) }] });
    expect(JSON.stringify(member.field)).not.toContain(OTHER);
    expect(member.instruction).toMatch(/git 2\.43\.0, lark-cli 1\.0\.99; not available: jq/);
    expect(member.instruction).toMatch(/person who asked for this work.*Do not switch to the bot identity/s);

    // No instructing person: no account, and nothing chosen in its place.
    const nobody = await launch("builtin", null);
    expect(nobody.field).toEqual({ accounts: [] });
    expect(nobody.instruction).toMatch(/no personal account in this Run/);

    expect((await launch("desk", OWNER)).field).toEqual({ accounts: [{ tool_id: "lark_cli", account_key: ordinaryAccountKey(OWNER) }] });
    // A paired Host is its owner's alone: another person's key never reaches it.
    expect((await launch("desk", OTHER)).field).toEqual({ accounts: [] });
  });

  it("sends nothing to an older daemon and no account where accounts cannot be isolated", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { ordinary_tools_runs: _runs, ...older } = CURRENT;
    await host("old", "remote", older);
    await host("mac", "remote", { ...CURRENT, ordinary_tool_accounts: { protocol: "ordinary-tool-accounts-v1", supported: false, reason: "Keychain" } });
    expect(await launch("old", OWNER)).toEqual({ field: undefined, instruction: null });
    expect((await launch("mac", OWNER)).field).toEqual({ accounts: [] });
    expect(await launch("missing-host", OWNER)).toEqual({ field: undefined, instruction: null });
  });

  it("carries the field onto the launch frame only when there is one", async () => {
    const registry = new HostConnectionRegistry();
    const sent: Array<Record<string, unknown>> = [];
    const sink: HostFrameSink = { send: (frame) => { sent.push(frame as unknown as Record<string, unknown>); }, close() {} };
    registry.registerConnection("host-1", sink);
    const field = { accounts: [{ tool_id: "lark_cli" as const, account_key: "a".repeat(40) }] };
    const args = (ordinary: typeof field | null) => [
      "host-1", "folder-1", registry, null, "own", null, null, undefined, [], [],
      { sandbox_mode: "read_write", egress_profile: "default" }, { mode: "direct" }, null, `launch-${ordinary ? "with" : "without"}`, ordinary,
    ] as ConstructorParameters<typeof RemoteWsCliCommandExecutor>;
    for (const ordinary of [field, null]) {
      const runId = `run-${ordinary ? 1 : 2}`;
      const running = new RemoteWsCliCommandExecutor(...args(ordinary)).runCommand({
        command: ["opencode", "acp"], cwd: null, timeout_seconds: 0, env: {}, run_id: runId, stdin: null,
      });
      await expect.poll(() => sent.filter((frame) => frame.type === "launch").length).toBe(ordinary ? 1 : 2);
      const frame = sent.filter((entry) => entry.type === "launch").at(-1)!;
      if (ordinary) expect(frame.ordinary_tools).toEqual(field);
      else expect("ordinary_tools" in frame).toBe(false);
      registry.receiveComplete("host-1", runId, { exit_code: 0, timed_out: false, error: null } as never, String(frame.launch_id));
      await running;
    }
  });
});
