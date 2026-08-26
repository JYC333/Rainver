import type { CliLoginAdapter } from "./types.js";

export const opencodeLoginAdapter: CliLoginAdapter = {
  runtime: "opencode",
  method: "cli",
  command: ["opencode", "auth", "login"],
  home_subdir: ".local/share/opencode",
  credential_file: "auth.json",
  label: "OpenCode",
  target_path: "/home/agent/.local/share/opencode",
  hint_cli: "Follow the prompts to complete login.",
};
