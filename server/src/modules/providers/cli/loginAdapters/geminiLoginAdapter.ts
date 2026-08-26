import type { CliLoginAdapter } from "./types.js";

export const geminiLoginAdapter: CliLoginAdapter = {
  runtime: "gemini_cli",
  method: "cli",
  command: ["gemini", "auth"],
  home_subdir: ".gemini",
  label: "Gemini CLI",
  target_path: "/home/agent/.gemini",
  hint_cli: "A browser URL will appear - open it to authorize Gemini CLI.",
};
