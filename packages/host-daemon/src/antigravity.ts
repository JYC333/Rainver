import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Translate Rainver's profile selector to the official CLI's state-root flag. */
export async function prepareAntigravityProfile(stateDirectory: string | undefined, skillRoot?: string): Promise<string[]> {
  if (!stateDirectory || !isAbsolute(stateDirectory)) throw new Error("Antigravity requires an absolute profile state directory");
  if (skillRoot && !isAbsolute(skillRoot)) throw new Error("Antigravity requires an absolute delivered Skill root");
  const directory = join(stateDirectory, "config");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = join(directory, "skills.json");
  const staging = `${manifest}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, `${JSON.stringify({ entries: skillRoot ? [{ path: skillRoot }] : [] })}\n`, { mode: 0o600, flag: "wx" });
    await rename(staging, manifest);
  } finally {
    await rm(staging, { force: true });
  }
  return ["--gemini-dir", stateDirectory];
}
