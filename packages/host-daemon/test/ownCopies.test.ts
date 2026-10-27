import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __clearOwnCopies, findOnPath, findOwnCopy, ownLaunchFor, resolveCandidates } from "../src/ownCopies.js";
import { detectCapabilities } from "../src/capabilities.js";
import { resolveAcpLaunch } from "../src/execution.js";
import { npmGlobalRoots, userToolDirectories } from "../src/userPath.js";

/**
 * A registry agent the owner installed themselves. ACP has no discovery, so
 * the daemon looks for what the registry's distribution would be called and
 * keeps only what answers `initialize`.
 */
let dir: string;
let bin: string;
let savedPath: string | undefined;

/** A fake ACP agent on PATH that answers initialize with a version, or a same-named binary that does not speak ACP. */
async function install(name: string, body: string): Promise<string> {
  const path = join(bin, name);
  await writeFile(path, `#!${process.execPath}\n${body}`);
  await chmod(path, 0o755);
  return path;
}

const ACP_AGENT = `
  const rl = require("node:readline").createInterface({ input: process.stdin });
  setInterval(() => {}, 1000);
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "9.9.9" }, authMethods: [] } }) + "\\n");
    if (msg.method === "session/new") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", configOptions: [] } }) + "\\n");
  });
`;
const NOT_ACP = `process.stdout.write("usage: goose [options]\\n"); process.exit(0);`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rainver-own-copies-"));
  bin = join(dir, "bin");
  await mkdir(bin);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  __clearOwnCopies();
});

afterEach(async () => {
  process.env.PATH = savedPath;
  __clearOwnCopies();
  await rm(dir, { recursive: true, force: true });
});

describe("own copies of registry agents", () => {
  it("reports a candidate that answers ACP initialize as the machine's own copy, with the version it gave", async () => {
    const path = await install("goose", ACP_AGENT);
    const copy = await findOwnCopy("acp_goose", [{ kind: "binary", command: "goose", args: ["acp"] }]);
    expect(copy).toEqual({ command: path, args: ["acp"], version: "9.9.9" });
    // What a Run or a login for the `own` copy launches: the verified binary
    // with the registry's arguments, not the runtime key the template names.
    expect(ownLaunchFor("acp_goose")).toEqual({ command: path, args: ["acp"] });
    expect(resolveAcpLaunch("acp_goose", [], "own", "acp_goose")).toEqual({ command: path, args: ["acp"], env: {} });
  });

  it("does not mistake a same-named binary that is not an ACP agent for a copy", async () => {
    await install("goose", NOT_ACP);
    const lines: string[] = [];
    const copy = await findOwnCopy("acp_goose", [{ kind: "binary", command: "goose", args: ["acp"] }], (line) => lines.push(line));
    expect(copy).toBeNull();
    expect(ownLaunchFor("acp_goose")).toBeNull();
    expect(lines[0]).toMatch(/did not answer ACP initialize/);
  });

  it("lists the copy as an `own` installation in the capability report", async () => {
    await install("kimi", ACP_AGENT);
    const capabilities = await detectCapabilities(undefined, [
      { runtime_key: "acp_kimi", runtime: null, own_candidates: [{ kind: "binary", command: "kimi", args: ["acp"] }], login: null },
      { runtime_key: "acp_absent", runtime: null, own_candidates: [{ kind: "binary", command: "absent-agent", args: [] }], login: null },
    ]);
    expect(capabilities.installations.acp_kimi).toEqual([
      expect.objectContaining({ id: "own", version: "9.9.9", runtime_version: "9.9.9", health_check_protocol: "acp" }),
    ]);
    expect(capabilities.installations.acp_absent).toBeUndefined();
  });

  it("resolves an npm package's commands from a global install's bin field", async () => {
    // A fake global npm root with the package installed; the bin name differs
    // from the package name, as with @google/gemini-cli → gemini.
    const root = join(dir, "lib", "node_modules");
    await mkdir(join(root, "@acme", "fancy-cli"), { recursive: true });
    await writeFile(join(root, "@acme", "fancy-cli", "package.json"), JSON.stringify({ name: "@acme/fancy-cli", bin: { fancy: "cli.js" } }));
    await writeFile(join(bin, "node"), "");
    await chmod(join(bin, "node"), 0o755);
    const path = await install("fancy", ACP_AGENT);
    expect(npmGlobalRoots(dir)).toContain(root);
    expect(resolveCandidates([{ kind: "npm", package: "@acme/fancy-cli", args: ["--acp"] }])).toEqual([{ command: path, args: ["--acp"] }]);
  });

  it("falls back to the unscoped package name when the package is not installed globally", async () => {
    const path = await install("cline", ACP_AGENT);
    expect(resolveCandidates([{ kind: "npm", package: "cline", args: ["--acp"] }])).toEqual([{ command: path, args: ["--acp"] }]);
  });

  it("refuses a candidate name that is a path", () => {
    expect(findOnPath("../bin/goose")).toBeNull();
    expect(findOnPath("/usr/bin/env")).toBeNull();
  });

  it("adds only tool directories that exist", async () => {
    const home = join(dir, "home");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    const directories = userToolDirectories(home);
    expect(directories).toContain(join(home, ".local", "bin"));
    expect(directories).not.toContain(join(home, ".cargo", "bin"));
  });
});
