"""Standalone production installer contract, using local release assets."""
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("install-prod.sh")
CLI = Path(__file__).with_name("rainver")
LOCAL_COMPOSE = Path(__file__).with_name("lib") / "local-compose.sh"
SHA = "a" * 40


def add_file(archive: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    archive.addfile(info, io.BytesIO(data))


class InstallProdTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.releases = self.root / "releases"
        stable = self.releases / "prod-stable"
        immutable = self.releases / f"prod-sha-{SHA}"
        stable.mkdir(parents=True)
        immutable.mkdir()
        (stable / "BUILD_ID").write_text(SHA + "\n")
        archive_path = immutable / "rainver-prod.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            add_file(archive, "BUILD_ID", (SHA + "\n").encode())
            add_file(
                archive,
                "ops/scripts/start.sh",
                b'#!/bin/sh\nprintf "%s\\n%s\\n" "$RAINVER_IMAGE_TAG" "${RAINVER_INITIAL_IMAGE_TAG:-}" > "$RAINVER_ROOT/started"\n',
                0o755,
            )
            add_file(archive, "ops/scripts/lib/local-compose.sh", LOCAL_COMPOSE.read_bytes())
            add_file(archive, "ops/scripts/install-prod.sh", SCRIPT.read_bytes(), 0o755)
            add_file(archive, "ops/scripts/rainver", CLI.read_bytes(), 0o755)
            add_file(archive, "ops/compose/docker-compose.prod.yml", b"services: {}\n")
            add_file(archive, "ops/env/.env.prod.example", b"POSTGRES_PASSWORD=REPLACE_ME\n")
        digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
        (immutable / "rainver-prod.tar.gz.sha256").write_text(f"{digest}  rainver-prod.tar.gz\n")
        self.env = {
            **os.environ,
            "HOME": str(self.root),
            "RAINVER_ROOT": str(self.root / "data"),
            "RAINVER_INSTALL_DIR": str(self.root / "install"),
            "RAINVER_BIN_DIR": str(self.root / "bin"),
            "RAINVER_RELEASE_BASE_URL": self.releases.as_uri(),
            "RAINVER_ADMIN_EMAIL": "owner@example.com",
        }

    def run_installer(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(SCRIPT), *args], env=self.env, text=True, capture_output=True)

    def test_installs_and_starts_without_checkout(self) -> None:
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        current = self.root / "install/current"
        self.assertTrue(current.is_symlink())
        self.assertEqual((current / "BUILD_ID").read_text().strip(), SHA)
        launcher = self.root / "bin/rainver"
        self.assertTrue(launcher.is_file())
        version = subprocess.run([str(launcher), "version"], env=self.env, text=True, capture_output=True)
        self.assertEqual(version.returncode, 0, version.stderr)
        self.assertEqual(version.stdout.strip(), SHA)
        self.assertFalse((self.root / "data/prod/.env").exists())
        self.assertEqual((self.root / "data/started").read_text(), f"sha-{SHA}\n\n")

    def test_existing_config_is_preserved_on_update(self) -> None:
        env_file = self.root / "data/prod/.env"
        env_file.parent.mkdir(parents=True)
        env_text = "POSTGRES_PASSWORD=existing-password\nRAINVER_IMAGE_TAG=stable\n"
        env_file.write_text(env_text)
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(env_file.read_text(), env_text)
        self.assertEqual((self.root / "data/started").read_text(), f"sha-{SHA}\n\n")
        launcher = self.root / "bin/rainver"
        updated = subprocess.run([str(launcher), "update"], env=self.env, text=True, capture_output=True)
        self.assertEqual(updated.returncode, 0, updated.stderr)
        self.assertEqual(env_file.read_text(), env_text)

    def test_launcher_manages_the_installed_root_without_a_checkout(self) -> None:
        data_root = self.root / "data root"
        install_root = self.root / "install root"
        bin_dir = self.root / "bin dir"
        self.env.update({
            "RAINVER_ROOT": str(data_root),
            "RAINVER_INSTALL_DIR": str(install_root),
            "RAINVER_BIN_DIR": str(bin_dir),
        })
        installed = self.run_installer()
        self.assertEqual(installed.returncode, 0, installed.stderr)
        env_file = data_root / "prod/.env"
        env_file.write_text("POSTGRES_PASSWORD=existing-password\n")

        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        docker = fake_bin / "docker"
        docker.write_text("""#!/bin/sh
for arg in "$@"; do echo "$arg" >> "$RAINVER_DOCKER_CALLS"; done
echo END >> "$RAINVER_DOCKER_CALLS"
case " $* " in
  *" ps -aq "*) echo container-id ;;
esac
""")
        docker.chmod(0o755)
        calls_file = self.root / "docker-calls"
        cli_env = {
            **self.env,
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "RAINVER_DOCKER_CALLS": str(calls_file),
        }
        for key in ("RAINVER_ROOT", "RAINVER_INSTALL_DIR", "RAINVER_BIN_DIR"):
            cli_env.pop(key)
        launcher = bin_dir / "rainver"

        stopped = subprocess.run([str(launcher), "stop"], env=cli_env, text=True, capture_output=True)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        args = calls_file.read_text().splitlines()
        self.assertIn(str(env_file), args)
        self.assertIn(str(install_root / "current/ops/compose/docker-compose.prod.yml"), args)
        self.assertEqual(args[-2:], ["stop", "END"])
        self.assertNotIn("pull", args)

        calls_file.unlink()
        started = subprocess.run([str(launcher), "start"], env=cli_env, text=True, capture_output=True)
        self.assertEqual(started.returncode, 0, started.stderr)
        args = calls_file.read_text().splitlines()
        self.assertIn("start", args)
        self.assertNotIn("pull", args)

        calls_file.unlink()
        restarted = subprocess.run([str(launcher), "restart", "server"], env=cli_env, text=True, capture_output=True)
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        self.assertEqual(calls_file.read_text().splitlines()[-3:], ["restart", "server", "END"])

        calls_file.unlink()
        logged = subprocess.run([str(launcher), "logs", "-f", "server"], env=cli_env, text=True, capture_output=True)
        self.assertEqual(logged.returncode, 0, logged.stderr)
        self.assertEqual(calls_file.read_text().splitlines()[-6:], ["logs", "--tail", "100", "-f", "server", "END"])

        calls_file.unlink()
        status = subprocess.run([str(launcher), "status"], env=cli_env, text=True, capture_output=True)
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(calls_file.read_text().splitlines()[-3:], ["ps", "--all", "END"])

        calls_file.unlink()
        rejected = subprocess.run([str(launcher), "restart", "unknown"], env=cli_env, text=True, capture_output=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertFalse(calls_file.exists())

    def test_existing_command_is_preserved(self) -> None:
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        existing = bin_dir / "rainver"
        existing.write_text("#!/bin/sh\necho unrelated\n")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not managed by this installer", result.stderr)
        self.assertEqual(existing.read_text(), "#!/bin/sh\necho unrelated\n")
        self.assertFalse((self.root / "install/current").exists())

    def test_pinned_install_sets_matching_image_tag(self) -> None:
        result = self.run_installer("--sha", SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.root / "data/started").read_text(),
            f"sha-{SHA}\nsha-{SHA}\n",
        )

    def test_rejects_corrupt_bundle_before_activation(self) -> None:
        archive = self.releases / f"prod-sha-{SHA}/rainver-prod.tar.gz"
        archive.write_bytes(archive.read_bytes() + b"corruption")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertFalse((self.root / "install/current").exists())
        self.assertFalse((self.root / "bin/rainver").exists())


if __name__ == "__main__":
    unittest.main()
