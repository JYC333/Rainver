import { describe, expect, it } from "vitest";
import { deriveAmbientActivity } from "../src/ambientSessions.js";

describe("deriveAmbientActivity", () => {
  // Fed to the session page's header and to the summarizer's prompt alike;
  // one implementation, so the two cannot describe one session differently.
  it("reads files and commands out of tool calls and nothing else", () => {
    const derived = deriveAmbientActivity([
      { kind: "user_message", tool_input: '"src/never.ts"' },
      { kind: "tool_call", tool_name: "Edit", tool_status: "ok", tool_input: '{"file_path":"src/app.ts"}' },
      { kind: "tool_call", tool_name: "Bash", tool_status: null, tool_input: "cat './notes/a.md' '/abs/path/b.py'" },
      { kind: "tool_call", tool_name: null, tool_input: null },
    ]);
    expect(derived.files).toEqual(["src/app.ts", "./notes/a.md", "/abs/path/b.py"]);
    expect(derived.commands).toEqual([
      { tool: "Edit", status: "ok" },
      { tool: "Bash", status: null },
      { tool: "tool", status: null },
    ]);
  });

  it("names each file once", () => {
    const derived = deriveAmbientActivity([
      { kind: "tool_call", tool_name: "Read", tool_input: '"src/app.ts"' },
      { kind: "tool_call", tool_name: "Edit", tool_input: '"src/app.ts"' },
    ]);
    expect(derived.files).toEqual(["src/app.ts"]);
  });
});

import { AmbientImportPolicySchema, AmbientSessionCountSchema } from '../src/ambientSessions.js';
import { HOST_DIRECT_OPERATION_SCHEMAS } from '../src/hostOperations.js';

it('keeps old-host discovery unknown and bounds new content-free discovery inventory', () => {
  const old = { location_id: 'location', runtime_key: 'codex_cli', installation: 'own', session_count: 1, oldest_updated_at: null, newest_updated_at: null, error: null };
  expect(AmbientSessionCountSchema.parse(old).sessions).toBeUndefined();
  const inventory = [{ session_id: 'one', updated_at: null, title: 'must not cross this contract', cwd: '/private' }];
  expect(AmbientSessionCountSchema.parse({ ...old, sessions: inventory }).sessions).toEqual([{ session_id: 'one', updated_at: null }]);
  expect(AmbientSessionCountSchema.safeParse({ ...old, sessions: Array(51).fill(inventory[0]) }).success).toBe(false);
});
it('does not interpret legacy offered_at as permanent opt-out and requires an explicit reminder choice', () => {
  expect(AmbientImportPolicySchema.parse({ offered_at: '2026-01-01' }).reminder).toBeUndefined();
  const input = HOST_DIRECT_OPERATION_SCHEMAS['host.location.ambient.reminder.set'].input;
  expect(input.safeParse({ location_id: 'location' }).success).toBe(false);
  expect(input.parse({ location_id: 'location', mode: 'never' }).mode).toBe('never');
  expect(input.safeParse({ location_id: 'location', mode: 'never', sync: true }).success).toBe(false);
});
