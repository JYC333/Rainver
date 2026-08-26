#!/usr/bin/env python3
"""Safely extract an rainver tar archive into an empty staging directory."""

from __future__ import annotations

import argparse
import pathlib
import tarfile


def safe_extract(archive_path: str, destination: str, allowed_roots: set[str]) -> None:
    destination_path = pathlib.Path(destination)
    destination_path.mkdir(parents=True, exist_ok=True)
    if any(destination_path.iterdir()):
        raise ValueError("safe extraction destination must be empty")

    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            normalized = member.name.removeprefix("./")
            path = pathlib.PurePosixPath(normalized)
            if not normalized or normalized == ".":
                continue
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"unsafe archive path: {member.name}")
            if not path.parts or path.parts[0] not in allowed_roots:
                raise ValueError(f"unexpected archive path: {member.name}")
            if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
                raise ValueError(f"unsupported archive member type: {member.name}")

        # Python's data filter rejects extraction outside destination, unsafe link
        # targets, device nodes and other special files. Validation and extraction
        # use the same open archive handle to avoid a path-swap window.
        archive.extractall(destination_path, filter="data")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("destination")
    parser.add_argument("allowed_roots", nargs="+")
    args = parser.parse_args()
    safe_extract(args.archive, args.destination, set(args.allowed_roots))


if __name__ == "__main__":
    main()
