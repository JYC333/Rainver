import { describe, expect, it } from "vitest";
import { PromptAssetContentSchema, PromptPromotionResultSchema } from "../src/prompts";

describe("PromptPromotionResultSchema", () => {
  it("points at the promotion Proposal by proposal_id", () => {
    expect(
      PromptPromotionResultSchema.parse({ proposal_id: "proposal-1", status: "pending", proposal_type: "prompt_promotion" }).proposal_id,
    ).toBe("proposal-1");
    expect(PromptPromotionResultSchema.safeParse({ id: "proposal-1", status: "pending" }).success).toBe(false);
  });
});

describe("PromptAssetContentSchema", () => {
  it("accepts exactly one renderable prompt body", () => {
    expect(
      PromptAssetContentSchema.parse({
        schema_version: "prompt_asset.v1",
        prompt_type: "text",
        template: "Hello {name}",
      }),
    ).toMatchObject({
      prompt_type: "text",
      template: "Hello {name}",
      rendering: { engine: "plain" },
    });
  });

  it("rejects missing or ambiguous prompt bodies", () => {
    expect(() =>
      PromptAssetContentSchema.parse({
        schema_version: "prompt_asset.v1",
        prompt_type: "text",
      }),
    ).toThrow(/exactly one of messages or template/);

    expect(() =>
      PromptAssetContentSchema.parse({
        schema_version: "prompt_asset.v1",
        prompt_type: "chat",
        messages: [{ role: "system", content: "System" }],
        template: "Template",
      }),
    ).toThrow(/exactly one of messages or template/);
  });

  it("rejects unsupported rendering engines", () => {
    expect(() =>
      PromptAssetContentSchema.parse({
        schema_version: "prompt_asset.v1",
        prompt_type: "text",
        template: "Hello",
        rendering: { engine: "mustache" },
      }),
    ).toThrow();
  });
});
