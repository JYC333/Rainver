import { describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dirname, "..", "..");

function script(name: string): string {
  return readFileSync(join(repoRoot, "ops", "scripts", "system", name), "utf8");
}

function runScript(name: string, args: string[], rainverRoot: string, fakeBin: string): void {
  const result = spawnSync("bash", [join(repoRoot, "ops", "scripts", "system", name), ...args], {
    encoding: "utf8",
    env: { ...process.env, RAINVER_ROOT: rainverRoot, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
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

  it("keeps credentials and the reviewed deployment environment in the sensitive archive", () => {
    const backup = script("backup-credentials.sh");
    const restore = script("restore-credentials.sh");
    const safeExtract = script("safe_extract.py");
    expect(backup).toContain('install -m 600 "$ENV_FILE" "$staging/instance.env"');
    expect(backup).toContain('"backup_format": "rainver-credentials.v1"');
    expect(backup).toContain('"included_paths": ["secrets/", "instance.env"]');
    expect(restore).toContain('manifest.get("backup_format") != "rainver-credentials.v1"');
    expect(restore).toContain('safe_extract.py" "$ARCHIVE" "$staging"');
    expect(safeExtract).toContain("unsafe archive path");
    expect(safeExtract).toContain('filter="data"');
    expect(restore).toContain("stop app services before credential restore");
    expect(restore).toContain('atomic_ops.py" replace-directory');
    expect(restore).toContain('RESTORE_ENV=false');
    expect(restore).toContain('--restore-env) RESTORE_ENV=true');
    expect(restore).toContain('label=com.docker.compose.project=$COMPOSE_PROJECT');
    expect(restore).toContain('"$MODE_ROOT/.env.restored"');
    expect(restore).toContain('mv -f "$env_tmp" "$ENV_FILE"');
  });

  it("round-trips secrets while staging or explicitly activating the archived environment", () => {
    const root = mkdtempSync(join(tmpdir(), "rainver-sensitive-recovery-test-"));
    try {
      const sourceRoot = join(root, "source");
      const sourceMode = join(sourceRoot, "prod");
      const output = join(root, "archives");
      const fakeBin = join(root, "bin");
      mkdirSync(join(sourceMode, "secrets"), { recursive: true });
      mkdirSync(output);
      mkdirSync(fakeBin);
      writeFileSync(join(sourceMode, "secrets", "provider_keys.key"), "test-master-key\n", {
        mode: 0o600,
      });
      writeFileSync(
        join(sourceMode, ".env"),
        "POSTGRES_PASSWORD=test-password\nFRONTEND_URL=http://old-ip\n",
        { mode: 0o600 },
      );
      const fakeDocker = join(fakeBin, "docker");
      writeFileSync(fakeDocker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      chmodSync(fakeDocker, 0o700);

      runScript("backup-credentials.sh", ["--mode", "prod", "--output", output], sourceRoot, fakeBin);
      const archives = readdirSync(output).filter((name) => name.endsWith(".tar.gz"));
      expect(archives).toHaveLength(1);
      const archive = join(output, archives[0]!);

      const reviewedRoot = join(root, "reviewed");
      runScript("restore-credentials.sh", [archive, "--mode", "prod"], reviewedRoot, fakeBin);
      expect(
        readFileSync(join(reviewedRoot, "prod", "secrets", "provider_keys.key"), "utf8"),
      ).toBe("test-master-key\n");
      expect(readFileSync(join(reviewedRoot, "prod", ".env.restored"), "utf8")).toContain(
        "FRONTEND_URL=http://old-ip",
      );
      expect(() => statSync(join(reviewedRoot, "prod", ".env"))).toThrow();
      expect(statSync(join(reviewedRoot, "prod", ".env.restored")).mode & 0o777).toBe(0o600);

      const activatedRoot = join(root, "activated");
      runScript("restore-credentials.sh", [archive, "--mode", "prod", "--restore-env"], activatedRoot, fakeBin);
      expect(readFileSync(join(activatedRoot, "prod", ".env"), "utf8")).toContain(
        "POSTGRES_PASSWORD=test-password",
      );
      expect(statSync(join(activatedRoot, "prod", ".env")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
