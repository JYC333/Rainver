"""Verify restored Artifact paths using an isolated fake Compose/Postgres."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_restore_failure_safety import FAKE_DOCKER, FAKE_PYTHON


SCRIPT = Path(__file__).with_name("verify-restore.sh")
VERIFY_DOCKER = """#!/usr/bin/env bash
case "$*" in
  *"context inspect"*) printf '%s\\n' 'unix:///fixture.sock' ;;
  *"config --format json"*) cat "$FAKE_COMPOSE_CONFIG" ;;
  *"SELECT to_json(storage_path)"*) cat "$FAKE_ARTIFACT_PATHS" ;;
  *) exec "$FAKE_RESTORE_DOCKER" "$@" ;;
esac
"""


class VerifyRestoreArtifactsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.instance = self.root / "test"
        self.instance.mkdir()
        (self.instance / ".env").write_text("POSTGRES_USER=rainver\nPOSTGRES_DB=rainver\n")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        restore_docker = bin_dir / "restore-docker"
        for path, body in (
            (bin_dir / "docker", VERIFY_DOCKER),
            (restore_docker, FAKE_DOCKER),
            (bin_dir / "python3", FAKE_PYTHON),
            (bin_dir / "sleep", "#!/bin/sh\nexit 0\n"),
        ):
            path.write_text(body)
            path.chmod(0o700)
        self.config = self.root / "compose.json"
        self.paths = self.root / "paths.jsonl"
        self.environment = {
            "RAINVER_ROOT": str(self.root),
            "HOME": str(self.root),
            "PATH": f"{bin_dir}:/usr/bin:/bin",
            "FAKE_LOG": str(self.root / "docker.log"),
            "FAKE_RESTORE_DOCKER": str(restore_docker),
            "FAKE_COMPOSE_CONFIG": str(self.config),
            "FAKE_ARTIFACT_PATHS": str(self.paths),
        }
        self.default_bind = {"type": "bind", "source": str(self.instance), "target": "/rainver"}

    def run_verify(self, paths, *, artifact_root=None, extra_mounts=(), working_dir=None, bundled=True):
        environment = {"RAINVER_HOME": "/rainver"}
        if artifact_root is not None:
            environment["ARTIFACT_STORAGE_ROOT"] = artifact_root
        self.config.write_text(json.dumps({
            "services": {"server": {
                "environment": environment,
                "working_dir": working_dir,
                "volumes": [self.default_bind, *extra_mounts],
            }},
        }))
        self.paths.write_text("".join(json.dumps(path) + "\n" for path in paths))
        return subprocess.run(
            ["bash", str(SCRIPT), "--mode", "test", *(["--bundled-postgres"] if bundled else [])],
            env=self.environment,
            text=True,
            capture_output=True,
            timeout=10,
        )

    def artifact(self, relative, content=b"fixture"):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return target

    def test_default_checks_file_presence_and_distinguishes_content(self):
        self.artifact("test/storage/artifacts/folder/document.txt", b"unverified bytes")
        result = self.run_verify(["folder/document.txt"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 total, 1 present, 0 invalid, 0 missing, 0 not checked", result.stdout)
        self.assertIn("artifact content: not verified", result.stdout)
        self.assertNotIn("outside standard offline archive directories", result.stdout)

    def test_external_uri_reaches_libpq_client_intact_and_stays_out_of_diagnostics(self):
        uri = "postgresql://reader:fixture%40only@one.invalid,two.invalid/db?sslmode=verify-full&sslrootcert=%2Fcert.pem"
        self.environment["FAKE_EXPECTED_URI"] = uri
        with (self.instance / ".env").open("a") as env:
            env.write("DATABASE_URL=" + uri.replace("postgresql:", "postgresql+psycopg:", 1) + "\n")

        success = self.run_verify([], bundled=False)
        self.assertEqual(success.returncode, 0, success.stderr)
        self.assertIn("DATABASE_URL from env (redacted)", success.stdout)

        for code, stage in (
            ("10", "client needs libpq"),
            ("11", "connection failed"),
            ("12", "rejected the verification query"),
        ):
            with self.subTest(stage=stage):
                self.environment["FAKE_EXTERNAL_FAIL"] = code
                failure = self.run_verify([], bundled=False)
                self.assertEqual(failure.returncode, 1, failure.stdout)
                self.assertIn(stage, failure.stderr)
                self.assertIn("failed to query server_schema_migrations", failure.stderr)
                self.assertNotIn("fixture%40only", failure.stdout + failure.stderr)
        self.assertNotIn("fixture%40only", success.stdout + success.stderr)
        self.assertNotIn("fixture%40only", Path(self.environment["FAKE_LOG"]).read_text())

    def test_resolves_custom_relative_root_against_effective_working_directory(self):
        self.artifact("test/artifacts/custom/report.bin")
        result = self.run_verify(["report.bin"], artifact_root="custom", working_dir="/rainver/artifacts")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 total, 1 present", result.stdout)

    def test_nested_external_bind_overrides_the_parent_and_is_outside_archive(self):
        external = self.root / "independent-artifacts"
        mount = {"type": "bind", "source": str(external), "target": "/rainver/storage/artifacts/separate"}
        self.artifact("test/storage/artifacts/separate/report.bin", b"stale default file")
        self.artifact("independent-artifacts/report.bin")
        result = self.run_verify(["separate/report.bin"], extra_mounts=[mount])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 reference(s) outside standard offline archive directories", result.stdout)
        (external / "report.bin").unlink()
        missing = self.run_verify(["separate/report.bin"], extra_mounts=[mount])
        self.assertEqual(missing.returncode, 1, missing.stdout)
        self.assertIn("0 present, 0 invalid, 1 missing", missing.stdout)

    def test_unmapped_or_managed_volume_is_not_reported_as_checked(self):
        self.artifact("test/storage/artifacts/report.bin", b"irrelevant local file")
        volume = {"type": "volume", "source": "managed", "target": "/external"}
        for mounts in ([], [volume]):
            with self.subTest(mounts=mounts):
                result = self.run_verify(["report.bin"], artifact_root="/external", extra_mounts=mounts)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn("0 present, 0 invalid, 0 missing, 1 not checked", result.stdout)
                self.assertIn("INCOMPLETE", result.stderr)

    def test_invalid_artifact_references_fail(self):
        result = self.run_verify(["/absolute", "directory/../escape"])
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("0 present, 2 invalid, 0 missing, 0 not checked", result.stdout)

    def test_bind_symlink_is_not_claimed_as_a_checked_container_file(self):
        external = self.artifact("external/report.txt")
        root = self.instance / "storage" / "artifacts"
        root.mkdir(parents=True)
        (root / "report.txt").symlink_to(external)
        result = self.run_verify(["report.txt"])
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("0 present, 0 invalid, 0 missing, 1 not checked", result.stdout)

    def test_remote_docker_cannot_verify_its_binds_on_the_callers_disk(self):
        self.artifact("test/storage/artifacts/report.bin")
        self.environment["DOCKER_HOST"] = "ssh://fixture.invalid"
        result = self.run_verify(["report.bin"])
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("0 present, 0 invalid, 0 missing, 1 not checked", result.stdout)
        self.assertIn("Docker endpoint is not a local Unix socket", result.stderr)
