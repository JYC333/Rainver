import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Reads text files from the per-run output directory (`RAINVER_OUTPUT_DIR`)
 * for upload as run artifacts. Read as UTF-8. A binary file would come back
 * corrupted. Do not treat this as a binary-safe channel.
 */
export async function collectOutputFiles(dir: string): Promise<Array<{ name: string; content: string }>> {
  const files: Array<{ name: string; content: string }> = [];
  await walk(dir, dir, files);
  return files;
}

async function walk(dir: string, base: string, files: Array<{ name: string; content: string }>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, base, files);
    } else if (entry.isFile()) {
      try {
        const content = await readFile(full, "utf8");
        files.push({ name: relative(base, full), content });
      } catch {
        // Skip an unreadable file rather than failing the whole upload.
      }
    }
  }
}
