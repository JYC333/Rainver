"""The instance `.env` is read the way Compose reads it."""
import subprocess
import tempfile
import unittest
from pathlib import Path


LIB = Path(__file__).with_name("lib") / "local-compose.sh"


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


if __name__ == "__main__":
    unittest.main()
