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
            add_file(archive, "ops/compose/docker-compose.prod.yml", b"services: {}\n")
            add_file(archive, "ops/env/.env.prod.example", b"POSTGRES_PASSWORD=REPLACE_ME\n")
        digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
        (immutable / "rainver-prod.tar.gz.sha256").write_text(f"{digest}  rainver-prod.tar.gz\n")
        self.env = {
            **os.environ,
            "HOME": str(self.root),
            "RAINVER_ROOT": str(self.root / "data"),
            "RAINVER_INSTALL_DIR": str(self.root / "install"),
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


if __name__ == "__main__":
    unittest.main()
