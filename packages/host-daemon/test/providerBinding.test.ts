import { link as hardLink, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearStateRootEnv, clearVendorCredentialEnv, filterAmbientEnv, helperProcessEnv, materializeProviderBinding, sweepOrphanedRunDirectories } from "../src/providerBinding.js";
import type { ProviderBindingFrame } from "../src/execution.js";

// This machine is a trusted host: its own login state sits in its environment
// and on its disk, right next to the run. These are the assertions that keep
// it out of a run the control plane bound to a specific backend.
//
// The daemon knows nothing about what a Codex or OpenCode config looks like.
// It writes the bytes the server generated. Those shapes are asserted on the
// server, against the builders in `remoteProviderBinding.ts`.

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rainver-binding-"));
  dirs.push(dir);
  return dir;
}

function frame(overrides: Partial<ProviderBindingFrame> = {}): ProviderBindingFrame {
  return {
    profile_key: "agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/conversation/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/claude_code/provider-1",
    env: { ANTHROPIC_BASE_URL: "http://control-plane.local:8021/anthropic/lease-1", ANTHROPIC_AUTH_TOKEN: "lease-token" },
    profile_env: { HOME: ".", CLAUDE_CONFIG_DIR: ".claude" },
    files: [],
    credential_source: "provider_lease",
    login_link: null,
    ...overrides,
  };
}

describe("ambient environment for a bound run", () => {
  it("admits only what a runtime needs from the machine, and nothing that picks a backend", () => {
    const filtered = filterAmbientEnv({
      PATH: "/usr/bin",
      LC_ALL: "C",
      HOME: "/home/someone",
      ANTHROPIC_API_KEY: "sk-machine",
      // Names a vendor-prefix denylist would still pass:
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-from-this-machine",
      XDG_DATA_HOME: "/home/someone/.local/share",
      NODE_OPTIONS: "--require /home/someone/inject.js",
      HTTPS_PROXY: "http://corporate-mitm:3128",
      CODEX_HOME: "/home/someone/.codex",
    });

    expect(filtered).toEqual({ PATH: "/usr/bin", LC_ALL: "C" });
  });

  it("matches Windows' own casing, which an exact allowlist would strip", () => {
    // Windows reports `Path`, not `PATH`. Stripping it would leave a bound run
    // unable to spawn at all, and the key must survive as the OS spells it.
    const filtered = filterAmbientEnv({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      USERPROFILE: "C:\\Users\\someone",
      ANTHROPIC_API_KEY: "sk-machine",
    });
    expect(filtered).toEqual({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
  });
});

describe("materializing a provider binding", () => {
  it("has no credential-byte read capability in the binding module", async () => {
    // This is a channel invariant, not a content assertion: the module may
    // stat and link a credential path, but must not import an API capable of
    // opening or reading the credential bytes before it links them.
    const source = await readFile(new URL("../src/providerBinding.ts", import.meta.url), "utf8");
    const fsPromiseImport = source.match(/import \{([^}]+)\} from "node:fs\/promises";/)?.[1] ?? "";
    expect(fsPromiseImport).not.toMatch(/\b(readFile|open|read|createReadStream)\b/);
    expect(source).not.toMatch(/from "node:fs"/);
  });

  it("writes the server's files and reports the profile paths as environment", async () => {
    const root = join(await tempDir(), "profile");
    const env = await materializeProviderBinding(
      frame({
        profile_env: { HOME: ".", CODEX_HOME: ".codex" },
        files: [
          { relative_path: ".codex/config.toml", contents: 'model = "MiniMax-M2"\n' },
          { relative_path: ".codex/model-catalogs/rainver-provider.json", contents: '{"models":[]}' },
        ],
      }),
      root,
      null,
    );

    expect(env.HOME).toBe(root);
    expect(env.CODEX_HOME).toBe(join(root, ".codex"));
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("lease-token");
    await expect(readFile(join(root, ".codex", "config.toml"), "utf8")).resolves.toContain("MiniMax-M2");
    // Nested paths are created, not assumed.
    await expect(readFile(join(root, ".codex", "model-catalogs", "rainver-provider.json"), "utf8")).resolves.toBe('{"models":[]}');
  });

  it("escapes a substituted profile path for the file it lands in", async () => {
    const root = join(await tempDir(), "profile");
    // A Windows profile root inside a TOML basic string would otherwise be
    // read as escape sequences and the config would not parse.
    await materializeProviderBinding(
      frame({
        files: [
          { relative_path: "config.toml", contents: 'catalog = "{{RAINVER_RUN_PROFILE}}/x.json"', escape: "toml_basic_string" },
          { relative_path: "plain.txt", contents: "{{RAINVER_RUN_PROFILE}}/x.json" },
        ],
      }),
      root,
      null,
    );
    const toml = await readFile(join(root, "config.toml"), "utf8");
    expect(toml).toBe(`catalog = ${JSON.stringify(`${root}/x.json`)}`);
    // Without an `escape`, the raw path is written as-is.
    await expect(readFile(join(root, "plain.txt"), "utf8")).resolves.toBe(`${root}/x.json`);
  });

  it("refuses a file path that would escape the run profile", async () => {
    const dir = await tempDir();
    const root = join(dir, "profile");
    // The daemon runs unsandboxed on a machine the user owns, so a traversing
    // path from the control plane would write anywhere on it.
    for (const relative of ["../escaped.txt", "/etc/passwd", ".codex/../../escaped.txt"]) {
      await expect(
        materializeProviderBinding(frame({ files: [{ relative_path: relative, contents: "x" }] }), root, null),
      ).rejects.toThrow();
      await expect(stat(join(dir, "escaped.txt"))).rejects.toThrow();
    }
  });

  it("keeps what the runtime wrote last turn and refreshes only the server's files", async () => {
    const root = join(await tempDir(), "profile");
    await materializeProviderBinding(
      frame({ files: [{ relative_path: "config.toml", contents: "token = \"lease-1\"" }] }),
      root,
      null,
    );
    // Stands in for a Claude Code session transcript: written by the runtime,
    // not by the binding, and the thing the next turn resumes from. Do not
    // wipe the profile between runs. The next turn would resume a conversation
    // the runtime no longer has.
    await writeFile(join(root, "session.jsonl"), "turn one");

    await materializeProviderBinding(
      frame({ files: [{ relative_path: "config.toml", contents: "token = \"lease-2\"" }] }),
      root,
      null,
    );

    await expect(readFile(join(root, "session.jsonl"), "utf8")).resolves.toBe("turn one");
    // The lease differs per run, so the config the server sends is rewritten.
    await expect(readFile(join(root, "config.toml"), "utf8")).resolves.toContain("lease-2");
  });

  it("fails rather than running with a half-written profile", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "blocker"), "not a directory");
    // No profile at all would mean the machine's own login by another name.
    await expect(
      materializeProviderBinding(frame(), join(dir, "blocker", "profile"), null),
    ).rejects.toThrow();
  });
});

describe("sweeping run directories left behind", () => {
  it("removes an orphaned run directory but leaves an active run's alone", async () => {
    const runsRoot = await tempDir();
    for (const runId of ["dead-run", "live-run"]) {
      await materializeProviderBinding(
        frame({ files: [{ relative_path: "config.toml", contents: "token" }] }),
        join(runsRoot, runId, "profile"),
        null,
      );
    }

    // A daemon killed mid-run leaves a live lease token on disk; nothing else
    // ever removes it, since the same run id never comes back.
    expect(await sweepOrphanedRunDirectories(runsRoot, new Set(["live-run"]))).toBe(1);
    await expect(stat(join(runsRoot, "dead-run", "profile"))).rejects.toThrow();
    await expect(stat(join(runsRoot, "live-run", "profile"))).resolves.toBeDefined();
  });

  it("is silent when there is nothing to sweep", async () => {
    await expect(sweepOrphanedRunDirectories(join(await tempDir(), "missing"), new Set())).resolves.toBe(0);
  });
});

describe("linking this installation's login into an Agent profile", () => {
  // The driving need: a subscription login is what a CLI conversation spends,
  // and a login per Agent × container profile would multiply logins by Agents
  // × Rooms. One login per host × installation, linked into every profile.
  const login = { home_subdir: ".claude", credential_file: ".credentials.json" };

  async function loginHomeWith(credential: string | null): Promise<string> {
    const home = await tempDir();
    if (credential !== null) {
      await mkdir(join(home, login.home_subdir), { recursive: true });
      await writeFile(join(home, login.home_subdir, login.credential_file), credential);
    }
    return home;
  }

  it("links the credential file, never copies it, and reads none of it", async () => {
    const home = await loginHomeWith('{"token":"from-the-machine"}');
    const root = join(await tempDir(), "profile");

    await materializeProviderBinding(frame({ env: {}, files: [], credential_source: "host_login", login_link: login }), root, home);

    const target = join(root, login.home_subdir, login.credential_file);
    // A link, not a copy: ADR 0008 forbids Rainver handling the bytes, and the
    // CLI opening its own file is what keeps it out of our hands.
    const info = await lstat(target);
    expect(info.isSymbolicLink() || info.nlink > 1).toBe(true);
    // The runtime still sees the credential through it.
    await expect(readFile(target, "utf8")).resolves.toBe('{"token":"from-the-machine"}');
  });

  it("creates the profile without a link when this installation has no login", async () => {
    const home = await loginHomeWith(null);
    const root = join(await tempDir(), "profile");

    // The intended behavior, not a failure: the first dispatch surfaces the
    // runtime's own login prompt, which is who should be asking.
    await materializeProviderBinding(frame({ env: {}, files: [], credential_source: "host_login", login_link: login }), root, home);

    await expect(stat(root)).resolves.toBeDefined();
    await expect(lstat(join(root, login.home_subdir, login.credential_file))).rejects.toThrow();
  });

  it("leaves a credential the runtime refreshed into the profile alone", async () => {
    const home = await loginHomeWith('{"token":"shared"}');
    const root = join(await tempDir(), "profile");
    await mkdir(join(root, login.home_subdir), { recursive: true });
    // What a refresh-by-rename leaves behind: a real file, this profile's own.
    await writeFile(join(root, login.home_subdir, login.credential_file), '{"token":"refreshed"}');

    await materializeProviderBinding(frame({ env: {}, files: [], credential_source: "host_login", login_link: login }), root, home);

    await expect(readFile(join(root, login.home_subdir, login.credential_file), "utf8"))
      .resolves.toBe('{"token":"refreshed"}');
  });

  it("links nothing for a provider-bound run", async () => {
    const home = await loginHomeWith('{"token":"from-the-machine"}');
    const root = join(await tempDir(), "profile");

    // A bound run reaches its backend through its lease. Linking the machine's
    // subscription credential into it would put a credential it is not using
    // inside its profile.
    await materializeProviderBinding(frame({ files: [] }), root, home);

    await expect(lstat(join(root, ".claude", ".credentials.json"))).rejects.toThrow();
  });

  it("refuses a login subdirectory that would reach outside the profile", async () => {
    const home = await loginHomeWith('{"token":"x"}');
    const root = join(await tempDir(), "profile");
    await expect(
      materializeProviderBinding(
        frame({ env: {}, files: [], credential_source: "host_login", login_link: { home_subdir: "../..", credential_file: "escaped" } }),
        root,
        home,
      ),
    ).rejects.toThrow();
  });
});

describe("native shared credential storage", () => {
  const login = { home_subdir: ".claude", credential_file: ".credentials.json", shared_credential_env: "CLAUDE_SECURESTORAGE_CONFIG_DIR" };
  const nativeFrame = () => frame({ env: {}, profile_env: { CLAUDE_CONFIG_DIR: ".claude" }, credential_source: "host_login", login_link: login });

  it("shares atomic refresh writes and the refresh lock across isolated sessions", async () => {
    const home = await tempDir();
    const storage = join(home, ".claude");
    await mkdir(storage);
    await writeFile(join(storage, ".credentials.json"), "original-login");
    const a = await materializeProviderBinding(nativeFrame(), join(await tempDir(), "a"), home);
    const b = await materializeProviderBinding(nativeFrame(), join(await tempDir(), "b"), home);

    expect(a.CLAUDE_CONFIG_DIR).not.toBe(b.CLAUDE_CONFIG_DIR);
    expect(a.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(storage);
    expect(b.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(storage);
    for (const env of [a, b]) {
      await expect(lstat(join(env.CLAUDE_CONFIG_DIR!, ".credentials.json"))).rejects.toThrow();
    }

    // A vendor refresh publishes into the shared store, rather than replacing
    // one profile's credential symlink and stranding every other session.
    await writeFile(join(a.CLAUDE_SECURESTORAGE_CONFIG_DIR!, ".credentials.json.tmp"), "rotated-login");
    await rename(join(storage, ".credentials.json.tmp"), join(storage, ".credentials.json"));
    await expect(readFile(join(b.CLAUDE_SECURESTORAGE_CONFIG_DIR!, ".credentials.json"), "utf8")).resolves.toBe("rotated-login");

    await mkdir(join(a.CLAUDE_SECURESTORAGE_CONFIG_DIR!, ".oauth_refresh.lock"));
    await expect(mkdir(join(b.CLAUDE_SECURESTORAGE_CONFIG_DIR!, ".oauth_refresh.lock"))).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("never promotes a newer cleared legacy profile over the installation's login", async () => {
    const home = await tempDir();
    const root = await tempDir();
    await mkdir(join(home, ".claude"));
    await mkdir(join(root, ".claude"));
    const source = join(home, ".claude/.credentials.json");
    const legacy = join(root, ".claude/.credentials.json");
    await writeFile(source, "valid-shared-login");
    const cleared = '{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0}}';
    await writeFile(legacy, cleared);
    const later = new Date(Date.now() + 60_000);
    await utimes(legacy, later, later);

    const lines: string[] = [];
    const env = await materializeProviderBinding(nativeFrame(), root, home, line => lines.push(line));
    await materializeProviderBinding(nativeFrame(), root, home, line => lines.push(line));
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(home, ".claude"));
    await expect(readFile(source, "utf8")).resolves.toBe("valid-shared-login");
    await expect(readFile(legacy, "utf8")).resolves.toBe(cleared);
    expect(lines).toEqual([]);
  });

  it("keeps managed installations separate and does not manufacture a missing login", async () => {
    const firstHome = await tempDir();
    const secondHome = await tempDir();
    const a = await materializeProviderBinding(nativeFrame(), await tempDir(), firstHome);
    const b = await materializeProviderBinding(nativeFrame(), await tempDir(), secondHome);
    expect(a.CLAUDE_SECURESTORAGE_CONFIG_DIR).not.toBe(b.CLAUDE_SECURESTORAGE_CONFIG_DIR);
    for (const home of [firstHome, secondHome]) {
      await expect(lstat(join(home, ".claude/.credentials.json"))).rejects.toThrow();
    }
    await expect(materializeProviderBinding(nativeFrame(), await tempDir(), null)).rejects.toThrow(/login home/);
  });

  it("cannot attach a Host login to a provider-bound run", async () => {
    await expect(materializeProviderBinding(
      frame({ login_link: login }), await tempDir(), await tempDir(),
    )).rejects.toThrow(/provider-bound/);
  });

  it("refuses credential locations outside this installation's login home", async () => {
    for (const location of [{ home_subdir: "../another-home" }, { credential_file: "../../another-login" }]) {
      await expect(materializeProviderBinding(
        { ...nativeFrame(), login_link: { ...login, ...location } }, await tempDir(), await tempDir(),
      )).rejects.toThrow(/profile/);
    }
  });
});

describe("keeping a linked login usable over time", () => {
  const login = { home_subdir: ".claude", credential_file: ".credentials.json" };

  it("replaces a hard link the login home has since re-authenticated away from", async () => {
    // The Windows fallback binds an inode, not a path. A refresh by temp-file
    // rename gives the login home a new inode, and a profile pinned to the
    // orphaned old one fails to authenticate silently, forever, because
    // nothing else ever re-evaluates the link.
    const home = await tempDir();
    const source = join(home, login.home_subdir, login.credential_file);
    await mkdir(join(home, login.home_subdir), { recursive: true });
    await writeFile(source, '{"token":"first"}');
    const root = join(await tempDir(), "profile");
    const target = join(root, login.home_subdir, login.credential_file);
    await mkdir(join(root, login.home_subdir), { recursive: true });
    await hardLink(source, target);

    // A re-login: same path, new inode, and later than the link. The clock is
    // set explicitly because both writes land inside one filesystem timestamp
    // tick otherwise, and "which of the two is current" is the whole question.
    await writeFile(`${source}.tmp`, '{"token":"second"}');
    await rename(`${source}.tmp`, source);
    const later = new Date(Date.now() + 60_000);
    await utimes(source, later, later);

    await materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
    );

    await expect(readFile(target, "utf8")).resolves.toBe('{"token":"second"}');
  });

  it("hands a credential the profile refreshed after the link back to the login home", async () => {
    // The other direction of the same question. The profile re-authenticated
    // itself, so its file is the newer of the two; relinking would replace a
    // working credential with the stale one from the login home — and leaving
    // it private would leave every sibling on the spent token.
    const home = await tempDir();
    const source = join(home, login.home_subdir, login.credential_file);
    await mkdir(join(home, login.home_subdir), { recursive: true });
    await writeFile(source, '{"token":"stale"}');
    const root = join(await tempDir(), "profile");
    const target = join(root, login.home_subdir, login.credential_file);
    await mkdir(join(root, login.home_subdir), { recursive: true });
    await hardLink(source, target);
    await writeFile(`${target}.tmp`, '{"token":"refreshed-here"}');
    await rename(`${target}.tmp`, target);
    const later = new Date(Date.now() + 60_000);
    await utimes(target, later, later);

    await materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
    );

    // The refreshed token is the live one: it goes back to the login home,
    // and this profile links to it there like every other.
    await expect(readFile(target, "utf8")).resolves.toBe('{"token":"refreshed-here"}');
    await expect(readFile(source, "utf8")).resolves.toBe('{"token":"refreshed-here"}');
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });

  it("leaves a hard link that still points at the live credential alone", async () => {
    const home = await tempDir();
    const source = join(home, login.home_subdir, login.credential_file);
    await mkdir(join(home, login.home_subdir), { recursive: true });
    await writeFile(source, '{"token":"shared"}');
    const root = join(await tempDir(), "profile");
    const target = join(root, login.home_subdir, login.credential_file);
    await mkdir(join(root, login.home_subdir), { recursive: true });
    await hardLink(source, target);
    const before = await lstat(target);

    await materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
    );

    // Not relinked: same inode, so nothing to fix.
    expect((await lstat(target)).ino).toBe(before.ino);
  });

  it("reports a link it could not make instead of running without a credential", async () => {
    const home = await tempDir();
    await mkdir(join(home, login.home_subdir), { recursive: true });
    await writeFile(join(home, login.home_subdir, login.credential_file), "{}");
    const dir = await tempDir();
    // A file where the profile's login directory has to go. A headless
    // dispatch cannot answer a login prompt, so a profile silently left
    // without a credential fails the run with no reason anybody can act on.
    const root = join(dir, "profile");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, login.home_subdir), "not a directory");

    await expect(materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
    )).rejects.toThrow();
  });
});

describe("environment for a run on this machine's own login", () => {
  it("keeps the machine, and drops only its state roots and its loose credentials", () => {
    // B67's closing rule: a run with no binding is not affected, so `HOME` and
    // with it `~/.gitconfig` and `~/.ssh/config`, the proxy variables and the
    // toolchains a paired machine needs are all still there. Two things must
    // not survive. A variable that relocates the state root the profile just
    // established — OpenCode reads `XDG_DATA_HOME` before falling back to
    // `HOME`. And a credential lying around on the machine. This run spends
    // the owner's subscription, linked into the profile, and a runtime
    // that prefers an ambient key over it bills an API account instead — B67's
    // "subscription login converted into API billing by a leftover key".
    const ambient = {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      HTTPS_PROXY: "http://corporate:3128",
      NVM_DIR: "/home/someone/.nvm",
      SSH_AUTH_SOCK: "/run/ssh-agent",
      ANTHROPIC_API_KEY: "sk-machine",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-from-this-machine",
      OPENAI_API_KEY: "sk-openai",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/someone/vertex.json",
      XDG_DATA_HOME: "/home/someone/.local/share",
      XDG_CONFIG_HOME: "/home/someone/.config",
      OPENCODE_CONFIG: "/home/someone/opencode.json",
      CODEX_HOME: "/home/someone/.codex",
      // The XDG *roots* go by name, not by prefix: a git credential helper
      // reaches the keyring through `XDG_RUNTIME_DIR` and rootless podman
      // finds its socket there. Do not drop it. A Task run that pushes or
      // builds would break, the same way moving `HOME` breaks them.
      XDG_RUNTIME_DIR: "/run/user/1000",
    };
    const machine = {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      HTTPS_PROXY: "http://corporate:3128",
      NVM_DIR: "/home/someone/.nvm",
      SSH_AUTH_SOCK: "/run/ssh-agent",
      XDG_RUNTIME_DIR: "/run/user/1000",
    };

    // Per launched runtime: Claude Code reads none of the OpenAI or Google
    // variables, and `GOOGLE_APPLICATION_CREDENTIALS` is how gcloud and a GCS
    // toolchain authenticate in a Task run. Do not drop it. That takes a tool
    // away from the run that keeps the machine's environment.
    expect(clearStateRootEnv(ambient, "claude_code")).toEqual({
      ...machine,
      OPENAI_API_KEY: "sk-openai",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/someone/vertex.json",
      OPENCODE_CONFIG: "/home/someone/opencode.json",
      CODEX_HOME: "/home/someone/.codex",
    });
    expect(clearStateRootEnv(ambient, "codex_cli")).toEqual({
      ...machine,
      ANTHROPIC_API_KEY: "sk-machine",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-from-this-machine",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/someone/vertex.json",
      OPENCODE_CONFIG: "/home/someone/opencode.json",
    });
    // OpenCode routes to whichever provider it finds a key for, so for it
    // every vendor key is a credential; a runtime this daemon does not know
    // gets the same full list rather than a guess.
    expect(clearStateRootEnv(ambient, "opencode")).toEqual(machine);
    expect(clearStateRootEnv(ambient, "acp_something")).toEqual(machine);
  });

  it("drops only the credentials for a runtime whose state root cannot move", () => {
    // A registry agent is logged in inside its managed tree and gets no
    // profile, so its XDG roots must stay exactly as they were at login —
    // that may be where its state is. The vendor keys still go: an agent
    // that read one would bill an API account instead of that login.
    expect(clearVendorCredentialEnv({
      HOME: "/home/someone",
      XDG_DATA_HOME: "/home/someone/.local/share",
      ANTHROPIC_API_KEY: "sk-machine",
      GEMINI_API_KEY: "gm-machine",
    }, "acp_something")).toEqual({
      HOME: "/home/someone",
      XDG_DATA_HOME: "/home/someone/.local/share",
    });
  });
});

describe("a login link that stopped pointing where it should", () => {
  const login = { home_subdir: ".claude", credential_file: ".credentials.json" };

  it("re-points a symlink left behind by another installation's login home", async () => {
    // The profile key carries no installation, so the same directory is
    // reached again after an Agent moves between `own` and `managed:<version>`
    // — or after a managed copy is replaced and its tree removed. The link is
    // then dangling, or authenticating as the wrong installation, and nothing
    // else on the machine would repair it.
    const gone = join(await tempDir(), "removed-managed-tree");
    const root = join(await tempDir(), "profile");
    const target = join(root, login.home_subdir, login.credential_file);
    await mkdir(join(root, login.home_subdir), { recursive: true });
    await symlink(join(gone, login.home_subdir, login.credential_file), target);

    const home = await tempDir();
    await mkdir(join(home, login.home_subdir), { recursive: true });
    await writeFile(join(home, login.home_subdir, login.credential_file), '{"token":"own"}');

    await materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
    );

    await expect(readFile(target, "utf8")).resolves.toBe('{"token":"own"}');
  });

  it("removes a dangling link when the login home has no credential, and leaves a private copy", async () => {
    // A profile first materialized under a managed copy links into that tree.
    // Uninstall the copy, and the runtime's own `/login` in this profile would
    // write through the dangling link into a removed directory. A regular
    // file is a credential this profile holds itself — nothing to repair.
    const gone = join(await tempDir(), "removed-managed-tree");
    const root = join(await tempDir(), "profile");
    const target = join(root, login.home_subdir, login.credential_file);
    await mkdir(join(root, login.home_subdir), { recursive: true });
    await symlink(join(gone, login.home_subdir, login.credential_file), target);
    const home = await tempDir();
    const lines: string[] = [];

    await materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
      (line) => lines.push(line),
    );

    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(lines).toEqual([expect.stringMatching(/removed a login link/)]);

    await writeFile(target, '{"token":"mine"}');
    await materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
    );
    await expect(readFile(target, "utf8")).resolves.toBe('{"token":"mine"}');
  });

  it("promotes a credential newer than the login home's so the siblings stop asking for a login", async () => {
    // Claude Code refreshes by temp-file rename: the shared inode is gone, this
    // profile holds the rotated token and the login home the spent one. Every
    // other profile would now be told to log in again. The fresh file is moved
    // back over the login home's and this profile linked to it again.
    const home = await tempDir();
    const source = join(home, login.home_subdir, login.credential_file);
    await mkdir(join(home, login.home_subdir), { recursive: true });
    await writeFile(source, '{"token":"shared"}');
    await utimes(source, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const root = join(await tempDir(), "profile");
    const target = join(root, login.home_subdir, login.credential_file);
    await mkdir(join(root, login.home_subdir), { recursive: true });
    await writeFile(target, '{"token":"refreshed-here"}');
    const lines: string[] = [];

    await materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
      (line) => lines.push(line),
    );

    await expect(readFile(source, "utf8")).resolves.toBe('{"token":"refreshed-here"}');
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe('{"token":"refreshed-here"}');
    expect(lines).toEqual([expect.stringMatching(/handed its refreshed .* back to the login home/)]);
  });

  it("leaves a symlink that still resolves to this login home alone", async () => {
    const home = await tempDir();
    const source = join(home, login.home_subdir, login.credential_file);
    await mkdir(join(home, login.home_subdir), { recursive: true });
    await writeFile(source, '{"token":"live"}');
    const root = join(await tempDir(), "profile");
    const target = join(root, login.home_subdir, login.credential_file);
    await mkdir(join(root, login.home_subdir), { recursive: true });
    await symlink(source, target);

    await materializeProviderBinding(
      frame({ env: {}, files: [], credential_source: "host_login", login_link: login }),
      root,
      home,
    );

    // Still a symlink at the same path — not replaced by a fresh one, and
    // certainly not by a copy.
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe('{"token":"live"}');
  });
});

describe("environment for a daemon-side helper process", () => {
  const ambient = {
    PATH: "/usr/bin",
    HOME: "/home/owner",
    ANTHROPIC_API_KEY: "sk-ant-live",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    OPENAI_API_KEY: "sk-openai",
    GOOGLE_API_KEY: "goog",
    CLAUDE_CONFIG_DIR: "/home/owner/.claude",
    CODEX_HOME: "/home/owner/.codex",
    XDG_RUNTIME_DIR: "/run/user/1000",
  };

  it("keeps the machine's toolchain and drops every vendor credential for a helper serving no runtime", () => {
    // An installer serves no runtime, so nothing is exempt.
    const env = helperProcessEnv(ambient);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/owner");
    // Not the XDG prefix: `XDG_RUNTIME_DIR` is how a git credential helper
    // reaches the keyring.
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it("drops the named runtime's own credentials, by prefix rather than by a two-key denylist", () => {
    // Drop credentials by prefix. Do not delete two named keys beside a
    // `process.env` spread: any other key under the same prefix goes through.
    const env = helperProcessEnv({ ...ambient, ANTHROPIC_AUTH_TOKEN: "other", CLAUDE_API_KEY: "another" }, "claude_code");
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(env, key).not.toHaveProperty(key);
    }
    // Another vendor's key is not this runtime's to prefer, and a Task run may
    // legitimately need it.
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
  });

  it("keeps the state roots back for a helper that reads the machine's own history", () => {
    // `CLAUDE_CONFIG_DIR` and `CLAUDE_API_KEY` share a prefix and are opposite
    // kinds of thing: clearing by prefix sent an ambient `session/list` to the
    // default location, which reported the machine as having no history at all.
    const env = helperProcessEnv(ambient, "claude_code", { keepStateRoots: true });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/owner/.claude");
    expect(env.CODEX_HOME).toBe("/home/owner/.codex");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
