import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ownToolUpdateCommand, runUpdater, updateOwnTool } from "../src/ownToolUpdate.js";
import { updateOwnNpmTool } from "../src/ownNpmToolUpdate.js";
import { probeVersion } from "../src/capabilities.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rainver-own-update-")); roots.push(root);
  const bin = join(root, "bin"); await mkdir(bin);
  return { root, bin, env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: root, OPENAI_API_KEY: "test-provider-key" } };
}
async function executable(path: string) { await writeFile(path, "#!/bin/sh\nexit 0\n"); await chmod(path, 0o755); }

async function npmFixture(mode: "success" | "install-failure" | "invalid-version" | "promotion-failure" | "timeout") {
  const fixtureData = await fixture();
  const { root, bin } = fixtureData;
  const current = join(root, "lib/node_modules/@anthropic-ai/claude-code/bin");
  await mkdir(current, { recursive: true });
  const original = "#!/bin/sh\necho '1.2.0 (Claude Code)'\n";
  await writeFile(join(current, "claude"), original, { mode: 0o755 });
  await symlink("../lib/node_modules/@anthropic-ai/claude-code/bin/claude", join(bin, "claude"));
  await symlink(process.execPath, join(bin, "node"));
  const candidate = mode === "invalid-version" ? "#!/bin/sh\nexit 1\n"
    : mode === "promotion-failure" ? "#!/bin/sh\ncase \"$0\" in *.rainver-cli-update-*) echo '2.0.0 (Claude Code)';; *) exit 1;; esac\n"
    : "#!/bin/sh\necho '2.0.0 (Claude Code)'\n";
  await writeFile(join(bin, "npm"), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const args = process.argv.slice(2); const prefix = args[args.indexOf('--prefix') + 1];
if (prefix === ${JSON.stringify(root)} || process.env.OPENAI_API_KEY) process.exit(20);
fs.writeFileSync(${JSON.stringify(join(root, 'during-install'))}, cp.execFileSync(${JSON.stringify(join(bin, 'claude'))}, ['--version']));
const directory = path.join(prefix, 'lib/node_modules/@anthropic-ai/claude-code/bin'); fs.mkdirSync(directory, {recursive:true});
fs.writeFileSync(path.join(directory, 'new-claude'), ${JSON.stringify(candidate)}, {mode:0o755});
fs.mkdirSync(path.join(prefix, 'bin'), {recursive:true});
fs.symlinkSync('../lib/node_modules/@anthropic-ai/claude-code/bin/new-claude', path.join(prefix, 'bin/claude'));
if (${JSON.stringify(mode)} === 'install-failure') process.exit(42);
if (${JSON.stringify(mode)} === 'timeout') setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return { ...fixtureData, original, originalPath: join(current, "claude") };
}

describe("own CLI update recipes", () => {
  it("keeps the current CLI usable while npm downloads and validates the replacement", async () => {
    const { root, bin, env } = await npmFixture("success");
    await expect(updateOwnTool("claude_code", env)).resolves.toEqual({ from_version: "1.2.0", to_version: "2.0.0" });
    expect(await readFile(join(root, "during-install"), "utf8")).toContain("1.2.0");
    expect(await probeVersion(join(bin, "claude"))).toContain("2.0.0");
    expect((await readdir(root)).some(name => name.startsWith(".rainver-cli-update-"))).toBe(false);
  });
  it.each(["install-failure", "invalid-version", "promotion-failure"] as const)("retains the original command and package after %s", async mode => {
    const { root, bin, env, original, originalPath } = await npmFixture(mode);
    await expect(updateOwnTool("claude_code", env)).rejects.toThrow(mode === "install-failure" ? /exited with code 42/
      : mode === "invalid-version" ? /new CLI failed its version check/ : /updated CLI failed its version check/);
    expect(await readFile(originalPath, "utf8")).toBe(original);
    expect(await probeVersion(join(bin, "claude"))).toContain("1.2.0");
    expect((await readdir(root)).some(name => name.startsWith(".rainver-cli-update-"))).toBe(false);
  });
  it("leaves the working CLI untouched when the staged install times out", async () => {
    const { root, bin, env } = await npmFixture("timeout");
    const recipe = await ownToolUpdateCommand("claude_code", env);
    await expect(updateOwnNpmTool(recipe, candidate => runUpdater(candidate, 150))).rejects.toThrow(/timed out/);
    expect(await probeVersion(join(bin, "claude"))).toContain("1.2.0");
    expect((await readdir(root)).some(name => name.startsWith(".rainver-cli-update-"))).toBe(false);
  });
  it("updates npm in the original Node prefix and strips provider keys", async () => {
    const { root, bin, env } = await fixture();
    const packageBin = join(root, "lib/node_modules/@openai/codex/bin"); await mkdir(packageBin, { recursive: true });
    await executable(join(packageBin, "codex.js")); await symlink(join(packageBin, "codex.js"), join(bin, "codex"));
    await executable(join(bin, "npm")); await executable(join(bin, "node"));
    const recipe = await ownToolUpdateCommand("codex_cli", env);
    expect(recipe.command).toBe(join(bin, "npm"));
    expect(recipe.args).toEqual(["install", "--global", "--prefix", root, "@openai/codex@latest"]);
    expect(recipe.env.OPENAI_API_KEY).toBeUndefined();
  });
  it.each([["claude_code", "claude", ".local/share/claude/versions"], ["codex_cli", "codex", ".codex/packages/standalone/releases"]])("uses the native updater for %s", async (key, command, tree) => {
    const { root, bin, env } = await fixture(); const directory = join(root, tree); await mkdir(directory, { recursive: true });
    const target = join(directory, "binary"); await executable(target); await symlink(target, join(bin, command));
    expect(await ownToolUpdateCommand(key, env)).toMatchObject({ command: join(bin, command), args: ["update"] });
  });
  it("refuses unsupported installs instead of replacing them with npm", async () => {
    const { bin, env } = await fixture(); await executable(join(bin, "codex"));
    await expect(ownToolUpdateCommand("codex_cli", env)).rejects.toThrow(/original installation method/);
    await expect(ownToolUpdateCommand("untrusted;command", env)).rejects.toThrow(/not supported/);
  });

  it("streams verbose updater output instead of failing at a buffer cap, and reports both versions", async () => {
    const { root, bin, env } = await fixture();
    const directory = join(root, ".local/share/claude/versions"); await mkdir(directory, { recursive: true });
    const state = join(root, "version"); await writeFile(state, "1.2.0 (Claude Code)\n");
    const target = join(directory, "binary");
    // 300 KB of progress output, far past the 64 KB that used to kill the install.
    await writeFile(target, `#!/bin/sh
if [ "$1" = "--version" ]; then cat '${state}'; exit 0; fi
i=0; while [ $i -lt 3000 ]; do echo "progress line $i ................................................................................."; i=$((i+1)); done
echo "2.0.1 (Claude Code)" > '${state}'
`);
    await chmod(target, 0o755); await symlink(target, join(bin, "claude"));
    await expect(updateOwnTool("claude_code", env)).resolves.toEqual({ from_version: "1.2.0", to_version: "2.0.1" });
    // Already current: the same version on both sides.
    await expect(updateOwnTool("claude_code", env)).resolves.toEqual({ from_version: "2.0.1", to_version: "2.0.1" });
  });

  it("keeps only a bounded tail of a failing updater's output", async () => {
    const { root } = await fixture();
    const script = join(root, "fail.sh");
    await writeFile(script, `#!/bin/sh
i=0; while [ $i -lt 2000 ]; do echo "noise $i"; i=$((i+1)); done
echo "npm ERR! the real reason" >&2
exit 3
`);
    await chmod(script, 0o755);
    const failure = await runUpdater({ command: script, args: [], env: { PATH: "/usr/bin:/bin" } }).then(() => null, (error: Error) => error);
    expect(failure?.message).toMatch(/exited with code 3/);
    expect(failure?.message).toContain("npm ERR! the real reason");
    expect(failure?.message).not.toContain("noise 0\n");
    expect(failure!.message.length).toBeLessThan(4_200);
  });
});
