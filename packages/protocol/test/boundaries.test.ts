import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Bare module specifiers allowed in the protocol package. Relative imports
 * (`./`, `../`) are always allowed; everything else must be on this list.
 * `zod-to-json-schema` derives the model-facing JSON Schema for a System
 * Action's `input_schema` from the same Zod that validates it (action
 * authority consolidation plan, D5) — it is a pure schema transform with no
 * frontend/backend/db/runtime dependency of its own. */
const ALLOWED_BARE = new Set(["zod", "zod-to-json-schema"]);

const importRe = /\bfrom\s+["']([^"']+)["']/g;

describe("protocol package import boundaries", () => {
  it("imports nothing but zod and relative modules (no frontend/backend/db/runtime)", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const spec = match[1];
        if (spec.startsWith(".")) continue; // relative — fine
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        if (!ALLOWED_BARE.has(pkg)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders, `unexpected imports:\n${offenders.join("\n")}`).toEqual([]);
  });
});
