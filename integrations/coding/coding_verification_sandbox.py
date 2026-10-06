"""Bubblewrap arguments shared by final and in-turn coding verification."""

def sandbox_arguments(repository: str, command: str, node_binary: str | None = None) -> list[str]:
    sandbox = [
        "/usr/bin/bwrap", "--die-with-parent", "--unshare-net", "--unshare-pid",
        "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin", "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/tmp", "--dir", "/workspace", "--ro-bind", repository, "/workspace",
        "--chdir", "/workspace", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
        "--setenv", "HOME", "/tmp", "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    ]
    if node_binary:
        sandbox.extend(["--dir", "/node", "--ro-bind", node_binary, "/node/node"])
    return [*sandbox, "/usr/bin/bash", "-e", "-c", command]
