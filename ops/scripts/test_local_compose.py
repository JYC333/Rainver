"""Local Compose configuration and instance environment contracts."""
import fcntl
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


LIB = Path(__file__).with_name("lib") / "local-compose.sh"
COMPOSE_DIR = Path(__file__).resolve().parents[1] / "compose"


def env_value(contents: str, key: str) -> str:
    with tempfile.TemporaryDirectory() as directory:
        env_file = Path(directory) / ".env"
        env_file.write_text(contents, encoding="utf-8")
        result = subprocess.run(
            ["bash", "-c", f'source "$1" && local_compose_env_value "$2" "$3"', "_", str(LIB), key, str(env_file)],
            text=True,
            capture_output=True,
            check=True,
        )
    return result.stdout.rstrip("\n")


class EnvValueTest(unittest.TestCase):
    def test_a_hash_inside_an_unquoted_value_is_part_of_the_value(self) -> None:
        # Compose starts an inline comment only at whitespace followed by `#`.
        # Postgres is initialized with the password Compose reads; a script
        # that cut it at the first `#` wrote a database URL with a different
        # password into the same `.env`.
        self.assertEqual(env_value("POSTGRES_PASSWORD=Str0ng#Pass\n", "POSTGRES_PASSWORD"), "Str0ng#Pass")

    def test_an_inline_comment_after_whitespace_is_dropped(self) -> None:
        self.assertEqual(env_value("POSTGRES_PASSWORD=abc   # the password\n", "POSTGRES_PASSWORD"), "abc")

    def test_quoted_values_keep_their_hashes(self) -> None:
        self.assertEqual(env_value('POSTGRES_PASSWORD="a#b" # c\n', "POSTGRES_PASSWORD"), "a#b")
        self.assertEqual(env_value("POSTGRES_PASSWORD='a#b' # c\n", "POSTGRES_PASSWORD"), "a#b")

    def test_last_assignment_wins_and_export_is_supported(self) -> None:
        self.assertEqual(env_value("RAINVER_IMAGE_TAG=stable\nexport RAINVER_IMAGE_TAG = 'edge'\n", "RAINVER_IMAGE_TAG"), "edge")

    def test_channel_is_resolved_to_one_revision_and_mixed_images_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / "docker"
            docker.write_text("""#!/usr/bin/env bash
case "$1:${!#}" in
  pull:ghcr.io/jyc333/rainver-server:edge) exit 0 ;;
  image:*rainver-server:*) printf '%040d\\n' 1 ;;
  image:*rainver-frontend:*) printf '%040d\\n' 2 ;;
  *) exit 1 ;;
esac
""")
            docker.chmod(0o700)
            result = subprocess.run(
                ["bash", "-ec", 'source "$1"; local_compose_pin_image_tag edge; printf "%s\\n" "$RAINVER_IMAGE_TAG"; local_compose_verify_image_revision server frontend', "_", str(LIB)],
                env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}"},
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.stdout.strip(), f"sha-{1:040d}")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("frontend image does not match", result.stderr)

    def test_inherited_operation_lock_is_reused_but_another_process_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                cmd = [
                    "bash", "-ec", 'source "$1"; MODE_ROOT="$2"; local_compose_lock_instance test',
                    "_", str(LIB), directory,
                ]
                inherited = subprocess.run(
                    cmd, pass_fds=(lock_fd,),
                    env={**os.environ, "RAINVER_OPERATION_LOCK_FD": str(lock_fd)},
                    text=True, capture_output=True,
                )
                self.assertEqual(inherited.returncode, 0, inherited.stderr)
                competing = subprocess.run(cmd, text=True, capture_output=True)
                self.assertNotEqual(competing.returncode, 0)
                self.assertIn("another operation", competing.stderr)
            finally:
                os.close(lock_fd)


class SandboxRunnerTest(unittest.TestCase):
    def test_every_sandbox_runner_enables_docker_init(self) -> None:
        for mode in ("dev", "test", "prod"):
            with self.subTest(mode=mode):
                path = COMPOSE_DIR / f"docker-compose.{mode}.yml"
                config = yaml.safe_load(path.read_text(encoding="utf-8"))
                self.assertIs(config["services"]["sandbox-runner"]["init"], True)


if __name__ == "__main__":
    unittest.main()
