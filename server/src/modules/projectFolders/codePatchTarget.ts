import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../routeUtils/common.js";

export interface CodePatchTarget {
  read(): Promise<Buffer | null>;
  write(content: string | Buffer): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Server-side patching runs on Linux. Node has no openat API; Linux's fd paths
 * let its standard filesystem calls stay relative to opened directories.
 * Every untrusted component is opened O_NOFOLLOW, never re-resolved by name
 * after validation. This keeps the boundary local without a native addon.
 */
export async function withCodePatchTarget<T>(
  root: string, path: string, createParents: boolean, work: (target: CodePatchTarget) => Promise<T>,
): Promise<T> {
  if (process.platform !== "linux") throw new HttpError(503, "Safe server code patching requires Linux fd paths");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    throw new HttpError(422, "Unsafe code_patch path");
  }
  const directories: FileHandle[] = [];
  try {
    directories.push(await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of parts.slice(0, -1)) {
      const child = join(`/proc/self/fd/${directories.at(-1)!.fd}`, part);
      if (createParents) await mkdir(child).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      directories.push(await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    const directory = `/proc/self/fd/${directories.at(-1)!.fd}`;
    const absolute = join(directory, parts.at(-1)!);
    let mode = 0o666;
    return await work({
      async read() {
        const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
        if (!file) return null;
        try {
          const metadata = await file.stat();
          if (!metadata.isFile()) throw new HttpError(422, "code_patch target must be a regular file");
          mode = metadata.mode & 0o777;
          return await file.readFile();
        } finally {
          await file.close();
        }
      },
      async write(content) {
        const temporary = join(directory, `.rainver-patch-${randomUUID()}`);
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
        try {
          await file.writeFile(content);
          await file.close();
          // rename replaces a last-component link; it never follows it.
          await rename(temporary, absolute);
        } finally {
          await file.close().catch(() => undefined);
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      },
      async remove() {
        await unlink(absolute).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      },
    });
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new HttpError(422, `Unsafe code_patch path ${JSON.stringify(path)}: symlink or non-directory`);
    }
    throw error;
  } finally {
    for (const directory of directories.reverse()) await directory.close();
  }
}
