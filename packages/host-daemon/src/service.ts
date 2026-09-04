import { execFile } from "node:child_process";

type ServiceCommandRunner = (command: string, args: string[]) => Promise<void>;

const runServiceCommand: ServiceCommandRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, (error) => error ? reject(error) : resolve());
});

/**
 * A source-checkout CLI has no install root and leaves process management to
 * its caller. The installed launcher exports the root, so registration can
 * finish the product flow by enabling and starting its systemd user service.
 */
export async function startInstalledService(
  env: NodeJS.ProcessEnv = process.env,
  run: ServiceCommandRunner = runServiceCommand,
): Promise<boolean> {
  if (process.platform !== "linux" || !env.RAINVER_HOST_INSTALL_ROOT) return false;
  await run("systemctl", ["--user", "enable", "--now", "rainver-host.service"]);
  return true;
}

/** Stops future background connections before the local bearer credential is forgotten. */
export async function stopInstalledService(
  env: NodeJS.ProcessEnv = process.env,
  run: ServiceCommandRunner = runServiceCommand,
): Promise<boolean> {
  if (process.platform !== "linux" || !env.RAINVER_HOST_INSTALL_ROOT) return false;
  await run("systemctl", ["--user", "disable", "--now", "rainver-host.service"]);
  return true;
}

/**
 * Used by the daemon after a server-driven revoke. Disabling is safe from
 * inside the service; `--now` would ask systemd to kill the caller while it
 * is still removing credentials.
 */
export async function disableInstalledService(
  env: NodeJS.ProcessEnv = process.env,
  run: ServiceCommandRunner = runServiceCommand,
): Promise<boolean> {
  if (process.platform !== "linux" || !env.RAINVER_HOST_INSTALL_ROOT) return false;
  await run("systemctl", ["--user", "disable", "rainver-host.service"]);
  return true;
}
