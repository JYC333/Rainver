import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareClaudeAcp } from "../src/acpAdapterCompatibility.js";

const AGENT = [
  "class Agent {",
  "    close(session) {",
  "        session.query.close();",
  "        this.closeQueryStream(session);",
  "        // Abort the SDK abort signal",
  "    }",
  "}",
  "",
].join("\n");
const INDEX = [
  "function main(agent) {",
  "    async function shutdown() {",
  "        await agent.dispose().catch((err) => {",
  "            console.error(\"Error during cleanup:\", err);",
  "        });",
  "        process.exit(0);",
  "    }",
  "}",
  "",
].join("\n");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(agent = AGENT, index = INDEX): string {
  const root = mkdtempSync(join(tmpdir(), "acp-compat-"));
  roots.push(root);
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/acp-agent.js"), agent);
  writeFileSync(join(root, "dist/index.js"), index);
  return root;
}
const read = (root: string, file: string) => readFileSync(join(root, "dist", file), "utf8");

describe("Claude ACP cleanup preparation", () => {
  it("patches both files once and is idempotent", () => {
    const root = fixture();
    prepareClaudeAcp(root);
    const agent = read(root, "acp-agent.js"), index = read(root, "index.js");
    expect(agent).toContain("await session.rainverQueryCleanup;");
    expect(index).toContain("let rainverShutdown;");
    prepareClaudeAcp(root);
    expect(read(root, "acp-agent.js")).toBe(agent);
    expect(read(root, "index.js")).toBe(index);
    expect(readdirSync(join(root, "dist")).sort()).toEqual(["acp-agent.js", "index.js"]);
  });

  it("completes a preparation interrupted after only one file was replaced", () => {
    const done = fixture();
    prepareClaudeAcp(done);
    const halfway = fixture(read(done, "acp-agent.js"), INDEX);
    prepareClaudeAcp(halfway);
    expect(read(halfway, "acp-agent.js")).toBe(read(done, "acp-agent.js"));
    expect(read(halfway, "index.js")).toBe(read(done, "index.js"));
  });

  it("still refuses an unknown upstream layout without touching either file", () => {
    const root = fixture(AGENT.replace("session.query.close();", "session.query.end();"));
    expect(() => prepareClaudeAcp(root)).toThrow(/cleanup layout changed/);
    expect(read(root, "acp-agent.js")).toContain("session.query.end();");
    expect(read(root, "index.js")).toBe(INDEX);
  });
});
