"""Production first-start credential and existing-data safety."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("start.sh")


class StartProdTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        docker = fake_bin / "docker"
        docker.write_text("#!/bin/sh\nexit 22\n")
        docker.chmod(0o755)
        self.env = {
            **os.environ,
            "HOME": str(self.root),
            "RAINVER_ROOT": str(self.root / "data"),
            "RAINVER_ADMIN_EMAIL": "owner@example.com",
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
        }
        self.env.pop("RAINVER_ENV_FILE_READONLY", None)

    def run_start(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(SCRIPT), "--prod", "--detach"],
            env=self.env,
            text=True,
            capture_output=True,
        )

    def test_first_start_generates_password_once(self) -> None:
        first = self.run_start()
        self.assertEqual(first.returncode, 22, first.stderr)
        env_file = self.root / "data/prod/.env"
        env_text = env_file.read_text()
        self.assertRegex(env_text, r"(?m)^POSTGRES_PASSWORD=[0-9a-f]{64}$")
        self.assertIn("INSTANCE_ADMIN_EMAIL=owner@example.com", env_text)
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
        password_line = next(line for line in env_text.splitlines() if line.startswith("POSTGRES_PASSWORD="))
        self.assertNotIn(password_line.split("=", 1)[1], first.stdout + first.stderr)

        second = self.run_start()
        self.assertEqual(second.returncode, 22, second.stderr)
        self.assertIn(password_line, env_file.read_text())

    def test_first_start_refuses_existing_postgres_container_even_with_empty_data(self) -> None:
        docker = self.root / "bin/docker"
        docker.write_text(
            "#!/bin/sh\n"
            "if [ \"$1 $2\" = \"container inspect\" ]; then\n"
            "  printf 'existing-container-id\\n'\n"
            "  exit 0\n"
            "fi\n"
            "exit 22\n"
        )
        result = self.run_start()
        self.assertNotEqual(result.returncode, 22)
        self.assertIn("already exists", result.stderr)
        self.assertFalse((self.root / "data/prod/.env").exists())

    def test_missing_env_with_existing_postgres_data_is_refused(self) -> None:
        pgdata = self.root / "data/prod/db/postgres"
        pgdata.mkdir(parents=True)
        (pgdata / "PG_VERSION").write_text("18\n")
        result = self.run_start()
        self.assertNotEqual(result.returncode, 22)
        self.assertIn("Restore the original .env", result.stderr)
        self.assertFalse((self.root / "data/prod/.env").exists())

    def test_existing_template_with_empty_pgdata_is_completed(self) -> None:
        mode_root = self.root / "data/prod"
        (mode_root / "db/postgres").mkdir(parents=True)
        env_file = mode_root / ".env"
        env_file.write_text(
            "POSTGRES_PASSWORD=REPLACE_ME_WITH_STRONG_PASSWORD\n"
            "INSTANCE_ADMIN_EMAIL=owner@example.com\n"
        )
        result = self.run_start()
        self.assertEqual(result.returncode, 22, result.stderr)
        self.assertRegex(env_file.read_text(), r"(?m)^POSTGRES_PASSWORD=[0-9a-f]{64}$")

    def test_exported_password_cannot_override_saved_password(self) -> None:
        mode_root = self.root / "data/prod"
        mode_root.mkdir(parents=True)
        (mode_root / ".env").write_text("POSTGRES_PASSWORD=saved-password\n")
        self.env["POSTGRES_PASSWORD"] = "different-password"
        result = self.run_start()
        self.assertNotEqual(result.returncode, 22)
        self.assertIn("exported POSTGRES_PASSWORD differs", result.stderr)

    def test_pinned_installer_tag_is_persisted_on_first_start(self) -> None:
        self.env["RAINVER_INITIAL_IMAGE_TAG"] = "sha-" + "a" * 40
        result = self.run_start()
        self.assertEqual(result.returncode, 22, result.stderr)
        self.assertIn(
            "RAINVER_IMAGE_TAG=sha-" + "a" * 40,
            (self.root / "data/prod/.env").read_text(),
        )


if __name__ == "__main__":
    unittest.main()
