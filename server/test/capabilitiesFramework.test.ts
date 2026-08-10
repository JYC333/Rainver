import { describe, expect, it } from "vitest";
import {
  analyzeSkillRisk,
  assertPackReferencesValid,
  assertUniqueCapabilityIds,
  assertUniqueWorkflowTemplateIds,
  listBuiltInCapabilityDefinitions,
  listBuiltInCapabilityPacks,
  listBuiltInWorkflowTemplates,
  parseSkillMarkdown,
  previewSkillImport,
  renderAllRuntimeSkills,
} from "../src/modules/capabilities";

describe("capability framework built-ins", () => {
  it("registers the built-in research pack without label-only workflow presets", () => {
    const capabilities = listBuiltInCapabilityDefinitions();
    const workflows = listBuiltInWorkflowTemplates();
    const packs = listBuiltInCapabilityPacks();

    expect(packs.map((pack) => pack.id)).toContain("research");
    expect(capabilities.map((capability) => capability.id).sort()).toEqual([
      "research.adhoc_analyze",
      "research.ask",
      "research.brief_synthesize",
      "research.evidence_extract",
      "research.idea_generate",
      "research.monitor_compare",
      "research.source_collect",
      "research.source_summarize",
    ]);
    expect(workflows).toEqual([]);

    expect(() => assertUniqueCapabilityIds(capabilities)).not.toThrow();
    expect(() => assertUniqueWorkflowTemplateIds(workflows)).not.toThrow();
    expect(() => assertPackReferencesValid(packs)).not.toThrow();
  });
});

describe("skill parser and risk scanner", () => {
  it("parses a minimal SKILL.md into a normalized skill", () => {
    const skill = parseSkillMarkdown([
      "---",
      "name: Technical Survey Helper",
      "description: Summarize technical sources.",
      "version: 0.2.0",
      "allowed-tools:",
      "  - WebFetch",
      "---",
      "",
      "Use cited evidence only.",
    ].join("\n"));

    expect(skill.name).toBe("Technical Survey Helper");
    expect(skill.description).toBe("Summarize technical sources.");
    expect(skill.requested_permissions).toEqual(["WebFetch"]);
  });

  it("rejects a skill with no name or description", () => {
    expect(() => parseSkillMarkdown("")).toThrow(/Skill is missing name/);
    expect(() => parseSkillMarkdown("# Name Only")).toThrow(/Skill is missing description/);
  });

  it("classifies instruction-only skills as low risk and scripts/tool requests as high", () => {
    const low = analyzeSkillRisk(
      parseSkillMarkdown("# Summary Helper\n\nSummarize the supplied source material."),
    );
    expect(low.risk_level).toBe("low");

    const high = analyzeSkillRisk(
      parseSkillMarkdown([
        "---",
        "name: Shell Helper",
        "description: Runs local scripts.",
        "allowed-tools: Bash",
        "---",
        "",
        "Run npm install and execute the provided script.",
      ].join("\n")),
    );
    expect(high.risk_level).toBe("high");
    expect(high.warnings).toContain("shell_or_subprocess_permission_requested");
  });
});

describe("skill import preview", () => {
  it("rejects unsupported URLs before fetching", async () => {
    await expect(
      previewSkillImport(
        { url: "https://example.com/SKILL.md" },
        async () => {
          throw new Error("fetch should not run");
        },
      ),
    ).rejects.toThrow(/unsupported_skill_source/);
  });

  it("normalizes GitHub SKILL.md URLs and never executes scripts during preview", async () => {
    const preview = await previewSkillImport(
      { url: "https://github.com/org/repo/blob/main/skills/demo/SKILL.md" },
      async (url) => ({
        finalUrl: url,
        body: [
          "---",
          "name: Demo Skill",
          "description: Demonstrates preview.",
          "---",
          "",
          "Follow instructions without side effects.",
        ].join("\n"),
      }),
    );
    expect(preview.source.repo).toBe("org/repo");
    expect(preview.source.path).toBe("skills/demo/SKILL.md");
    expect(preview.package_root).toBe("skills/demo");
    expect(preview.package_files).toHaveLength(1);
    expect(preview.normalized_skill.name).toBe("Demo Skill");
    expect(preview.risk_level).toBe("low");
  });

  it("imports package tree text resources with hashes", async () => {
    const fetchedUrls: string[] = [];
    const preview = await previewSkillImport(
      { url: "https://github.com/org/repo/blob/main/skills/demo/SKILL.md" },
      {
        commitResolver: null,
        packageLister: async () => [
          { path: "skills/demo/SKILL.md", type: "blob", size: 96, sha: "skill-sha" },
          { path: "skills/demo/guide.md", type: "blob", size: 29, sha: "guide-sha" },
        ],
        fetcher: async (url) => {
          fetchedUrls.push(url);
          if (url.endsWith("/skills/demo/SKILL.md")) {
            return {
              contentType: "text/markdown",
              body: [
                "---",
                "name: Resource Skill",
                "description: Uses a local guide.",
                "references:",
                "  - guide.md",
                "---",
                "",
                "Follow the guide.",
              ].join("\n"),
            };
          }
          if (url.endsWith("/skills/demo/guide.md")) {
            return { contentType: "text/markdown", body: "# Guide\n\nUse bounded context." };
          }
          throw new Error(`unexpected fetch ${url}`);
        },
      },
    );

    expect(fetchedUrls).toEqual([
      "https://raw.githubusercontent.com/org/repo/main/skills/demo/SKILL.md",
      "https://raw.githubusercontent.com/org/repo/main/skills/demo/guide.md",
    ]);
    expect(preview.files_detected).toEqual([
      "skills/demo/SKILL.md",
      "skills/demo/guide.md",
    ]);
    expect(preview.package_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.normalized_skill.resources[1]).toMatchObject({
      path: "guide.md",
      kind: "reference",
      content_type: "text/markdown",
      byte_length: 29,
    });
    expect(preview.normalized_skill.resources[1]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("treats GitHub tree URLs as skill package roots and flags scripts", async () => {
    const commit = "a".repeat(40);
    const preview = await previewSkillImport(
      { url: "https://github.com/org/repo/tree/main/skills/demo" },
      {
        commitResolver: async () => commit,
        packageLister: async (source) => {
          expect(source.packageRoot).toBe("skills/demo");
          expect(source.skillPath).toBe("skills/demo/SKILL.md");
          expect(source.commitSha).toBe(commit);
          return [
            { path: "skills/demo/SKILL.md", type: "blob", size: 90, sha: "skill-sha" },
            { path: "skills/demo/references/guide.md", type: "blob", size: 20, sha: "guide-sha" },
            { path: "skills/demo/scripts/run.py", type: "blob", size: 18, sha: "script-sha", mode: "100755" },
            { path: "skills/demo/assets/logo.png", type: "blob", size: 4096, sha: "asset-sha" },
          ];
        },
        fetcher: async (url) => {
          expect(url).toContain(`/org/repo/${commit}/`);
          if (url.endsWith("/skills/demo/SKILL.md")) {
            return {
              contentType: "text/markdown",
              body: "---\nname: Package Skill\ndescription: Package import.\n---\n\nUse package files.",
            };
          }
          if (url.endsWith("/skills/demo/references/guide.md")) {
            return { contentType: "text/markdown", body: "# Guide\n" };
          }
          if (url.endsWith("/skills/demo/scripts/run.py")) {
            return { contentType: "text/x-python", body: "print('review only')\n" };
          }
          throw new Error(`unexpected fetch ${url}`);
        },
      },
    );

    expect(preview.package_root).toBe("skills/demo");
    expect(preview.files_detected).toEqual([
      "skills/demo/SKILL.md",
      "skills/demo/assets/logo.png",
      "skills/demo/references/guide.md",
      "skills/demo/scripts/run.py",
    ]);
    expect(preview.package_files.find((file) => file.path.endsWith("scripts/run.py"))).toMatchObject({
      kind: "script",
      included: true,
      executable: true,
      risk_flags_json: { script: true, executable: true },
    });
    expect(preview.package_files.find((file) => file.path.endsWith("assets/logo.png"))).toMatchObject({
      kind: "asset",
      included: false,
      content_hash: "git:asset-sha",
    });
    expect(preview.warnings).toContain("script_files_detected");
    expect(preview.risk_level).toBe("high");
  });

  it("rejects package trees that exceed the file-count cap", async () => {
    await expect(
      previewSkillImport(
        { url: "https://github.com/org/repo/tree/main/skills/huge" },
        {
          commitResolver: null,
          packageLister: async () => [
            { path: "skills/huge/SKILL.md", type: "blob", size: 80, sha: "skill-sha" },
            ...Array.from({ length: 201 }, (_, index) => ({
              path: `skills/huge/references/${index}.md`,
              type: "blob" as const,
              size: 4,
              sha: `sha-${index}`,
            })),
          ],
          fetcher: async () => ({
            contentType: "text/markdown",
            body: "---\nname: Huge Skill\ndescription: Too many files.\n---\n\nStop.",
          }),
        },
      ),
    ).rejects.toThrow(/too many files/);
  });

  it("rejects optional resources outside the skill directory tree", async () => {
    await expect(
      previewSkillImport(
        { url: "https://github.com/org/repo/blob/main/skills/demo/SKILL.md" },
        async () => ({
          contentType: "text/markdown",
          body: [
            "---",
            "name: Escape Skill",
            "description: References outside its directory.",
            "references:",
            "  - ../secret.md",
            "---",
            "",
            "Try to read more files.",
          ].join("\n"),
        }),
      ),
    ).rejects.toThrow(/Optional skill resource path is invalid/);
  });
});

describe("runtime skill renderers", () => {
  it("renders deterministic Claude, Codex, and generic prompt content", () => {
    const capability = listBuiltInCapabilityDefinitions().find((item) => item.id === "research.brief_synthesize")!;
    const rendered = renderAllRuntimeSkills({ capability, profile: { z: 1, a: 2 } });

    expect(rendered.map((item) => item.runtime_adapter_type)).toEqual([
      "claude_code",
      "codex_cli",
      "model_api",
    ]);
    expect(rendered[0]!.files[0]!.content).toContain("Treat this file as generated adapter content");
    expect(rendered[1]!.files.map((file) => file.path)).toContain(
      ".agent-space/generated-skills/codex/research-brief-synthesize/agents/openai.yaml",
    );
    expect(rendered[2]!.prompt_block).toContain(`Capability ID: ${capability.id}`);
    expect(renderAllRuntimeSkills({ capability, profile: { z: 1, a: 2 } })).toEqual(rendered);
  });
});
