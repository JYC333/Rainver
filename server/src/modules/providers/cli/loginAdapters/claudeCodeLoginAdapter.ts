import { loginFieldsFromSpec, type CliLoginAdapter } from "./types.js";

export const claudeCodeLoginAdapter: CliLoginAdapter = {
  runtime: "claude_code",
  method: "cli",
  ...loginFieldsFromSpec("claude_code"),
  // ACP runtime replatform P4: conversation execution resolves the bundled
  // claude-agent-acp adapter, while login still needs the vendor CLI's
  // terminal-sensitive `/login` flow to create the shared Claude profile.
  resolve_vendor_cli: true,
  label: "Claude Code",
  target_path: "/home/agent/.claude",
};
