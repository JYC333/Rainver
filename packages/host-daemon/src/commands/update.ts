import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UpdateHostOptions {
  autoUpdate?: "enable" | "disable";
  channel?: "stable" | "edge" | "nightly";
}

/** The installer exports this for non-default installation roots. */
export function hostInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAINVER_HOST_INSTALL_ROOT
    ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "rainver-host");
}

export async function updateHost(
  options: UpdateHostOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (process.platform !== "linux") throw new Error("rainver-host update currently supports Linux only");

  const installer = join(hostInstallRoot(env), "install-host.sh");
  try {
    await access(installer, constants.R_OK);
  } catch {
    throw new Error(`Updater not found at ${installer}; reinstall Rainver Host with the Linux installer`);
  }

  const args = [installer, "--update"];
  if (options.channel) args.push("--channel", options.channel);
  if (options.autoUpdate === "enable") args.push("--auto-update");
  if (options.autoUpdate === "disable") args.push("--no-auto-update");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/bash", args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Updater failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`));
    });
  });
}
