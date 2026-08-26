import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class OpenCodeProviderConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OpenCodeProviderConfigError";
  }
}

export interface OpenCodeProviderConfigHandle {
  model: string;
  restore(): Promise<void>;
}

/**
 * Materializes a run-scoped OpenCode provider. The provider proxy token is
 * written only to the ephemeral project config and is revoked after the run;
 * it is never placed in the subprocess environment.
 */
export async function writeOpenCodeProviderConfig(input: {
  sandboxCwd: string | null;
  providerName: string;
  proxyBaseUrl: string;
  leaseToken: string;
  model: string;
  availableModels: string[];
}): Promise<OpenCodeProviderConfigHandle> {
  if (!input.sandboxCwd) {
    throw new OpenCodeProviderConfigError(
      "opencode_sandbox_required",
      "OpenCode provider configuration requires a sandbox working directory.",
    );
  }
  const configPath = resolve(input.sandboxCwd, "opencode.json");
  const root = resolve(input.sandboxCwd);
  if (!configPath.startsWith(`${root}/`)) {
    throw new OpenCodeProviderConfigError("opencode_config_path_invalid", "OpenCode config escapes the sandbox.");
  }
  let originalText: string | null = null;
  try {
    originalText = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw new OpenCodeProviderConfigError("opencode_config_invalid", "OpenCode project config could not be read.");
    }
  }
  const document = originalText === null ? {} : await parseJsonObject(originalText);
  applyOpenCodeProviderConfig(document, input);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600 });
  return {
    model: openCodeModelId(input.model),
    restore: async () => {
      if (originalText === null) {
        await rm(configPath, { force: true });
        return;
      }
      await writeFile(configPath, originalText, { encoding: "utf8", mode: 0o600 });
    },
  };
}

/** Not exported: `openCodeModelId` is how the rest of the server names it. */
const OPENCODE_PROVIDER_ID = "rainver_provider";

/**
 * How OpenCode addresses a bound model: `<providerId>/<model>`, where the
 * provider id is the one this module declares in the config. Every place that
 * needs the identifier calls this, so the config OpenCode reads and the value
 * ACP is told cannot drift apart.
 */
export function openCodeModelId(model: string): string {
  return `${OPENCODE_PROVIDER_ID}/${model}`;
}

/**
 * Merges the binding into an OpenCode config document, in place.
 *
 * Shared with the remote path so both produce the same provider block — the
 * `npm` field in particular is what makes a non-registry provider loadable at
 * all, and a second implementation is how that silently goes missing.
 */
export function applyOpenCodeProviderConfig(
  document: Record<string, unknown>,
  input: { providerName: string; proxyBaseUrl: string; leaseToken: string; model: string; availableModels: string[] },
): void {
  const providerId = OPENCODE_PROVIDER_ID;
  const provider = recordValue(document.provider);
  const models = { ...recordValue(provider.models) };
  for (const model of Array.from(new Set([input.model, ...input.availableModels].filter(Boolean)))) {
    models[model] = { ...recordValue(models[model]), name: model };
  }
  document.$schema = "https://opencode.ai/config.json";
  document.provider = {
    ...provider,
    [providerId]: {
      ...recordValue(provider[providerId]),
      npm: "@ai-sdk/openai-compatible",
      name: input.providerName,
      options: {
        ...recordValue(recordValue(provider[providerId]).options),
        baseURL: input.proxyBaseUrl,
        apiKey: input.leaseToken,
      },
      models,
    },
  };
}

async function parseJsonObject(text: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OpenCodeProviderConfigError("opencode_config_invalid", "OpenCode project config must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OpenCodeProviderConfigError) throw error;
    throw new OpenCodeProviderConfigError("opencode_config_invalid", "OpenCode project config must be valid JSON.");
  }
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}
