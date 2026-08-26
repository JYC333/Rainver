import type { LoginEvent, LoginOutputParser } from "../loginEngine.js";
import type { CliLoginAdapter } from "./types.js";

const CODEX_DEVICE_AUTH_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device\b/;
const DEVICE_CODE_RE = /\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/;
const DEVICE_EXPIRES_RE = /expires in\s+(\d+)\s+minutes?/i;

function parseDeviceAuth(
  text: string,
  stripAnsi: (value: string) => string,
): Omit<LoginEvent, "type"> | null {
  const cleaned = stripAnsi(text);
  const url = cleaned.match(CODEX_DEVICE_AUTH_URL_RE)?.[0];
  const code = cleaned.match(DEVICE_CODE_RE)?.[0];
  if (!url || !code) return null;
  const expires = cleaned.match(DEVICE_EXPIRES_RE)?.[1];
  return {
    url,
    code,
    ...(expires ? { expires_in_minutes: Number(expires) } : {}),
  };
}

function createCodexOutputParser(): LoginOutputParser {
  let lastDeviceAuthKey = "";
  return ({ buffer, stripAnsi }) => {
    const deviceAuth = parseDeviceAuth(buffer, stripAnsi);
    if (!deviceAuth) return {};

    const key = `${deviceAuth.url}|${deviceAuth.code}`;
    const events: LoginEvent[] = [];
    if (key !== lastDeviceAuthKey) {
      lastDeviceAuthKey = key;
      events.push({ type: "device_auth", ...deviceAuth });
    }
    return { events, suppressDefaultCodePrompt: true };
  };
}

export const codexLoginAdapter: CliLoginAdapter = {
  runtime: "codex_cli",
  method: "cli",
  command: ["codex", "login", "--device-auth"],
  // ACP runtime replatform P3: resolveForExecution("codex_cli") now
  // resolves the codex-acp ACP adapter, which does not support
  // --device-auth — this flow needs the bundled vendor `codex` CLI instead.
  resolve_vendor_cli: true,
  home_subdir: ".codex",
  credential_file: "auth.json",
  label: "Codex CLI",
  target_path: "/home/agent/.codex",
  hint_cli: "Open the device-auth URL in your browser, then enter the one-time code shown here.",
  createOutputParser: createCodexOutputParser,
};
