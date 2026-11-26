import { describe, expect, it } from "vitest";
import {
  existsSync,
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

type ScriptResult = { status: number | null; stdout: string; stderr: string };

function spawnScript(
  name: string,
  args: string[],
  rainverRoot: string,
  fakeBin: string,
  extraEnv: Record<string, string> = {},
): ScriptResult {
  return spawnSync("bash", [join(repoRoot, "ops", "scripts", "system", name), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      RAINVER_ROOT: rainverRoot,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  });
}

function runScript(name: string, args: string[], rainverRoot: string, fakeBin: string): void {
  const result = spawnScript(name, args, rainverRoot, fakeBin);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

// `docker` answers every call successfully with `dockerOutput`; `sleep` returns
// at once so readiness polling inside the scripts does not wait on real time.
function fakeBinDir(root: string, dockerOutput = ""): string {
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "docker"), `#!/bin/sh\n${dockerOutput}\nexit 0\n`, { mode: 0o700 });
  writeFileSync(join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return fakeBin;
}

type Member = { name: string; data?: string; symlinkTo?: string };

// Writes a .tar.gz with exactly these member names (tar(1) would normalize
// unsafe names away).
function writeArchive(path: string, members: Member[]): void {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `import io, json, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as tar:
    for m in json.loads(sys.argv[2]):
        info = tarfile.TarInfo(m["name"])
        if "symlinkTo" in m:
            info.type = tarfile.SYMTYPE
            info.linkname = m["symlinkTo"]
            tar.addfile(info)
        else:
            data = m.get("data", "").encode()
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))`,
      path,
      JSON.stringify(members),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
}

function archiveEntries(path: string): string[] {
  const result = spawnSync("tar", ["-tzf", path], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

const credentialManifest = (backupFormat: string) =>
  JSON.stringify({ backup_format: backupFormat, included_paths: ["secrets/", "instance.env"] });

describe("backup credential separation", () => {
  it("keeps secrets out of the offline data backup archive", () => {
    const root = mkdtempSync(join(tmpdir(), "rainver-data-backup-test-"));
    try {
      const sourceRoot = join(root, "source");
      const sourceMode = join(sourceRoot, "prod");
      const output = join(root, "archives");
      mkdirSync(join(sourceMode, "secrets"), { recursive: true });
      mkdirSync(join(sourceMode, "storage"), { recursive: true });
      writeFileSync(join(sourceMode, "secrets", "provider_keys.key"), "test-master-key\n");
      writeFileSync(join(sourceMode, "storage", "note.txt"), "data\n");
      const fakeBin = fakeBinDir(root);

      runScript("backup.sh", ["--mode", "prod", "--output", output], sourceRoot, fakeBin);
      const archives = readdirSync(output).filter((name) => name.endsWith(".tar.gz"));
      expect(archives).toHaveLength(1);
      const entries = archiveEntries(join(output, archives[0]!));
      expect(entries).toContain("./storage/note.txt");
      expect(entries.filter((entry) => /(?:^|\/)secrets(?:\/|$)/.test(entry))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to restore secrets from a data backup archive", () => {
    const root = mkdtempSync(join(tmpdir(), "rainver-data-restore-test-"));
    try {
      const archive = join(root, "system.tar.gz");
      writeArchive(archive, [
        { name: "./backup_manifest.json", data: JSON.stringify({ backup_format: "rainver-backup.v1" }) },
        { name: "./db/rainver.dump", data: "" },
        { name: "./secrets/provider_keys.key", data: "planted-key\n" },
      ]);
      const targetRoot = join(root, "target");
      const result = spawnScript("restore.sh", [archive, "--mode", "prod"], targetRoot, fakeBinDir(root));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unexpected archive path: ./secrets");
      expect(existsSync(join(targetRoot, "prod", "secrets"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips secrets while staging or explicitly activating the archived environment", () => {
    const root = mkdtempSync(join(tmpdir(), "rainver-sensitive-recovery-test-"));
    try {
      const sourceRoot = join(root, "source");
      const sourceMode = join(sourceRoot, "prod");
      const output = join(root, "archives");
      const fakeBin = fakeBinDir(root);
      mkdirSync(join(sourceMode, "secrets"), { recursive: true });
      mkdirSync(output);
      writeFileSync(join(sourceMode, "secrets", "provider_keys.key"), "test-master-key\n", {
        mode: 0o600,
      });
      writeFileSync(
        join(sourceMode, ".env"),
        "POSTGRES_PASSWORD=test-password\nPUBLIC_BASE_URL=http://old-ip\n",
        { mode: 0o600 },
      );
      runScript("backup-credentials.sh", ["--mode", "prod", "--output", output], sourceRoot, fakeBin);
      const archives = readdirSync(output).filter((name) => name.endsWith(".tar.gz"));
      expect(archives).toHaveLength(1);
      const archive = join(output, archives[0]!);
      expect(statSync(archive).mode & 0o777).toBe(0o600);
      expect(archiveEntries(archive)).toContain("./instance.env");

      const reviewedRoot = join(root, "reviewed");
      runScript("restore-credentials.sh", [archive, "--mode", "prod"], reviewedRoot, fakeBin);
      expect(
        readFileSync(join(reviewedRoot, "prod", "secrets", "provider_keys.key"), "utf8"),
      ).toBe("test-master-key\n");
      expect(readFileSync(join(reviewedRoot, "prod", ".env.restored"), "utf8")).toContain(
        "PUBLIC_BASE_URL=http://old-ip",
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

  describe("credential restore refusals", () => {
    function refusedRestore(
      members: Member[] | ((root: string) => Member[]),
      dockerOutput = "",
    ): { result: ScriptResult; root: string; modeRoot: string } {
      const root = mkdtempSync(join(tmpdir(), "rainver-credential-refusal-test-"));
      const archive = join(root, "credentials.tar.gz");
      writeArchive(archive, typeof members === "function" ? members(root) : members);
      const tmp = join(root, "tmp");
      mkdirSync(tmp);
      const targetRoot = join(root, "target");
      // TMPDIR puts the extraction staging under `root`, so an escape lands where
      // the test can look for it.
      const result = spawnScript("restore-credentials.sh", [archive, "--mode", "prod"], targetRoot, fakeBinDir(root, dockerOutput), {
        TMPDIR: tmp,
      });
      return { result, root, modeRoot: join(targetRoot, "prod") };
    }

    const validMembers = (backupFormat = "rainver-credentials.v1"): Member[] => [
      { name: "./credential_backup_manifest.json", data: credentialManifest(backupFormat) },
      { name: "./instance.env", data: "POSTGRES_PASSWORD=planted\n" },
      { name: "./secrets/provider_keys.key", data: "planted-key\n" },
    ];

    function expectNothingRestored(modeRoot: string): void {
      expect(existsSync(join(modeRoot, "secrets"))).toBe(false);
      expect(existsSync(join(modeRoot, ".env"))).toBe(false);
      expect(existsSync(join(modeRoot, ".env.restored"))).toBe(false);
    }

    it("rejects an archive whose manifest has another backup_format", () => {
      const { result, root, modeRoot } = refusedRestore(validMembers("rainver-credentials.v0"));
      try {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("incompatible backup_format");
        expectNothingRestored(modeRoot);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("refuses traversal, absolute and escaping-link members without writing outside staging", () => {
      const cases: Array<[(root: string) => Member, string]> = [
        [() => ({ name: "secrets/../../escaped.key", data: "x" }), "unsafe archive path"],
        [(root) => ({ name: join(root, "absolute-escape.key"), data: "x" }), "unsafe archive path"],
        [() => ({ name: "secrets/link.key", symlinkTo: "../../../escaped-link-target" }), "is outside the destination"],
      ];
      for (const [planted, message] of cases) {
        const { result, root, modeRoot } = refusedRestore((root) => [...validMembers(), planted(root)]);
        try {
          expect(result.status, result.stderr).not.toBe(0);
          expect(result.stderr).toContain(message);
          expectNothingRestored(modeRoot);
          expect(readdirSync(root).sort()).toEqual(["bin", "credentials.tar.gz", "tmp"]);
          expect(readdirSync(join(root, "tmp"))).toEqual([]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });

    it("refuses while an app service of the target Compose project is running", () => {
      // No active .env on a fresh host: the script inspects Compose labels directly.
      const dockerOutput = 'case "$*" in *label=com.docker.compose.project=rainver-prod*) echo server ;; esac';
      const { result, root, modeRoot } = refusedRestore(validMembers(), dockerOutput);
      try {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("app service 'server' is active");
        expectNothingRestored(modeRoot);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
