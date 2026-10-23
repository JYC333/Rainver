import { lstat, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { probeVersion } from "./capabilities.js";
import type { OwnToolUpdateRecipe } from "./ownToolUpdate.js";

/** Download and validate first; a failed npm install must not retire the working CLI. */
export async function updateOwnNpmTool(
  recipe: OwnToolUpdateRecipe,
  install: (recipe: Pick<OwnToolUpdateRecipe, "command" | "args" | "env">) => Promise<void>,
): Promise<string> {
  const npm = recipe.npm;
  if (!npm) throw new Error("This update recipe is not an npm installation");
  const prefixIndex = recipe.args.indexOf("--prefix") + 1;
  if (!prefixIndex || recipe.args[prefixIndex] !== npm.prefix) throw new Error("Invalid npm update prefix");
  const staging = await mkdtemp(join(npm.prefix, ".rainver-cli-update-"));
  const candidate = join(staging, "lib", "node_modules", npm.package);
  const candidateEntry = join(staging, "bin", npm.binary);
  const current = join(npm.prefix, "lib", "node_modules", npm.package);
  const previous = join(staging, "previous-package");
  const previousEntry = join(staging, "previous-entry");
  const env = { ...recipe.env, DISABLE_AUTOUPDATER: "1" };
  let preserveRecovery = false;
  try {
    const args = [...recipe.args];
    args[prefixIndex] = staging;
    await install({ command: recipe.command, args, env });
    if (!(await lstat(candidateEntry)).isSymbolicLink()) throw new Error("The new npm CLI has no executable link");
    const target = relative(candidate, await realpath(candidateEntry));
    if (!target || target === ".." || target.startsWith(`..${sep}`) || target.startsWith(sep)) {
      throw new Error("The new npm CLI points outside its package");
    }
    if (!await probeVersion(candidateEntry, 4000, { env })) throw new Error("The new CLI failed its version check; the previous installation was retained");

    let retired = false;
    let promoted = false;
    let retiredEntry = false;
    let promotedEntry = false;
    try {
      await rename(current, previous); retired = true;
      await rename(candidate, current); promoted = true;
      await rename(recipe.executable, previousEntry); retiredEntry = true;
      await rename(candidateEntry, recipe.executable); promotedEntry = true;
      const version = await probeVersion(recipe.executable, 4000, { env });
      if (!version) throw new Error("The updated CLI failed its version check");
      return version;
    } catch (error) {
      try {
        if (promotedEntry) await rm(recipe.executable);
        if (retiredEntry) await rename(previousEntry, recipe.executable);
        if (promoted) await rename(current, candidate);
        if (retired) await rename(previous, current);
      } catch (restoreError) {
        preserveRecovery = true;
        throw new Error(`CLI update and rollback failed; recovery files were preserved at ${staging}`, { cause: restoreError });
      }
      throw error;
    }
  } finally {
    if (!preserveRecovery) {
      // Cleanup cannot turn an already verified replacement into a failed update.
      await rm(staging, { recursive: true, force: true }).catch(error => {
        console.warn(`[rainver-host] Could not clean CLI update staging directory ${staging}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
