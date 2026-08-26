import { claudeCodeLoginAdapter } from "./claudeCodeLoginAdapter.js";
import { codexLoginAdapter } from "./codexLoginAdapter.js";
import { geminiLoginAdapter } from "./geminiLoginAdapter.js";
import { opencodeLoginAdapter } from "./opencodeLoginAdapter.js";
import type { CliLoginAdapter } from "./types.js";

export type { CliLoginAdapter } from "./types.js";

export const CLI_LOGIN_ADAPTERS: CliLoginAdapter[] = [
  claudeCodeLoginAdapter,
  codexLoginAdapter,
  opencodeLoginAdapter,
  geminiLoginAdapter,
];

export const CLI_LOGIN_ADAPTERS_BY_RUNTIME: Record<string, CliLoginAdapter> = Object.fromEntries(
  CLI_LOGIN_ADAPTERS.map((adapter) => [adapter.runtime, adapter]),
);

export function cliLoginAdapterFor(runtime: string): CliLoginAdapter | undefined {
  return CLI_LOGIN_ADAPTERS_BY_RUNTIME[runtime];
}
