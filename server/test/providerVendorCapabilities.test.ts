import { describe, expect, it } from "vitest";
import { providerSupportsTask } from "../src/modules/providers/commands/store";
import { piStructuredToolChoice } from "../src/modules/providers/invocation/piAiChat";
import { providerSupportsStructuredOutput } from "../src/modules/providers/structuredOutputCapabilities";
import { providerVendor } from "../src/modules/providers/vendors";

describe("provider vendor capabilities", () => {
  it("uses the vendor registry for OpenAI Codex managed capabilities", () => {
    expect(providerVendor("openai_codex")).toMatchObject({
      supportsChat: true,
      supportsRuntimeTools: true,
      supportsStructuredOutput: true,
    });
    expect(providerSupportsStructuredOutput("openai_codex")).toBe(true);
    expect(piStructuredToolChoice("openai_codex_responses", "structured_output")).toBe("required");
    expect(providerSupportsTask("retrieval_query_rewrite", "openai_codex")).toBe(false);
    expect(providerSupportsTask("retrieval_synthesis", "openai_codex")).toBe(false);
  });

  it("fails closed for unknown provider types", () => {
    expect(providerSupportsStructuredOutput("unknown_vendor")).toBe(false);
  });
});
