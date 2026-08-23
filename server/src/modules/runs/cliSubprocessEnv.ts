const ENV_ALLOWED_KEYS = new Set(["PATH", "TERM", "SHELL", "LANG"]);
const BROKER_ENV_KEYS = new Set(["HOME"]);
const RUNTIME_ENV_KEYS = new Set([
  "CODEX_HOME",
  "NO_BROWSER",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "AGENT_SPACE_EXCHANGE_INPUT",
  "AGENT_SPACE_EXCHANGE_OUTPUT",
  "AGENT_SPACE_MCP_URL",
  "AGENT_SPACE_TOOL_TOKEN",
]);

export function buildSubprocessEnv(
  extra: Record<string, string> | null | undefined,
  runtimeEnv: Record<string, string> | null | undefined = null,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWED_KEYS.has(key) || key.startsWith("LC_")) safe[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (BROKER_ENV_KEYS.has(key)) safe[key] = value;
  }
  for (const [key, value] of Object.entries(runtimeEnv ?? {})) {
    if (RUNTIME_ENV_KEYS.has(key)) safe[key] = value;
  }
  return safe;
}
