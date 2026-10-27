import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readFolderFile } from '@rainver/folder-read';
import { OUTPUT_MAX_FILES, OUTPUT_MAX_TOTAL_BYTES, PREVIEW_MAX_BYTES, rasterImageMime, type HostRunOutputsUpload } from '@rainver/protocol';

/** Explicit Run outputs only. Reuse the bounded, no-symlink Folder reader. */
export async function collectOutputFiles(root: string): Promise<HostRunOutputsUpload['files']> {
  const files: HostRunOutputsUpload['files'] = [];
  let total = 0;
  let visited = 0;
  async function walk(dir: string, depth: number) {
    if (depth > 8 || files.length >= OUTPUT_MAX_FILES) return;
    // opendir is not needed for a bounded private Run directory; the actual
    // file open below pins and validates every component against the root.
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 1000 || files.length >= OUTPUT_MAX_FILES) return;
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(name, depth + 1);
      else if (entry.isFile()) {
        try {
          const file = await readFolderFile(root, name, { includeOriginalBytes: true });
          const bytes = Buffer.from(file.content_base64!, 'base64');
          if (bytes.length > PREVIEW_MAX_BYTES || total + bytes.length > OUTPUT_MAX_TOTAL_BYTES) continue;
          if (rasterImageMime(bytes)) files.push({ name, content: bytes.toString('base64'), encoding: 'base64' });
          else if (file.encoding === 'utf8') files.push({ name, content: file.content });
          else continue;
          total += bytes.length;
        } catch { /* Missing, unsafe, oversize or unsupported output: leave it out. */ }
      }
    }
  }
  await walk('', 0);
  return files;
}
