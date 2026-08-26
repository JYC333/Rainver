import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");

function script(name: string): string {
  return readFileSync(join(repoRoot, "ops", "scripts", "system", name), "utf8");
}

describe("backup credential separation", () => {
  it("keeps secrets out of offline data backup and restore", () => {
    const backup = script("backup.sh");
    const restore = script("restore.sh");
    expect(backup).toContain("for d in storage artifacts config workspaces; do");
    expect(backup).toContain(
      "secrets/ (credential material; use ops/scripts/system/backup-credentials.sh)",
    );
    expect(restore).toContain("for d in config storage artifacts workspaces logs; do");
    expect(restore).not.toMatch(/for d in [^\n;]*secrets/);
  });

  it("provides explicit credential-only backup and restore commands", () => {
    const backup = script("backup-credentials.sh");
    const restore = script("restore-credentials.sh");
    const safeExtract = script("safe_extract.py");
    expect(backup).toContain('"backup_format": "rainver-credentials.v1"');
    expect(backup).toContain('"included_paths": ["secrets/"]');
    expect(restore).toContain('manifest.get("backup_format") != "rainver-credentials.v1"');
    expect(restore).toContain('safe_extract.py" "$ARCHIVE" "$staging"');
    expect(safeExtract).toContain("unsafe archive path");
    expect(safeExtract).toContain('filter="data"');
    expect(restore).toContain("stop app services before credential restore");
    expect(restore).toContain('atomic_ops.py" replace-directory');
  });
});
