import type { CliLoginAdapter } from "./types";

export const claudeCodeLoginAdapter: CliLoginAdapter = {
  runtime: "claude_code",
  method: "cli",
  command: ["claude", "/login"],
  // ACP runtime replatform P4: conversation execution resolves the bundled
  // claude-agent-acp adapter, while login still needs the vendor CLI's
  // terminal-sensitive `/login` flow to create the shared Claude profile.
  resolve_vendor_cli: true,
  home_subdir: ".claude",
  // `claude /login` exits non-zero from its REPL; the credential file is the
  // reliable success signal the sync step keys on.
  credential_file: ".credentials.json",
  label: "Claude Code",
  target_path: "/home/agent/.claude",
  hint_cli: "A browser URL will appear - open it to authorize your Claude.ai account.",
};
