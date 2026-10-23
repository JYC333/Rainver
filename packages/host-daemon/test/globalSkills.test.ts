import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { scanGlobalSkills, readGlobalSkill } from "../src/globalSkills.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "rainver-cli-skills-")); roots.push(home);
  const options = { home, env: {}, managed: new Map() };
  const put = async (path: string, body = "---\nname: test\ndescription: original\n---\nHello") => {
    await mkdir(join(home, path), { recursive: true });
    await writeFile(join(home, path, "SKILL.md"), body);
  };
  return { home, options, put };
}
describe("Host global Skill discovery", () => {
  it("discovers Claude, current/legacy Codex and shared linked Skills without Project Folders", async () => {
    const { home, options, put } = await fixture();
    await put(".claude/skills/review"); await put(".agents/skills/shared"); await put(".codex/skills/.system/internal");
    await put("project/.claude/skills/project-only");
    await put("outside/link-target");
    await symlink(join(home, "outside/link-target"), join(home, ".claude/skills/linked"));
    const result = await scanGlobalSkills(options);
    expect(result.items.map(item => item.name).sort()).toEqual(["internal", "linked", "review", "shared"]);
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain(home);
    expect(result.items.find(item => item.name === "shared")?.runtime_key).toBe("codex_cli");
  });
  it("preserves binary, BOM and CRLF bytes while refusing paths and retargeted links", async () => {
    const { home, options, put } = await fixture();
    const text = "\ufeff---\r\nname: raw\r\ndescription: raw\r\n---\r\nBody\r\n";
    await put(".claude/skills/raw", text);
    await writeFile(join(home, ".claude/skills/raw/image.bin"), Buffer.from([0, 255, 128]));
    const skill = (await scanGlobalSkills(options)).items[0]!;
    const result = await readGlobalSkill(skill.id, options);
    expect(result.files).toEqual(expect.arrayContaining([
      { path: "SKILL.md", content_base64: Buffer.from(text).toString("base64") },
      { path: "image.bin", content_base64: "AP+A" },
    ]));
    await expect(readGlobalSkill("../../secret", options)).rejects.toThrow("Invalid Skill id");
    await rm(join(home, ".claude/skills/raw"), { recursive: true });
    await expect(readGlobalSkill(skill.id, options)).rejects.toThrow("no longer available");
  });
  it("honors explicit CLI configuration roots and returns empty for missing roots", async () => {
    const { home, options, put } = await fixture();
    expect((await scanGlobalSkills(options)).items).toEqual([]);
    await put("custom-claude/skills/custom");
    const items = (await scanGlobalSkills({ ...options, env: { CLAUDE_CONFIG_DIR: join(home, "custom-claude") } })).items;
    expect(items).toMatchObject([{ name: "custom", display_path: "$CLAUDE_CONFIG_DIR/skills/custom" }]);
  });
  it("scans installed managed CLI state separately and refuses a retargeted linked package", async () => {
    const { home, options, put } = await fixture();
    await put("managed-home/.agents/skills/managed-review");
    const managed = new Map([["codex_cli", [{ runtime_key: "codex_cli", version: "1.0.0", runtime_version: "1.0.0",
      command: "unused", args: [], env: {}, home: join(home, "managed-home"), login_command: null, login: null, installed_at: new Date().toISOString() }]]]);
    expect((await scanGlobalSkills({ ...options, managed })).items).toMatchObject([{ name: "managed-review", installation: "managed:1.0.0" }]);
    await mkdir(join(home, ".claude/skills"), { recursive: true });
    await put("targets/one"); await put("targets/two");
    const link = join(home, ".claude/skills/linked");
    await symlink(join(home, "targets/one"), link);
    const old = (await scanGlobalSkills(options)).items[0]!;
    await rm(link); await symlink(join(home, "targets/two"), link);
    await expect(readGlobalSkill(old.id, options)).rejects.toThrow("no longer available");
  });
  it("rejects packages over the original-byte limits and does not read linked secrets", async () => {
    const { home, options, put } = await fixture();
    await put(".codex/skills/big");
    await writeFile(join(home, ".codex/skills/big/oversize.bin"), Buffer.alloc(256 * 1024 + 1));
    const candidate = (await scanGlobalSkills(options)).items[0]!;
    await expect(readGlobalSkill(candidate.id, options)).rejects.toThrow("limits");
    await rm(join(home, ".codex/skills/big/oversize.bin"));
    await writeFile(join(home, "credentials"), "secret");
    await symlink(join(home, "credentials"), join(home, ".codex/skills/big/secret.txt"));
    expect((await readGlobalSkill(candidate.id, options)).files.map(file => file.path)).toEqual(["SKILL.md"]);
  });
});
