import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliRuntimeMeasurement } from "../src/modules/runs/cliRuntimeMeasurement";

const fixtureRoot = join(__dirname, "fixtures", "cliRuntimeOutput");

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, name), "utf8");
}

describe("parseCliRuntimeMeasurement", () => {
  it("extracts Claude terminal usage, opaque session id, and live quota", async () => {
    const result = parseCliRuntimeMeasurement(
      "claude_code",
      await fixture("claude_code.turn.jsonl"),
    );

    expect(result).toEqual({
      external_session_id: "11111111-2222-4333-8444-555555555555",
      usage: {
        input_tokens: 532,
        output_tokens: 18,
        total_tokens: 17_326,
        cache_creation_input_tokens: 16_776,
        cache_read_input_tokens: 0,
      },
      model_usage: [
        {
          model: "claude-haiku-4-5-20251001",
          usage: {
            input_tokens: 530,
            output_tokens: 14,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        {
          model: "claude-opus-5",
          usage: {
            input_tokens: 2,
            output_tokens: 4,
            cache_creation_input_tokens: 16_776,
            cache_read_input_tokens: 0,
          },
        },
      ],
      subscription_quota: {
        status: "allowed_warning",
        rate_limit_type: "seven_day",
        utilization: 0.42,
        resets_at: 1_785_427_200,
        is_using_overage: false,
      },
    });
  });

  it("rejects the entire Claude model breakdown when any model entry is incomplete", async () => {
    const lines = (await fixture("claude_code.turn.jsonl")).trim().split("\n");
    const terminal = JSON.parse(lines.at(-1)!) as {
      modelUsage: Record<string, Record<string, unknown>>;
    };
    delete terminal.modelUsage["claude-haiku-4-5-20251001"].outputTokens;
    lines[lines.length - 1] = JSON.stringify(terminal);

    expect(parseCliRuntimeMeasurement("claude_code", lines.join("\n"))).toMatchObject({
      usage: null,
      model_usage: [],
    });
  });

  it("extracts Codex completion usage and thread id", async () => {
    const result = parseCliRuntimeMeasurement(
      "codex_cli",
      await fixture("codex_cli.turn.jsonl"),
    );

    expect(result).toEqual({
      external_session_id: "019f0000-0000-7000-8000-000000000000",
      usage: {
        input_tokens: 4_105,
        output_tokens: 5,
        total_tokens: 17_166,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 13_056,
        reasoning_tokens: 0,
      },
      model_usage: [],
      subscription_quota: null,
    });
  });

  it("extracts OpenCode nested usage and opaque prefixed session id", async () => {
    const result = parseCliRuntimeMeasurement(
      "opencode",
      await fixture("opencode.turn.jsonl"),
    );

    expect(result).toEqual({
      external_session_id: "ses_00000000000000000000000000",
      usage: {
        input_tokens: 4_737,
        output_tokens: 4,
        total_tokens: 8_852,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4_096,
        reasoning_tokens: 15,
      },
      model_usage: [],
      subscription_quota: null,
    });
  });
});
