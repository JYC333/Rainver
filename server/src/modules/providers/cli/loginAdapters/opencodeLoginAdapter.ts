import { loginFieldsFromSpec, type CliLoginAdapter } from "./types.js";

export const opencodeLoginAdapter: CliLoginAdapter = {
  runtime: "opencode",
  method: "cli",
  ...loginFieldsFromSpec("opencode"),
  label: "OpenCode",
  target_path: "/home/agent/.local/share/opencode",
};
