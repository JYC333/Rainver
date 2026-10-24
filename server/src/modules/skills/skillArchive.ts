import { Unzip, UnzipInflate, unzipSync } from "fflate";
import { HttpError } from "../routeUtils/common.js";
import { isPlatformMetadataPath } from "./skillPackagePaths.js";

/** Central-directory entries, including directories and dropped desktop metadata (Finder adds one `._*` per file). */
const MAX_ARCHIVE_ENTRIES = 1000;

/**
 * Decode into bounded memory; never extract untrusted archive names to disk.
 * Desktop metadata entries (`isPlatformMetadataPath`) are read within their
 * own bound and dropped, so a Finder-made ZIP imports as its Skill folder.
 */
export function readSkillArchive(encoded: string): Array<{ path: string; content_base64: string }> {
  if (encoded.length > 4 * 1024 * 1024) throw new HttpError(413, "Skill archive is too large");
  const archive = Buffer.from(encoded, "base64");
  if (archive.toString("base64") !== encoded) throw new HttpError(422, "Skill archive encoding is invalid");
  const files: Array<{ path: string; content_base64: string }> = [];
  // Streaming local headers alone cannot detect a ZIP truncated between files.
  // Let the same ZIP library read the complete central directory without inflating.
  const expected = new Map<string, number>();
  try {
    unzipSync(archive, { filter(file) {
      if (expected.size >= MAX_ARCHIVE_ENTRIES || expected.has(file.name)) throw new HttpError(422, "Invalid or duplicate ZIP entry");
      if (file.originalSize > 256 * 1024) throw new HttpError(413, "Skill package file is too large");
      expected.set(file.name, file.originalSize);
      return false;
    } });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "Invalid or incomplete Skill ZIP archive");
  }
  let total = 0;
  let ignoredTotal = 0;
  let entries = 0;
  let unfinished = 0;
  const unzip = new Unzip(file => {
    if (!expected.has(file.name)) throw new HttpError(422, "ZIP entry is missing from its directory");
    if (++entries > MAX_ARCHIVE_ENTRIES) throw new HttpError(413, "Skill archive contains too many entries");
    if (file.originalSize !== undefined && file.originalSize > 256 * 1024) {
      throw new HttpError(413, "Skill package file is too large");
    }
    let size = 0;
    const chunks: Buffer[] = [];
    const ignored = isPlatformMetadataPath(file.name);
    unfinished++;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      if (ignored) ignoredTotal += chunk.length;
      else total += chunk.length;
      if (size > 256 * 1024 || total > 2 * 1024 * 1024 || ignoredTotal > 2 * 1024 * 1024) {
        file.terminate();
        throw new HttpError(413, "Skill package is too large");
      }
      if (!ignored) chunks.push(Buffer.from(chunk));
      if (final) {
        if (size !== expected.get(file.name)) throw new HttpError(422, "ZIP entry size does not match its directory");
        expected.delete(file.name);
        unfinished--;
        if (ignored) return;
        if (file.name.endsWith("/")) {
          if (size !== 0) throw new HttpError(422, "Archive directory contains data");
          return;
        }
        if (files.length >= 200) throw new HttpError(413, "Skill package contains too many files");
        files.push({ path: file.name, content_base64: Buffer.concat(chunks).toString("base64") });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    // Small input chunks also bound allocation before each decompressed-byte check.
    for (let offset = 0; offset < archive.length; offset += 1024) {
      unzip.push(archive.subarray(offset, offset + 1024), offset + 1024 >= archive.length);
    }
    if (unfinished || expected.size || files.length === 0) throw new Error("incomplete archive");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "Invalid or unsupported Skill ZIP archive");
  }
  return files;
}
