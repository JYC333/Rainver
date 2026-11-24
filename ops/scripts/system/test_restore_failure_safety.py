"""Failure injection for ops/scripts/system/restore.sh.

A fake `docker` stands in for Compose and PostgreSQL and a fake `cp` can fail
part-way like a full disk; no Compose project, container or database is
touched. The property under test: existing file data is never removed before
its replacement is completely written on the target filesystem, and a
database restore error stops the restore before any file is touched.
"""

from __future__ import annotations

import fcntl
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
  *"image inspect"*) printf '%040d\\n' 1 ;;
  *"server sh -s"*)
    cat >/dev/null
    if [[ -n "${FAKE_RECONCILE_UNAVAILABLE:-}" ]]; then exit 1; fi
    printf '0000\\tbaseline\\tchecksum\\tnormal\\n'
    printf 'restore-image:%s\\n' "${RAINVER_IMAGE_TAG:-}" >> "$FAKE_LOG" ;;
  *"migrateCli.js plugin-reconcile"*|*"migrateCli.js runtime-roles-reconcile"*)
    printf 'restore-image:%s\\n' "${RAINVER_IMAGE_TAG:-}" >> "$FAKE_LOG"
    printf 'restore-db:%s\\n' "${SERVER_DATABASE_URL##*/}" >> "$FAKE_LOG"
    if [[ "$*" == *"runtime-roles-reconcile"* && -n "${FAKE_RECONCILE_FAIL:-}" ]]; then exit 1; fi ;;
  *"ps --services"*) printf 'postgres\\n' ;;
  *"pg_restore --list"*) cat >/dev/null ;;
  *"pg_restore -U"*)
    cat >/dev/null
    if [[ -n "${FAKE_PG_RESTORE_HANG:-}" ]]; then touch "$FAKE_HANG_MARK"; sleep 30; fi
    if [[ -n "${FAKE_PG_RESTORE_FAIL:-}" ]]; then echo "pg_restore: error: could not execute query" >&2; exit 1; fi ;;
  *"psql "*"-v candidate="*)
    sql="$(cat)"
    printf '%s\\n' "$sql" >> "$FAKE_LOG"
    if [[ "$sql" == *COMMIT* ]]; then
      if [[ -n "${FAKE_CUTOVER_FAIL:-}" ]]; then exit 1; fi
      printf 't\\n'
    fi ;;
  *"psql "*"-v app_role="*)
    cat >/dev/null
    printf '%s\\n' "${FAKE_ROLE_ACCESS:-t}" ;;
  *"SELECT to_regclass"*) printf 't\\n' ;;
  *"SELECT version FROM server_schema_migrations"*) printf '0000\\n' ;;
  *"SELECT count(*)"*) printf '0\\n' ;;
  *"SHOW server_version"*) printf '18.1\\n' ;;
esac
exit 0
"""
# Stand in for the external libpq client, without storing its input URI.
FAKE_PYTHON = """#!/usr/bin/env bash
if [[ "$1" != */verify_restore_libpq.py ]]; then exec /usr/bin/python3 "$@"; fi
printf '%s\\n' "external verifier $*" >> "$FAKE_LOG"
IFS= read -r uri || exit 40
[[ "$uri" == "$FAKE_EXPECTED_URI" ]] || exit 41
if [[ -n "${FAKE_EXTERNAL_FAIL:-}" ]]; then
  printf 'synthetic diagnostic echoing URI: %s\\n' "$uri" >&2
  exit "$FAKE_EXTERNAL_FAIL"
fi
case "$2" in
  *"SELECT to_regclass"*) printf 't\\n' ;;
  *"SELECT version FROM server_schema_migrations"*) printf '0000\\n' ;;
  *"SELECT count(*)"*) printf '0\\n' ;;
  *"SELECT to_json(storage_path)"*)
    if [[ -n "${FAKE_ARTIFACT_PATHS:-}" ]]; then cat "$FAKE_ARTIFACT_PATHS"; fi ;;
  *) exit 42 ;;
esac
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
        for name, body in (("docker", FAKE_DOCKER), ("cp", FAKE_CP), ("python3", FAKE_PYTHON)):
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

    def write_archive(self, **metadata: str) -> None:
        manifest = {"backup_format": "rainver-backup.v1", "postgres_server_version": "18.1", **metadata}
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

    def run_restore(self, *, mode: str = "test", **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.archive), "--mode", mode, "--force"],
            env={**self.env, **extra}, input="yes\n", text=True, capture_output=True, timeout=120,
        )

    def contents(self) -> dict[str, list[str]]:
        return {name: sorted(p.name for p in (self.mode_root / name).iterdir()) for name in ("storage", "config", "workspaces")}

    def leftovers(self) -> list[str]:
        return sorted(p.name for p in self.mode_root.iterdir() if p.name.startswith(".restore-"))

    def assert_old_intact(self) -> None:
        self.assertEqual(self.contents(), {"storage": ["old.txt"], "config": ["old.txt"], "workspaces": ["old.txt"]})
        self.assertEqual((self.mode_root / "storage" / "old.txt").read_text(), "old storage")

    def test_verify_can_target_the_bundled_restore_when_external_database_is_configured(self) -> None:
        external_url = "postgresql://example@external.invalid/rainver"
        with (self.mode_root / ".env").open("a", encoding="utf-8") as env_file:
            env_file.write(f"DATABASE_URL={external_url}\n")
        command = ["bash", str(SCRIPT.with_name("verify-restore.sh")), "--mode", "test"]
        for bundled in (False, True):
            with self.subTest(bundled=bundled):
                self.log.write_text("")
                options = ["--bundled-postgres"] if bundled else []
                result = subprocess.run(
                    command + options, env={**self.env, "FAKE_EXPECTED_URI": external_url},
                    text=True, capture_output=True, timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                queries = self.log.read_text()
                self.assertNotIn(external_url, queries + result.stdout + result.stderr)
                self.assertEqual("external verifier" in queries, not bundled)
                if bundled:
                    self.assertIn("psql -X -v ON_ERROR_STOP=1 -U rainver -d rainver", queries)
                else:
                    self.assertNotIn("postgres", queries)

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
        self.assertIn("verify-restore.sh --mode test --bundled-postgres", result.stdout)

    def test_production_restore_checks_and_uses_the_same_revision(self) -> None:
        self.mode_root.rename(self.root / "prod")
        self.mode_root = self.root / "prod"
        result = self.run_restore(mode="prod")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        log = self.log.read_text()
        self.assertIn("docker-compose.prod.yml run --rm -T --no-deps --pull never", log)
        self.assertEqual(
            [line for line in log.splitlines() if line.startswith("restore-image:")],
            [f"restore-image:sha-{1:040d}"] * 3,
        )
        self.assertLess(log.index("server sh -s"), log.index("CREATE DATABASE"))
        self.assertNotIn("DROP DATABASE", log)
        self.assertIn(f"RAINVER_IMAGE_TAG=sha-{1:040d} ops/scripts/start.sh --prod", result.stdout)

    def test_missing_reconciliation_commands_stop_before_database_replacement(self) -> None:
        result = self.run_restore(FAKE_RECONCILE_UNAVAILABLE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("before destructive DB operation", result.stderr)
        self.assertNotIn("DROP DATABASE", self.log.read_text())
        self.assert_old_intact()

    def test_schema_checksum_is_checked_against_the_selected_image(self) -> None:
        self.write_archive(schema_migration_version="0000", schema_migration_checksum="different")
        result = self.run_restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from the selected image", result.stderr)
        self.assertNotIn("DROP DATABASE", self.log.read_text())
        self.assert_old_intact()

    def test_start_and_restore_share_the_instance_lock(self) -> None:
        self.mode_root.rename(self.root / "prod")
        self.mode_root = self.root / "prod"
        lock_fd = os.open(self.mode_root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            cli = SCRIPT.parent.parent / "rainver"
            start = subprocess.run(["bash", str(cli), "start"], env=self.env, text=True, capture_output=True)
            self.assertNotEqual(start.returncode, 0)
            self.assertIn("another operation", start.stderr)
            restore = self.run_restore(mode="prod")
            self.assertNotEqual(restore.returncode, 0)
            self.assertIn("another operation", restore.stderr)
            self.assertFalse(self.log.exists(), "neither operation should reach Docker")
        finally:
            os.close(lock_fd)

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
        self.assertNotIn("RENAME TO", log)
        self.assertIn('DROP DATABASE IF EXISTS :"candidate"', log)

    def test_signal_during_import_cleans_only_staging_database(self) -> None:
        process = subprocess.Popen(
            ["bash", str(SCRIPT), str(self.archive), "--mode", "test", "--force"],
            env={**self.env, "FAKE_PG_RESTORE_HANG": "1"},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        assert process.stdin is not None
        try:
            process.stdin.write("yes\n")
            process.stdin.flush()
            deadline = time.monotonic() + 20
            while not Path(self.env["FAKE_HANG_MARK"]).exists():
                self.assertIsNone(process.poll(), "restore stopped before import")
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.02)
            os.killpg(process.pid, signal.SIGTERM)
            _, errors = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, errors)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=10)
        self.assert_old_intact()
        log = self.log.read_text()
        self.assertNotIn("RENAME TO", log)
        self.assertIn('DROP DATABASE IF EXISTS :"candidate"', log)

    def test_both_restore_entry_points_reconcile_staging_before_cutover(self) -> None:
        dump = self.root / "backup.dump"
        dump.write_bytes(b"PGDMP-synthetic")
        db_restore = SCRIPT.parent.parent / "db" / "restore.sh"
        for full_system in (True, False):
            with self.subTest(full_system=full_system):
                self.log.write_text("")
                result = self.run_restore() if full_system else subprocess.run(
                    ["bash", str(db_restore), str(dump), "--mode", "test"],
                    env=self.env, input="yes\n", text=True, capture_output=True, timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                log = self.log.read_text()
                candidates = [line for line in log.splitlines() if line.startswith("restore-db:")]
                self.assertEqual(len(candidates), 2)
                self.assertEqual(candidates[0], candidates[1])
                self.assertTrue(candidates[0].startswith("restore-db:rainver_restore_stage_"))
                self.assertIn(f'-d {candidates[0].removeprefix("restore-db:")}', log)
                self.assertLess(log.index("runtime-roles-reconcile"), log.index("RENAME TO"))
                self.assertNotIn("DROP DATABASE", log)
                self.assertIn("with connections disabled", result.stdout)

    def test_reconciliation_or_role_access_failure_retains_active_database_and_files(self) -> None:
        for failure in (
            {"FAKE_RECONCILE_FAIL": "1"},
            {"RAINVER_DB_REQUIRE_RUNTIME_ROLE": "1", "FAKE_ROLE_ACCESS": "f"},
        ):
            with self.subTest(failure=failure):
                self.log.write_text("")
                result = self.run_restore(**failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("previous database was preserved", result.stderr)
                self.assert_old_intact()
                log = self.log.read_text()
                self.assertIn("runtime-roles-reconcile", log)
                self.assertNotIn("RENAME TO", log)
                self.assertIn('DROP DATABASE IF EXISTS :"candidate"', log)

    def test_cutover_failure_can_be_retried_after_cleanup(self) -> None:
        result = self.run_restore(FAKE_CUTOVER_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cutover failed", result.stderr)
        self.assert_old_intact()
        self.assertIn('DROP DATABASE IF EXISTS :"candidate"', self.log.read_text())
        self.log.write_text("")
        retried = self.run_restore()
        self.assertEqual(retried.returncode, 0, retried.stdout + retried.stderr)
        self.assertEqual(self.contents()["storage"], ["new.txt"])
        self.assertNotIn("DROP DATABASE", self.log.read_text())


if __name__ == "__main__":
    unittest.main()
