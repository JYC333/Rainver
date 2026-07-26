# Local CLI runtime output fixtures

Real structured output captured from the three implemented local CLI runtimes,
one conversation turn each, redacted. These exist so per-runtime output
parsing and runtime session handling are written against observed shapes
instead of assumed ones.

Captured 2026-07-26.

The Codex and OpenCode captures predate the conversation transport cutover to
Codex app-server and ACP. They remain measurement evidence for the G15 usage
and session-envelope work; current conversation transport behavior is covered
against the native protocol messages in the adapter tests, not by pretending
these older completion commands are the active execution path.

| File | Runtime | Command |
|---|---|---|
| `claude_code.turn.jsonl` | Claude Code 2.1.220 | `claude --print --output-format stream-json --verbose <prompt>` |
| `codex_cli.turn.jsonl` | Codex CLI 0.140.0 | `codex --ask-for-approval never exec --skip-git-repo-check --sandbox workspace-write --json <prompt>` |
| `opencode.turn.jsonl` | OpenCode 1.17.18 | `opencode run --format json <prompt>` |

## What these prove

The three envelopes share **no field names**. A shared substring heuristic
cannot extract usage or session identity from all three, which is why
`normalizeVendorEvents` currently extracts neither.

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| session id field | `session_id` | `thread_id` | `sessionID` |
| carried on | most events | `thread.started` only | every event |
| usage location | per-message `usage` | `turn.completed.usage` | `step_finish.part.tokens` |
| input | `input_tokens` | `input_tokens` | `tokens.input` |
| output | `output_tokens` | `output_tokens` | `tokens.output` |
| cache read | `cache_read_input_tokens` | `cached_input_tokens` | `tokens.cache.read` |
| cache write | `cache_creation_input_tokens` | `cache_write_input_tokens` | `tokens.cache.write` |
| reasoning | — | `reasoning_output_tokens` | `tokens.reasoning` |

All three report exact counts and separate cache reads from cache writes, so
`usage_accuracy: "precise"` is achievable for every implemented local CLI.

Two details that are easy to get wrong and are preserved deliberately:

- **Field order is not stable.** In `claude_code.turn.jsonl` the terminal event
  carries `"type":"result"` near the *end* of the line, not the start. Parsers
  must decode JSON, never pattern-match a line prefix.
- **Claude Code emits `rate_limit_event`** carrying `rateLimitType`,
  `utilization`, `resetsAt`, and `isUsingOverage` in the ordinary output
  stream. Live subscription-quota state needs no probe. Codex CLI and OpenCode
  emit no equivalent.

## Redaction

Structure, field names, nesting, and event order are byte-for-byte faithful.
Only these values were replaced, because runtime data and private figures must
not live in the source repo:

- absolute paths → `/workspace/project`, `/workspace/.claude`
- session ids, message/part ids, `request_id`, per-event `uuid` → fixed
  placeholders that keep each runtime's **id format** (Claude/Codex UUID,
  OpenCode `ses_`-prefixed opaque string)
- real quota `utilization` and real `total_cost_usd` / `costUSD` → arbitrary
  values
- the Claude `system` event's `tools` / `slash_commands` / `skills` / `agents`
  inventories → truncated to two entries plus `"..."`; they are environment
  specific and carry no parsing signal

Token counts, cache figures, timestamps, and every field name are unmodified —
those are what the parser is tested against.

The captured Claude command predates the conversation transport's
`--include-partial-messages` flag, so this fixture intentionally contains only
its final assistant envelope. Partial-event decoder coverage uses the
documented `stream_event.content_block_delta.text_delta` wire shape separately;
the measured fixture is not edited to impersonate a newer capture.

## Refreshing

These are version-pinned observations, not a contract. If a runtime changes its
output shape, recapture with the commands above and rerun the redaction
described here. Record the new tool version in the table.
