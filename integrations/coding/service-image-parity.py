#!/usr/bin/env python3
"""Prove that a running service still serves the current Product checkout.

This is a read-only check. Any missing or ambiguous evidence prints ``no``.
"""

import datetime as dt
import pathlib
import re
import shlex
import subprocess
import sys

SERVICES = {"core", "benchmark", "rag", "data"}
SHA = re.compile(r"^[0-9a-f]{40}$")


def git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )


def image_paths(root, service):
    dockerfile = pathlib.Path("docker") / f"{service}.Dockerfile"
    lines = (root / dockerfile).read_text(encoding="utf-8").splitlines()
    paths = [str(dockerfile), "docker-compose.yml", ".dockerignore"]
    copies = 0
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("COPY ", "ADD ")):
            if line.endswith("\\") or line.startswith(("COPY [", "ADD [")):
                raise ValueError("unsupported Dockerfile COPY syntax")
            words = shlex.split(line)
            if any(word.startswith("--from=") for word in words[1:]):
                continue
            sources = [word for word in words[1:-1] if not word.startswith("--")]
            if not sources or any("://" in source or source.startswith("/") for source in sources):
                raise ValueError("unsupported Dockerfile source")
            paths.extend(sources)
            copies += 1
    if not copies or any(not (root / path).exists() for path in paths if "*" not in path):
        raise ValueError("missing image inputs")
    return paths


def prove(args):
    if len(args) not in (7, 8):
        return False
    root, service, revision, checkout, created, env_file, *override = args
    root = pathlib.Path(root).resolve(strict=True)
    if service not in SERVICES or not SHA.fullmatch(revision) or not SHA.fullmatch(checkout):
        return False
    if git(root, "rev-parse", "HEAD").stdout.strip() != checkout:
        return False
    if git(root, "merge-base", "--is-ancestor", revision, checkout).returncode != 0:
        return False
    inputs = image_paths(root, service)
    if git(root, "diff", "--quiet", revision, checkout, "--", *inputs).returncode != 0:
        return False
    files = [pathlib.Path(env_file), *(pathlib.Path(path) for path in override)]
    creation = dt.datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
    return all(path.is_file() and path.stat().st_mtime < creation for path in files)


if __name__ == "__main__":
    try:
        print("yes" if prove(sys.argv[1:]) else "no")
    except (OSError, ValueError, OverflowError):
        print("no")
