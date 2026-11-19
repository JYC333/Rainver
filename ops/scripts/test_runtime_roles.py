"""ADR 0031 operator script: explicit, reversible, owner channel only.

A fake `docker` records every invocation; no Compose project, container or
database is touched.
"""
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("db") / "runtime-roles.sh"
LIB = Path(__file__).with_name("lib") / "local-compose.sh"
FAKE_DOCKER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
for v in SERVER_DATABASE_URL RAINVER_DB_APP_PASSWORD RAINVER_DB_BACKUP_PASSWORD; do
  if [[ -n "${!v:-}" ]]; then printf 'env:%s\\n' "$v" >> "$FAKE_DOCKER_LOG"; fi
done
if [[ "$*" == *"ps --services"* ]]; then printf '%s' "${FAKE_RUNNING:-}"; fi
exit 0
"""


class RuntimeRolesScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "test").mkdir()
        self.env_file = root / "test" / ".env"
        self.env_file.write_text("POSTGRES_USER=rainver\nPOSTGRES_PASSWORD=owner-secret-value\nPOSTGRES_DB=rainver\n"
                                 "SERVER_DATABASE_URL=postgresql://rainver:owner-secret-value@postgres:5432/rainver\n", encoding="utf-8")
        bindir = root / "bin"
        bindir.mkdir()
        docker = bindir / "docker"
        docker.write_text(FAKE_DOCKER, encoding="utf-8")
        docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
        self.log = root / "docker.log"
        # A minimal environment: the script under test never sees this machine's own secrets.
        self.env = {"RAINVER_ROOT": str(root), "PATH": f"{bindir}:/usr/bin:/bin", "HOME": str(root), "FAKE_DOCKER_LOG": str(self.log)}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_script(self, *args: str, running: str = "") -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(SCRIPT), *args, "--mode", "test"], env={**self.env, "FAKE_RUNNING": running}, text=True, capture_output=True)

    def env_text(self) -> str:
        return self.env_file.read_text(encoding="utf-8")

    def test_refuses_without_explicit_confirmation(self) -> None:
        for command in ("apply", "activate", "rollback"):
            result = self.run_script(command)
            self.assertNotEqual(result.returncode, 0, command)
            self.assertIn("--yes", result.stderr)
        self.assertFalse(self.log.exists() and "runtime-roles-reconcile" in self.log.read_text())

    def secrets(self) -> list[str]:
        text = self.env_text()
        values = [line.split("=", 1)[1] for line in text.splitlines() if line.startswith(("RAINVER_DB_APP_PASSWORD=", "RAINVER_DB_BACKUP_PASSWORD="))]
        return ["owner-secret-value", *values]

    def test_apply_uses_the_owner_channel_and_never_puts_any_secret_on_argv_or_output(self) -> None:
        results = [self.run_script("plan"), self.run_script("apply", "--yes")]
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        log = self.log.read_text()
        self.assertIn("runtime-roles-reconcile", log)
        # Inherited by name: the owner URL and both role passwords reach the one-off container, never argv.
        self.assertIn("-e SERVER_DATABASE_URL -e RAINVER_DB_APP_ROLE", log)
        for name in ("SERVER_DATABASE_URL", "RAINVER_DB_APP_PASSWORD", "RAINVER_DB_BACKUP_PASSWORD"):
            self.assertIn(f"env:{name}", log)
            self.assertNotIn(f"{name}=", log)
        secrets = self.secrets()
        self.assertEqual(len(secrets), 3)
        self.assertTrue(all(len(value) >= 16 for value in secrets))
        for value in secrets:
            self.assertNotIn(value, log)
            for result in results:
                self.assertNotIn(value, result.stdout + result.stderr)

    def test_owner_channel_scripts_never_spell_a_secret_on_docker_argv(self) -> None:
        for script in ("db/runtime-roles.sh", "db/restore.sh", "system/restore.sh"):
            text = (Path(__file__).parent / script).read_text(encoding="utf-8")
            self.assertNotIn('-e SERVER_DATABASE_URL="', text, script)
            self.assertNotIn('-e RAINVER_DB_APP_PASSWORD="', text, script)
            self.assertNotIn('-e RAINVER_DB_BACKUP_PASSWORD="', text, script)

    def test_activate_requires_stopped_services_then_switches_and_rollback_restores(self) -> None:
        self.assertEqual(self.run_script("apply", "--yes").returncode, 0)
        blocked = self.run_script("activate", "--yes", running="server\n")
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("stop application services", blocked.stderr)
        self.assertEqual(self.run_script("activate", "--yes").returncode, 0)
        text = self.env_text()
        self.assertIn("SERVER_DATABASE_URL=postgresql://rainver_app:", text)
        self.assertIn("BACKUP_DATABASE_URL=postgresql://rainver_backup:", text)
        self.assertIn("RAINVER_DB_REQUIRE_RUNTIME_ROLE=1", text)
        server_env = (self.env_file.parent / ".server.env").read_text(encoding="utf-8")
        self.assertNotIn("owner-secret-value", server_env)
        self.assertNotIn("RAINVER_DB_OWNER_", server_env)
        self.assertNotIn("RAINVER_DB_BACKUP_PASSWORD", server_env)
        self.assertNotIn("RAINVER_DB_APP_PASSWORD", server_env)
        self.assertIn("SERVER_DATABASE_URL=postgresql://rainver_app:", server_env)
        # The ordinary start path never rewrites an activated URL back to the owner.
        subprocess.run(["bash", "-c", 'source "$1"; local_compose_init test; local_compose_ensure_server_database_env', "_", str(LIB)], env=self.env, check=True, capture_output=True)
        self.assertIn("SERVER_DATABASE_URL=postgresql://rainver_app:", self.env_text())
        self.assertEqual(self.run_script("rollback", "--yes").returncode, 0)
        text = self.env_text()
        self.assertIn("SERVER_DATABASE_URL=postgresql://rainver:owner-secret-value@postgres:5432/rainver", text)
        self.assertIn("RAINVER_DB_REQUIRE_RUNTIME_ROLE=0", text)


if __name__ == "__main__":
    unittest.main()
