import { HttpError } from "../routeUtils/common.js";

/** Portable materialization: reject names that alias or collide on Windows/macOS. */
export function assertSkillPackagePaths(paths: string[]): void {
  const keys = new Set<string>();
  for (const path of paths) {
    if (!path || path.length > 1024 || /[\x00-\x1f\\:<>"|?*]/.test(path)
      || path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new HttpError(422, "Skill package file path is not portable");
    }
    const key = path.normalize("NFC").toLowerCase();
    if (keys.has(key)) throw new HttpError(422, "Skill package contains colliding paths");
    keys.add(key);
  }
  for (const key of keys) {
    const parts = key.split("/");
    for (let count = 1; count < parts.length; count++) {
      if (keys.has(parts.slice(0, count).join("/"))) throw new HttpError(422, "Skill file conflicts with a directory");
    }
  }
}

/**
 * Desktop metadata that is never Skill content: macOS Finder `__MACOSX/`
 * trees, AppleDouble `._*` companions and `.DS_Store`. Archive and file
 * imports drop these before path validation and hashing.
 */
export function isPlatformMetadataPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  return parts.includes("__MACOSX") || name === ".DS_Store" || name.startsWith("._");
}
