/**
 * The single registry of per-model limits.
 *
 * A model's limits used to live in two unrelated places — output guidance here
 * in Providers, context-window sizing in the Usage model catalog — so adding a
 * model meant editing both and forgetting one was silent. It was: MiniMax-M3
 * had output guidance but no window, so Runtime Context planned every MiniMax
 * run against the generic 16k fallback and Project Research screening failed
 * with `required_context_overflow` on a model whose real window is half a
 * million tokens. One registry, one entry per model family.
 *
 * Entries match by pattern, not exact id, so provider-prefixed spellings
 * (`minimax/MiniMax-M3`) and family variants (`-highspeed`, `-lightning`) are
 * covered by the same row. `contextWindowTokens` and `recommendedMaxOutputTokens`
 * are vendor-published figures — cite the source in the comment above each row.
 * `defaultOutputReserveTokens` is ours: how much of the window to hold back for
 * the completion when a caller states no budget of its own. It is deliberately
 * not the model's maximum output — reserving a 200k ceiling out of a 200k
 * window would leave nothing to plan with.
 *
 * Vendor figures go stale as models ship, and a number with no provenance
 * cannot be re-checked, so every row carries `source` and `verifiedOn`. When
 * you touch a row, re-read its source and move the date; `modelSpecs.test.ts`
 * fails on a row that has neither.
 */
export interface ModelSpec {
  contextWindowTokens: number;
  defaultOutputReserveTokens: number;
  providerOverheadTokens: number;
  /** Vendor guidance for a request's completion cap; null when none is published. */
  recommendedMaxOutputTokens: number | null;
  /** Where the vendor figures came from. */
  source: string;
  /** ISO date the figures were last read from that source. */
  verifiedOn: string;
}

const PROVIDER_OVERHEAD_TOKENS = 512;
/** Reserve for large-window models with no published per-request guidance. */
const STANDARD_OUTPUT_RESERVE_TOKENS = 16_384;

const MODEL_SPECS: Array<{ pattern: RegExp; spec: ModelSpec }> = [
  // MiniMax M3 (minimax.io/models/text/m3): "up to 1M tokens context window
  // with a guaranteed minimum of 512K" — the guaranteed floor is what we plan
  // against. Recommended max output 131072, hard cap 524288.
  {
    pattern: /(^|\/)minimax-m3/i,
    spec: {
      contextWindowTokens: 512_000,
      defaultOutputReserveTokens: 131_072,
      providerOverheadTokens: PROVIDER_OVERHEAD_TOKENS,
      recommendedMaxOutputTokens: 131_072,
      source: "https://www.minimax.io/models/text/m3",
      verifiedOn: "2026-08-11",
    },
  },
  // MiniMax M2 family (M2, M2.1, M2.5, M2.7 and their -highspeed/-lightning
  // variants): 204800-token window covering input and output together.
  // MiniMax publishes no per-request output default for these, so we don't
  // invent one — callers keep whatever budget they set.
  {
    pattern: /(^|\/)minimax-m2/i,
    spec: {
      contextWindowTokens: 204_800,
      defaultOutputReserveTokens: STANDARD_OUTPUT_RESERVE_TOKENS,
      providerOverheadTokens: PROVIDER_OVERHEAD_TOKENS,
      recommendedMaxOutputTokens: null,
      source: "https://platform.minimax.io/docs/guides/text-generation",
      verifiedOn: "2026-08-11",
    },
  },
  // Anthropic Haiku 4.5: 200K context, 64K max output. Listed before the
  // general Claude row so the narrower window wins.
  {
    pattern: /(^|\/)claude-haiku-4-5/i,
    spec: {
      contextWindowTokens: 200_000,
      defaultOutputReserveTokens: STANDARD_OUTPUT_RESERVE_TOKENS,
      providerOverheadTokens: PROVIDER_OVERHEAD_TOKENS,
      recommendedMaxOutputTokens: null,
      source: "https://platform.claude.com/docs/en/about-claude/models/overview",
      verifiedOn: "2026-08-11",
    },
  },
  // Anthropic Opus/Sonnet 5 and the 4.6-4.8 family, plus Fable/Mythos 5:
  // 1M context, 128K max output.
  {
    pattern: /(^|\/)claude-(opus|sonnet|fable|mythos)-(5|4-[678])/i,
    spec: {
      contextWindowTokens: 1_000_000,
      defaultOutputReserveTokens: STANDARD_OUTPUT_RESERVE_TOKENS,
      providerOverheadTokens: PROVIDER_OVERHEAD_TOKENS,
      recommendedMaxOutputTokens: null,
      source: "https://platform.claude.com/docs/en/about-claude/models/overview",
      verifiedOn: "2026-08-11",
    },
  },
  // Anthropic Claude 3.5 Sonnet: 200K context.
  {
    pattern: /(^|\/)claude-3-5-sonnet/i,
    spec: {
      contextWindowTokens: 200_000,
      defaultOutputReserveTokens: STANDARD_OUTPUT_RESERVE_TOKENS,
      providerOverheadTokens: PROVIDER_OVERHEAD_TOKENS,
      recommendedMaxOutputTokens: null,
      source: "https://platform.claude.com/docs/en/about-claude/models/overview",
      verifiedOn: "2026-08-11",
    },
  },
  // OpenAI GPT-4o family: 128K context.
  {
    pattern: /(^|\/)gpt-4o/i,
    spec: {
      contextWindowTokens: 128_000,
      defaultOutputReserveTokens: STANDARD_OUTPUT_RESERVE_TOKENS,
      providerOverheadTokens: PROVIDER_OVERHEAD_TOKENS,
      recommendedMaxOutputTokens: null,
      source: "https://platform.openai.com/docs/models",
      verifiedOn: "2026-08-11",
    },
  },
];

/** Every registered row, for provenance checks. */
export function registeredModelSpecs(): ModelSpec[] {
  return MODEL_SPECS.map((entry) => entry.spec);
}

/** The registered spec for a model, or null when the model is not in the registry. */
export function modelSpec(model: string | null | undefined): ModelSpec | null {
  if (typeof model !== "string" || !model.trim()) return null;
  const trimmed = model.trim();
  return MODEL_SPECS.find((entry) => entry.pattern.test(trimmed))?.spec ?? null;
}
