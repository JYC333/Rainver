import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { getDbPool } from "../src/db/pool";
import { CliCredentialBroker } from "../src/modules/providers/cli/credentialBroker";

vi.mock("../src/db/pool", () => ({
  getDbPool: vi.fn(),
}));

let tempDir: string | undefined;

afterEach(async () => {
  vi.clearAllMocks();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("CLI credential login-state detection", () => {
  it("uses the runtime credential file rather than directory non-emptiness", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-cli-state-"));
    const cacheOnlyPath = join(tempDir, "codex-cache-only");
    const loggedInPath = join(tempDir, "codex-logged-in");
    await mkdir(join(cacheOnlyPath, "log"), { recursive: true });
    await writeFile(join(cacheOnlyPath, "config.toml"), "model = \"gpt-5\"\n");
    await writeFile(join(cacheOnlyPath, "log", "codex-login.log"), "not a token\n");
    await mkdir(loggedInPath, { recursive: true });
    await writeFile(join(loggedInPath, "auth.json"), "{\"token\":\"present\"}\n");

    const rows = [
      {
        id: "profile-cache-only",
        owner_user_id: "user-1",
        runtime: "codex_cli",
        name: "cache-only",
        source_path: cacheOnlyPath,
        target_path: "/home/agent/.codex",
        readonly: false,
        notes: "",
        grant_id: "grant-cache-only",
        grant_enabled: true,
        is_default: true,
        network_profile_id: null,
        manageable: true,
      },
      {
        id: "profile-logged-in",
        owner_user_id: "user-1",
        runtime: "codex_cli",
        name: "logged-in",
        source_path: loggedInPath,
        target_path: "/home/agent/.codex",
        readonly: false,
        notes: "",
        grant_id: "grant-logged-in",
        grant_enabled: true,
        is_default: false,
        network_profile_id: null,
        manageable: true,
      },
      {
        id: "profile-other-user",
        owner_user_id: "user-2",
        runtime: "codex_cli",
        name: "other-user",
        source_path: loggedInPath,
        target_path: "/home/agent/.codex",
        readonly: false,
        notes: "",
        grant_id: "grant-other-user",
        grant_enabled: true,
        is_default: true,
        network_profile_id: null,
        manageable: false,
      },
    ];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("FROM cli_credential_space_grants") && sql.includes("JOIN cli_credential_profiles")) {
        const profileId = params[2];
        const requestedOwner = profileId ? params[3] : params[1];
        const visibleRows = requestedOwner
          ? rows.filter(row => row.owner_user_id === requestedOwner)
          : rows;
        return {
          rows: profileId ? visibleRows.filter(row => row.id === profileId) : visibleRows,
          rowCount: profileId
            ? visibleRows.filter(row => row.id === profileId).length
            : visibleRows.length,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);

    const broker = new CliCredentialBroker(
      loadConfig({
        AGENT_SPACE_HOME: tempDir,
        SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
      }),
    );

    const available = await broker.availableProfiles("space-1", "user-1", "codex_cli");
    expect(available.find(row => row.id === "profile-cache-only")).toMatchObject({
      file_count: 2,
      logged_in: false,
    });
    expect(available.find(row => row.id === "profile-logged-in")).toMatchObject({
      logged_in: true,
    });
    expect(available.find(row => row.id === "profile-other-user")).toBeUndefined();

    const status = await broker.status("space-1", "user-1");
    expect(status.find(row => row.runtime === "codex_cli")).toMatchObject({
      profile_id: "profile-logged-in",
      logged_in: true,
    });

    await expect(
      broker.resolveProfile("codex_cli", "profile-cache-only", true, "space-1", "user-1"),
    ).resolves.toBeNull();
    await expect(
      broker.resolveProfile("codex_cli", "profile-logged-in", true, "space-1", "user-1"),
    ).resolves.toMatchObject({ id: "profile-logged-in" });
    await expect(
      broker.resolveProfile("codex_cli", "profile-other-user", true, "space-1", "user-1"),
    ).resolves.toBeNull();
    await expect(
      broker.sendLoginInput(
        "codex_cli",
        "secret",
        "space-1",
        "user-1",
        "profile-other-user",
      ),
    ).resolves.toBe(false);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("g.owner_user_id = $2")
      && String(sql).includes("p.owner_user_id = $2")
    )).toBe(true);
  });

  it("enumerates every logged-in user profile for background quota refresh", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-cli-refresh-targets-"));
    const profileOne = join(tempDir, "profile-one");
    const profileTwo = join(tempDir, "profile-two");
    const loggedOut = join(tempDir, "logged-out");
    for (const path of [profileOne, profileTwo, loggedOut]) {
      await mkdir(path, { recursive: true });
    }
    await writeFile(join(profileOne, "auth.json"), "{\"token\":\"one\"}\n");
    await writeFile(join(profileTwo, "auth.json"), "{\"token\":\"two\"}\n");

    const query = vi.fn(async () => ({
      rows: [
        {
          profile_id: "profile-1",
          space_id: "space-1",
          owner_user_id: "user-1",
          source_path: profileOne,
        },
        {
          profile_id: "profile-2",
          space_id: "space-2",
          owner_user_id: "user-2",
          source_path: profileTwo,
        },
        {
          profile_id: "profile-3",
          space_id: "space-3",
          owner_user_id: "user-3",
          source_path: loggedOut,
        },
      ],
      rowCount: 3,
    }));
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    const broker = new CliCredentialBroker(
      loadConfig({
        AGENT_SPACE_HOME: tempDir,
        SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
      }),
    );

    await expect(broker.listQuotaRefreshTargets("codex_cli")).resolves.toEqual([
      { profile_id: "profile-1", space_id: "space-1", owner_user_id: "user-1" },
      { profile_id: "profile-2", space_id: "space-2", owner_user_id: "user-2" },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("DISTINCT ON (p.id)"), [
      "codex_cli",
    ]);
  });
});
