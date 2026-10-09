"""Identify the selected Node/npm distribution before using prepared packages."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re


class RuntimeUnavailable(RuntimeError):
    """The selected distribution could not be validated without a fallback."""


class RuntimeChanged(RuntimeError):
    """The distribution changed while dependency preparation was running."""


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def bundle_hash(directory: Path, root: Path) -> str:
    """Include npm's dependencies and symlink targets inside the mounted root."""
    digest = hashlib.sha256()

    def visit(path: Path, name: str, parents: frozenset[Path]):
        actual = path.resolve(strict=True)
        actual.relative_to(root)
        if actual in parents:
            raise RuntimeUnavailable("Cyclic npm distribution")
        if actual.is_dir():
            digest.update((name + "/\0").encode())
            for child in sorted(actual.iterdir(), key=lambda value: value.name):
                visit(child, name + "/" + child.name, parents | {actual})
        elif actual.is_file():
            digest.update((name + "\0" + file_hash(actual) + "\0").encode())
        else:
            raise RuntimeUnavailable("Unsupported npm distribution entry")

    visit(directory, "npm", frozenset())
    return digest.hexdigest()


def identity(root: Path, selected_node: Path, probe) -> dict:
    """Validate artifacts and receive bounded, network-free Node/npm probes.

    The caller owns sandboxing. No host path enters the cache identity, so
    relocating identical distribution bytes preserves the preparation key.
    """
    try:
        root = root.resolve(strict=True)
        node = (root / "bin/node").resolve(strict=True)
        if selected_node.resolve(strict=True) != node or not node.is_file() or not os.access(node, os.X_OK):
            raise RuntimeUnavailable("Selected Node does not match the mounted distribution")
        node.relative_to(root)
        npm_cli = (root / "bin/npm").resolve(strict=True)
        npm_cli.relative_to(root)
        if not npm_cli.is_file():
            raise RuntimeUnavailable("Missing npm CLI")
        npm_root = npm_cli.parent.parent
        package = json.loads((npm_root / "package.json").read_text())
        if package.get("name") != "npm" or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", package.get("version", "")):
            raise RuntimeUnavailable("Invalid npm distribution manifest")
        if (npm_root / package.get("bin", {}).get("npm", "")).resolve(strict=True) != npm_cli:
            raise RuntimeUnavailable("npm CLI does not match its distribution manifest")
        artifacts = {"nodeSha256": file_hash(node), "npmSha256": bundle_hash(npm_root, root)}
        npm_relative = npm_cli.relative_to(root).as_posix()
        observed = probe(npm_relative)
        if not isinstance(observed, dict) or set(observed) != {"nodeVersion", "modules", "platform", "arch", "npmVersion"}:
            raise RuntimeUnavailable("Invalid runtime probe")
        if not all(isinstance(value, str) and value for value in observed.values()):
            raise RuntimeUnavailable("Invalid runtime probe values")
        if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", observed["nodeVersion"]) or not observed["modules"].isdigit():
            raise RuntimeUnavailable("Invalid Node version or ABI")
        if observed["npmVersion"] != package["version"]:
            raise RuntimeUnavailable("npm probe does not match its distribution")
        if artifacts != {"nodeSha256": file_hash(node), "npmSha256": bundle_hash(npm_root, root)}:
            raise RuntimeChanged("Runtime changed during validation")
        return {**observed, **artifacts, "npmCli": npm_relative}
    except (RuntimeUnavailable, RuntimeChanged):
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError) as error:
        raise RuntimeUnavailable("Selected Node/npm distribution unavailable") from error
