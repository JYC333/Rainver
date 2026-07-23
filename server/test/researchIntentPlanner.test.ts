import { describe, expect, it } from "vitest";
import type { ResearchContext } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { heuristicResearchIntent, RESEARCH_INTENT_OUTPUT_CONTRACT } from "../src/modules/research/queryPlanning/intentPlanner";

describe("ResearchIntentPlanner", () => {
  it("extracts bounded concepts instead of copying the research question", () => {
    const context: ResearchContext = {
      schema_version: "research_context.v1",
      objective: "How can retrieval augmented memory help an LLM agent preserve useful context across many separate user sessions without accumulating stale information?",
      sub_questions: ["Which evaluation benchmarks measure cross-session recall?"],
      in_scope: ["long-lived LLM agent memory systems"],
      out_of_scope: ["human autobiographical memory research"],
      must_have: ["must report an empirical evaluation method"],
      nice_to_have: ["public benchmark dataset"],
      time_window: null,
      source_scope: { providers: ["arxiv"], include_web: false },
    };

    const intent = heuristicResearchIntent(context);
    expect(intent.core[0]?.value).toBe("long lived LLM agent");
    expect(intent.core.map((concept) => concept.value)).not.toContain(context.objective);
    expect([...intent.core, ...intent.qualifiers, ...intent.exclusions].every((concept) => concept.value.split(" ").length <= 4)).toBe(true);
    expect(intent.qualifiers.map((concept) => concept.value)).toContain("evaluation");
    expect(intent.exclusions[0]?.value).toBe("human autobiographical memory research");
  });

  it("keeps provider-native fields out of the structured intent contract", () => {
    const properties = RESEARCH_INTENT_OUTPUT_CONTRACT.schema.properties;
    expect(Object.keys(properties)).toEqual(["core", "expansions", "qualifiers", "exclusions"]);
    expect(JSON.stringify(properties)).not.toContain("search_query");
    expect(JSON.stringify(properties)).not.toContain("provider_key");
  });

  it("segments an unspaced Chinese question instead of storing it as one long concept", () => {
    const context: ResearchContext = {
      schema_version: "research_context.v1",
      objective: "如何评估大型语言模型智能体在跨会话场景中的长期记忆检索能力和信息过期问题",
      sub_questions: [], in_scope: [], out_of_scope: [], must_have: [], nice_to_have: [],
      time_window: null,
      source_scope: { providers: ["openalex"], include_web: false },
    };
    const intent = heuristicResearchIntent(context);
    expect(intent.core).toHaveLength(3);
    expect(intent.core.every((concept) => concept.value.length < context.objective.length)).toBe(true);
  });
});
