import { OWN_CLI_UPDATE_PACKAGES, type HostServerFrameOf, type OwnCliUpdateRuntimeKey } from "@rainver/protocol";
import { mkdtemp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { probeVersion } from "./capabilities.js";
import { probeAcpIdentity } from "./acpProbe.js";
import { ensurePackagedAdapter, resolvePackagedAdapter } from "./adapterInstallation.js";
import { helperProcessEnv } from "./providerBinding.js";
import { managedNativeExecutable, managedInstallationId, managedVersionsFor, managedToolTree, materializeRuntimeDistribution, renderManagedLoginCommand, type ToolManifest } from "./tools.js";

const managedCliEnvKey = (key: OwnCliUpdateRuntimeKey): string => key === "codex_cli" ? "CODEX_PATH" : "CLAUDE_CODE_EXECUTABLE";

function selectCli(tool: ToolManifest, key: OwnCliUpdateRuntimeKey, executable: string | null, version: string | null): ToolManifest {
  const env = { ...tool.env }, envKey = managedCliEnvKey(key);
  if (executable) env[envKey] = executable;
  else delete env[envKey];
  const tree = managedToolTree(key, managedInstallationId(tool.version))!;
  return { ...tool, env, runtime_version: version, login_command: executable && tool.login
    ? [executable, ...tool.login.command.slice(1)] : renderManagedLoginCommand(tree, tool.login) };
}

async function verify(tool: ToolManifest, key: OwnCliUpdateRuntimeKey): Promise<void> {
  const command = key === "codex_cli" ? "codex-acp" : "claude-agent-acp";
  if (!(await ensurePackagedAdapter(command))) throw new Error("The Host adapter pack is unavailable");
  const entry = resolvePackagedAdapter(command);
  if (!entry) throw new Error("Update this Host to install its ACP adapter pack");
  const home = await mkdtemp(join(tmpdir(), "rainver-cli-health-"));
  try {
    const executable = managedNativeExecutable(tool);
    if (!executable) throw new Error("This managed CLI has no executable");
    const env = { ...helperProcessEnv(process.env, key), ...tool.env, [managedCliEnvKey(key)]: executable,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
      XDG_STATE_HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, ".claude"), DISABLE_AUTOUPDATER: "1" };
    const result = await probeAcpIdentity(process.execPath, [entry], env, home);
    if (!result) throw new Error("The CLI did not pass the installed ACP adapter's health check");
  } finally { await rm(home, { recursive: true, force: true }); }
}

export async function manageCli(frame: HostServerFrameOf<"managed_cli">, log: (line: string) => void) {
  const key = frame.runtime_key, tool = managedVersionsFor(key)[0];
  if (!tool) throw new Error("Install this managed CLI first");
  if (frame.operation.action === "update" && tool.runtime_version?.match(/\b\d+\.\d+\.\d+\b/)?.[0] === frame.operation.version) {
    const executable = managedNativeExecutable(tool);
    const actual = executable ? await probeVersion(executable, 4000, { env: { ...helperProcessEnv(process.env, key), HOME: tool.home } }) : null;
    if (actual?.match(/\b\d+\.\d+\.\d+\b/)?.[0] === frame.operation.version) return {
      installation: managedInstallationId(tool.version), from_version: tool.runtime_version, to_version: tool.runtime_version,
    };
  }
  const tree = managedToolTree(key, managedInstallationId(tool.version))!;
  const previous = { executable: tool.env[managedCliEnvKey(key)] ?? null, version: tool.runtime_version };
  let candidate: string | undefined;
  let next: ToolManifest;
  try {
    if (frame.operation.action === "rollback") {
      if (!tool.previous_cli) throw new Error("No previous native CLI version is available");
      next = selectCli(tool, key, tool.previous_cli.executable, tool.previous_cli.version);
    } else {
      const root = join(tree, "native-cli");
      await mkdir(root, { recursive: true });
      candidate = await mkdtemp(join(root, `${frame.operation.version}-`));
      await materializeRuntimeDistribution({ kind: "npx", package: `${OWN_CLI_UPDATE_PACKAGES[key]}@${frame.operation.version}`, args: [], env: {} }, candidate, log);
      const executable = join(candidate, "node_modules", ".bin", key === "codex_cli" ? "codex" : "claude");
      const version = await probeVersion(executable, 4000, { env: { ...helperProcessEnv(process.env, key), HOME: tool.home } });
      if (version?.match(/\b\d+\.\d+\.\d+\b/)?.[0] !== frame.operation.version) throw new Error("The installed CLI did not report the requested version");
      next = selectCli(tool, key, executable, version);
    }
    await verify(next, key);
    next.previous_cli = previous;
    const target = join(tree, "manifest.json"), temporary = `${target}.cli-${process.pid}`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    candidate = undefined;
    const nativeRoot = join(tree, "native-cli");
    try {
      for (const name of await readdir(nativeRoot)) {
        const path = join(nativeRoot, name);
        if (![next.env[managedCliEnvKey(key)], previous.executable].some(executable => executable?.startsWith(path + sep))) await rm(path, { recursive: true, force: true });
      }
    } catch (error) { log(`CLI binary cleanup: ${String(error)}`); }
    return { installation: managedInstallationId(tool.version), from_version: tool.runtime_version, to_version: next.runtime_version };
  } finally { if (candidate) await rm(candidate, { recursive: true, force: true }); }
}
