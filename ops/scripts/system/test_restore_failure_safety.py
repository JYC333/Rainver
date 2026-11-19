"""Failure injection for ops/scripts/system/restore.sh.

A fake `docker` stands in for Compose and PostgreSQL and a fake `cp` can fail
part-way like a full disk; no Compose project, container or database is
touched. The property under test: existing file data is never removed before
its replacement is completely written on the target filesystem, and a
database restore error stops the restore before any file is touched.
"""

from __future__ import annotations

import io
import json
import os
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("restore.sh")
FAKE_DOCKER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
for v in SERVER_DATABASE_URL; do
  if [[ -n "${!v:-}" ]]; then printf 'env:%s\\n' "$v" >> "$FAKE_LOG"; fi
done
case "$*" in
  *"ps --services"*) printf 'postgres\\n' ;;
  *"pg_restore --list"*) cat >/dev/null ;;
  *"pg_restore -U"*)
    cat >/dev/null
    if [[ -n "${FAKE_PG_RESTORE_FAIL:-}" ]]; then echo "pg_restore: error: could not execute query" >&2; exit 1; fi ;;
  *"SHOW server_version"*) printf '18.1\\n' ;;
esac
exit 0
"""
# Copies like cp, but when the source names FAKE_CP_FAIL it writes part of the
# data and fails with ENOSPC, or with FAKE_CP_HANG sleeps so the test can kill it.
FAKE_CP = """#!/usr/bin/env bash
for arg in "$@"; do
  if [[ -n "${FAKE_CP_FAIL:-}" && ( "$arg" == *"/$FAKE_CP_FAIL/." || "$arg" == *"/$FAKE_CP_FAIL" ) ]]; then
    dest="${@: -1}"; mkdir -p "$dest"; : > "$dest/partial"
    echo "cp: error writing '$dest/partial': No space left on device" >&2; exit 1
  fi
  if [[ -n "${FAKE_CP_HANG:-}" && ( "$arg" == *"/$FAKE_CP_HANG/." || "$arg" == *"/$FAKE_CP_HANG" ) ]]; then
    touch "$FAKE_HANG_MARK"; sleep 30
  fi
done
exec /bin/cp "$@"
"""


class RestoreFailureSafetyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.root = root
        self.mode_root = root / "test"
        self.mode_root.mkdir()
        (self.mode_root / ".env").write_text(
            "POSTGRES_USER=rainver\nPOSTGRES_PASSWORD=owner-secret-value-123\nPOSTGRES_DB=rainver\n"
            "SERVER_DATABASE_URL=postgresql://rainver:owner-secret-value-123@postgres:5432/rainver\n",
            encoding="utf-8",
        )
        for name in ("storage", "config", "workspaces"):
            (self.mode_root / name).mkdir()
            (self.mode_root / name / "old.txt").write_text(f"old {name}")
        bindir = root / "bin"
        bindir.mkdir()
        for name, body in (("docker", FAKE_DOCKER), ("cp", FAKE_CP)):
            path = bindir / name
            path.write_text(body, encoding="utf-8")
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        self.log = root / "fake.log"
        self.env = {
            "RAINVER_ROOT": str(root), "PATH": f"{bindir}:/usr/bin:/bin", "HOME": str(root),
            "FAKE_LOG": str(self.log), "TMPDIR": str(root), "FAKE_HANG_MARK": str(root / "hang"),
        }
        self.archive = root / "backup.tar.gz"
        self.write_archive()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_archive(self) -> None:
        manifest = {"backup_format": "rainver-backup.v1", "postgres_server_version": "18.1"}
        files = {
            "backup_manifest.json": json.dumps(manifest).encode(),
            "db/rainver.dump": b"PGDMP-synthetic",
            "storage/new.txt": b"new storage",
            "config/new.txt": b"new config",
            "workspaces/new.txt": b"new workspaces",
        }
        with tarfile.open(self.archive, "w:gz") as tar:
            for directory in ("db", "storage", "config", "workspaces"):
                info = tarfile.TarInfo(directory)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))

    def run_restore(self, **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.archive), "--mode", "test", "--force"],
            env={**self.env, **extra}, input="yes\n", text=True, capture_output=True, timeout=120,
        )

    def contents(self) -> dict[str, list[str]]:
        return {name: sorted(p.name for p in (self.mode_root / name).iterdir()) for name in ("storage", "config", "workspaces")}

    def leftovers(self) -> list[str]:
        return sorted(p.name for p in self.mode_root.iterdir() if p.name.startswith(".restore-"))

    def assert_old_intact(self) -> None:
        self.assertEqual(self.contents(), {"storage": ["old.txt"], "config": ["old.txt"], "workspaces": ["old.txt"]})
        self.assertEqual((self.mode_root / "storage" / "old.txt").read_text(), "old storage")

    def test_success_replaces_every_directory_and_leaves_nothing_behind(self) -> None:
        result = self.run_restore()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.contents(), {"storage": ["new.txt"], "config": ["new.txt"], "workspaces": ["new.txt"]})
        self.assertEqual(stat.S_IMODE((self.mode_root / "config").stat().st_mode), 0o700)
        self.assertEqual(self.leftovers(), [])
        log = self.log.read_text()
        self.assertIn("pg_restore -U rainver --exit-on-error", log)
        self.assertIn("env:SERVER_DATABASE_URL", log)
        self.assertNotIn("owner-secret-value-123", log + result.stdout + result.stderr)

    def test_disk_full_while_preparing_changes_nothing(self) -> None:
        # The last directory fails, after earlier ones were fully prepared.
        result = self.run_restore(FAKE_CP_FAIL="workspaces")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Nothing was changed", result.stderr)
        self.assert_old_intact()
        self.assertEqual(self.leftovers(), [])
        # The database was never touched either.
        self.assertNotIn("DROP DATABASE", self.log.read_text())

    def test_interrupted_preparation_keeps_old_data(self) -> None:
        process = subprocess.Popen(
            ["bash", str(SCRIPT), str(self.archive), "--mode", "test", "--force"],
            env={**self.env, "FAKE_CP_HANG": "storage"}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        assert process.stdin is not None
        process.stdin.write("yes\n")
        process.stdin.close()
        deadline = time.time() + 60
        while not Path(self.env["FAKE_HANG_MARK"]).exists():
            self.assertLess(time.time(), deadline, "restore never reached the copy")
            time.sleep(0.1)
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=30)
        for stream in (process.stdout, process.stderr):
            assert stream is not None
            stream.close()
        self.assert_old_intact()
        self.assertNotIn("DROP DATABASE", self.log.read_text())

    def test_pg_restore_error_stops_before_any_file_is_replaced(self) -> None:
        result = self.run_restore(FAKE_PG_RESTORE_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("database restore failed", result.stderr)
        self.assert_old_intact()
        self.assertEqual(self.leftovers(), [])
        log = self.log.read_text()
        self.assertNotIn("plugin-reconcile", log)


if __name__ == "__main__":
    unittest.main()
