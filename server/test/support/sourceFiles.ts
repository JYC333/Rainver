import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every .ts file below `dir`, for the meta-tests that scan the source tree. */
export function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}
