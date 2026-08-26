import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPromptManifests } from "../src/modules/prompts/builtins.js";

// The real catalog/prompts directory next to server/ — matches config.ts's
// default catalogRoot resolution (resolve(process.cwd(), "..", "catalog")).
const REAL_CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");

const EXPECTED_ASSET_KEYS = [
  "agent.default_assistant.system",
  "agent_template.coding_reviewer.system",
  "agent_template.activity_reflector.system",
  "agent_template.research_reader.system",
  "agent_template.knowledge_curator.system",
  "agent_template.personal_assistant.system",
  "agent_template.memory_reflector.system",
  "inquiry.next_step_advice",
  "project_research.evidence_card",
  "project_research.monitor_compare",
  "project_research.question_refine",
  "project_research.question_subquestion_repair",
  "project_research.synthesis",
  "project_research.synthesis_critique",
  "research_engine.query_plan",
  "research_query.intent_plan",
  "retrieval.query_rewrite",
  "retrieval.rerank",
  "retrieval.synthesis",
];

async function writeManifest(catalogRoot: string, fileName: string, yaml: string): Promise<void> {
  const promptsDir = join(catalogRoot, "prompts");
  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, fileName), yaml, "utf8");
}

describe("loadPromptManifests (real catalog/prompts)", () => {
  it("loads exactly the built-in inventory's canonical asset keys with valid prompt_asset.v1 content", async () => {
    const manifests = await loadPromptManifests(REAL_CATALOG_ROOT);
    expect(manifests.map((m) => m.assetKey).sort()).toEqual([...EXPECTED_ASSET_KEYS].sort());
    for (const manifest of manifests) {
      expect(manifest.content.schema_version).toBe("prompt_asset.v1");
      expect(manifest.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("keeps a complete parseable JSON example at the end of every structured research prompt", async () => {
    const manifests = await loadPromptManifests(REAL_CATALOG_ROOT);
    const expectedTopLevelKeys: Record<string, string[]> = {
      "project_research.evidence_card": ["schema", "digest_markdown", "item_summaries", "item_decisions", "evidence_candidates", "proposal_markdown"],
      "project_research.monitor_compare": ["comparisons"],
      "project_research.question_refine": ["reply", "recommended_question", "assessment", "suggested_questions", "sub_questions", "scope", "clarifying_questions"],
      "project_research.question_subquestion_repair": ["reply", "repairs"],
      "project_research.synthesis": ["status", "artifacts"],
      "project_research.synthesis_critique": ["verdict", "issues"],
      "research_engine.query_plan": ["providers", "filters", "time_window"],
      "research_query.intent_plan": ["core", "expansions", "qualifiers", "exclusions"],
    };
    for (const [assetKey, keys] of Object.entries(expectedTopLevelKeys)) {
      const template = manifests.find((manifest) => manifest.assetKey === assetKey)?.content.template ?? "";
      const marker = template.lastIndexOf("Valid ");
      const jsonStart = template.indexOf("{", marker);
      expect(marker, `${assetKey} must end with a valid JSON example`).toBeGreaterThanOrEqual(0);
      expect(jsonStart, `${assetKey} JSON example must contain an object`).toBeGreaterThan(marker);
      const example = JSON.parse(template.slice(jsonStart).trim()) as Record<string, unknown>;
      expect(Object.keys(example), `${assetKey} example top-level structure`).toEqual(keys);
    }
  });

  it("requires question refinement to guide the next conversational turn", async () => {
    const manifests = await loadPromptManifests(REAL_CATALOG_ROOT);
    const content = manifests.find((manifest) => manifest.assetKey === "project_research.question_refine")?.content;
    const template = content?.template ?? "";
    expect(template).toMatch(/^You facilitate an ongoing research-question assessment conversation/);
    expect(template).not.toContain("{conversation_history}");
    expect(template).not.toContain("{project_name}");
    expect(content?.variables_schema).toMatchObject({ type: "object", properties: {} });
    expect(template).toContain("end with a concrete next question or choice");
    expect(template).toContain('placeholder text such as "test question"');
    expect(template).toContain("user to write a custom answer");
  });

  it("returns an empty list when the catalog has no prompts directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-manifests-empty-"));
    try {
      expect(await loadPromptManifests(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("computes the same content hash when semantically identical YAML changes field order", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "prompt-manifests-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "prompt-manifests-b-"));
    try {
      await writeManifest(
        dirA,
        "stable.yaml",
        [
          "asset_key: stable.prompt",
          "display_name: Stable",
          "content:",
          "  schema_version: prompt_asset.v1",
          "  prompt_type: text",
          "  template: Hello {name}",
          "  variables_schema:",
          "    type: object",
          "    required:",
          "      - name",
          "    properties:",
          "      name:",
          "        type: string",
        ].join("\n"),
      );
      await writeManifest(
        dirB,
        "stable.yaml",
        [
          "display_name: Stable",
          "asset_key: stable.prompt",
          "content:",
          "  variables_schema:",
          "    properties:",
          "      name:",
          "        type: string",
          "    required:",
          "      - name",
          "    type: object",
          "  template: Hello {name}",
          "  prompt_type: text",
          "  schema_version: prompt_asset.v1",
        ].join("\n"),
      );

      const [first] = await loadPromptManifests(dirA);
      const [second] = await loadPromptManifests(dirB);
      expect(first.contentHash).toBe(second.contentHash);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });
});

describe("loadPromptManifests validation", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("rejects a manifest missing asset_key", async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-manifests-"));
    await writeManifest(
      dir,
      "bad.yaml",
      "display_name: Bad\ncontent:\n  schema_version: prompt_asset.v1\n  prompt_type: chat\n",
    );
    await expect(loadPromptManifests(dir)).rejects.toThrow(/asset_key is required/);
  });

  it("rejects a duplicate asset_key across manifest files", async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-manifests-"));
    const yaml =
      "asset_key: dup.key\ndisplay_name: One\ncontent:\n  schema_version: prompt_asset.v1\n  prompt_type: chat\n  messages:\n    - role: system\n      content: hi\n";
    await writeManifest(dir, "a.yaml", yaml);
    await writeManifest(dir, "b.yaml", yaml);
    await expect(loadPromptManifests(dir)).rejects.toThrow(/Duplicate prompt asset_key 'dup.key'/);
  });

  it("rejects content that does not match prompt_asset.v1", async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-manifests-"));
    await writeManifest(
      dir,
      "invalid-content.yaml",
      "asset_key: invalid.content\ndisplay_name: Invalid\ncontent:\n  system_prompt: not the right shape\n",
    );
    await expect(loadPromptManifests(dir)).rejects.toThrow(/does not match prompt_asset\.v1/);
  });

  it("rejects prompt content with no renderable messages or template", async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-manifests-"));
    await writeManifest(
      dir,
      "empty-prompt.yaml",
      "asset_key: empty.prompt\ndisplay_name: Empty\ncontent:\n  schema_version: prompt_asset.v1\n  prompt_type: text\n",
    );
    await expect(loadPromptManifests(dir)).rejects.toThrow(/exactly one of messages or template/);
  });

  it("rejects unsupported rendering engines", async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-manifests-"));
    await writeManifest(
      dir,
      "unsupported-engine.yaml",
      [
        "asset_key: unsupported.engine",
        "display_name: Unsupported",
        "content:",
        "  schema_version: prompt_asset.v1",
        "  prompt_type: text",
        "  template: Hello",
        "  rendering:",
        "    engine: mustache",
      ].join("\n"),
    );
    await expect(loadPromptManifests(dir)).rejects.toThrow(/does not match prompt_asset\.v1/);
  });
});
