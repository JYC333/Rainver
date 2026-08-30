import { mkdtemp, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_WORK_SURFACE_DIRECTORY,
  SANDBOX_WORK_SURFACE_HOME,
  stageSandboxWorkSurface,
} from "../src/modules/runs/sandboxWorkSurface.js";
import { renderWorkSkill, workSkillContentHash } from "../src/modules/capabilities/workSkill.js";
import { withWorkSurfacePointer } from "../src/modules/runs/vendorCliAdapter.js";

/**
 * What a sandboxed Run is handed so it can report back.
 *
 * The delivery has to be the same for every runtime — that is the whole point
 * of replacing the per-vendor MCP configuration writers — so these assertions
 * are about files and environment, and there is no adapter type anywhere in
 * them.
 */

const SKILL = renderWorkSkill({ deliverOutputs: false });

async function stage() {
  const runHome = await mkdtemp(join(tmpdir(), "rainver-run-home-"));
  const surface = await stageSandboxWorkSurface({
    runHome,
    apiUrl: "http://server:8010",
    runId: "run-1",
    token: "token-1",
    skill: SKILL,
  });
  return { runHome, staged: join(runHome, SANDBOX_WORK_SURFACE_DIRECTORY), surface };
}

describe("staging a sandboxed Run's work surface", () => {
  it("writes the Skill and the command into the Run's own HOME", async () => {
    const { staged } = await stage();

    expect(await readFile(join(staged, "SKILL.md"), "utf8")).toBe(SKILL);
    expect((await stat(join(staged, "rainver"))).mode & 0o777).toBe(0o700);
    // Whatever the surface staged is what the Run is recorded as having been
    // given: the caller hashes the same text it passed in.
    expect(workSkillContentHash(await readFile(join(staged, "SKILL.md"), "utf8")))
      .toBe(workSkillContentHash(SKILL));
  });

  it("names the command `.mjs`, so the Run's own project cannot decide its format", async () => {
    // Copied out of its package, the file loses the `"type": "module"` that
    // gave it its format: Node would ask whichever `package.json` is nearest,
    // and a CommonJS project would make the command refuse to start.
    const { staged } = await stage();

    expect(existsSync(join(staged, "rainver.mjs"))).toBe(true);
    const launcher = await readFile(join(staged, "rainver"), "utf8");
    expect(launcher).toBe(
      `#!/bin/sh\nexec node ${SANDBOX_WORK_SURFACE_HOME}/${SANDBOX_WORK_SURFACE_DIRECTORY}/rainver.mjs "$@"\n`,
    );
  });

  it("names every path as the sandbox sees it, never as the server does", async () => {
    const { runHome, surface } = await stage();

    expect(surface.env).toMatchObject({
      RAINVER_API_URL: "http://server:8010",
      RAINVER_RUN_ID: "run-1",
      RAINVER_TOOL_TOKEN: "token-1",
      RAINVER_CLI: "/home/sandbox/.rainver/rainver",
      RAINVER_SKILL_PATH: "/home/sandbox/.rainver/SKILL.md",
    });
    // A server path reaching the runtime would name a file that does not exist
    // as far as the sandboxed process is concerned.
    for (const value of Object.values(surface.env)) {
      expect(value).not.toContain(runHome);
    }
  });

  it("stages a command that carries no dependency of its own", async () => {
    const { staged } = await stage();

    // One file is enough only because it imports nothing outside Node.
    const command = await readFile(join(staged, "rainver.mjs"), "utf8");
    const imports = [...command.matchAll(/^import .*from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier!.startsWith("node:"))).toBe(true);
  });

  it("keeps no secret on disk: the token is environment, the files are not", async () => {
    const { staged } = await stage();

    for (const name of ["SKILL.md", "rainver", "rainver.mjs"]) {
      expect(await readFile(join(staged, name), "utf8")).not.toContain("token-1");
    }
  });
});

describe("telling the agent the surface is there", () => {
  const surface = { env: { RAINVER_SKILL_PATH: "/home/sandbox/.rainver/SKILL.md" } };

  it("appends the pointer to the prompt that opens the session, and only that one", () => {
    // No runtime discovers a staged file on its own — this pointer is the
    // whole job the vendor configuration it replaced was doing.
    const prompts = withWorkSurfacePointer(["do the work", "then this"], surface);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("do the work");
    expect(prompts[0]).toContain("Reporting back to Rainver");
    expect(prompts[0]).toContain("/home/sandbox/.rainver/SKILL.md");
    // Repeating it every turn would spend context re-teaching what the agent
    // already read.
    expect(prompts[1]).toBe("then this");
  });

  it("omits the output workflow a sandboxed Run cannot perform", () => {
    const [first] = withWorkSurfacePointer(["do the work"], surface);

    expect(first).not.toContain("artifact.submit");
    expect(first).not.toContain("RAINVER_OUTPUT_DIR");
  });

  it("leaves the prompts alone when there is no surface, and never invents one", () => {
    expect(withWorkSurfacePointer(["do the work"], null)).toEqual(["do the work"]);
    // An empty list means the controller sends nothing at all; a pointer-only
    // prompt would start a turn nobody asked for.
    expect(withWorkSurfacePointer([], surface)).toEqual([]);
  });
});
