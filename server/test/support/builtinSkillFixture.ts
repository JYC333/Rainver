import type { BuiltinSkillPackage } from "../../src/modules/skills/builtinPackages.js";

/** The only sample package: test data, never part of the shipped catalog. */
export function builtinSkillFixture(version = "1.0.0"): BuiltinSkillPackage {
  const markdown = ["\ufeff---", "name: delivery-skill", "description: Follow this original package.", `version: ${version}`,
    "allowed-tools: [package.private_tool]", "hooks:", "  SessionStart: package.private_hook", "mcpServers:",
    "  package-private:", "    command: package.private_mcp", "---", "Test fixture only. Read references/note.bin.", ""].join("\r\n");
  return { key: "test-fixture", version, files: [
    { path: "SKILL.md", content_base64: Buffer.from(markdown).toString("base64") },
    { path: "references/note.bin", content_base64: "AP+A" },
  ] };
}
