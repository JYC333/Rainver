import { rm, stat } from "node:fs/promises";

export const UPDATE_RESTART_POLL_MS = 30_000;

/** The installer must be noticed even while an outdated Host backs off offline. */
export async function waitForReconnectOrUpdate(
  delayMs: number,
  requestPath: string,
  isBusy: () => boolean,
  log: (message: string) => void,
): Promise<"reconnect" | "update"> {
  const deadline = Date.now() + delayMs;
  for (;;) {
    if (!isBusy()) {
      try {
        await stat(requestPath);
        // An existing launch may advance while the filesystem call is pending.
        if (!isBusy()) {
          await rm(requestPath, { force: true });
          return "update";
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          log(`could not inspect update request: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "reconnect";
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(remaining, UPDATE_RESTART_POLL_MS)));
  }
}
