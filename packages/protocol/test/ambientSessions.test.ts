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
