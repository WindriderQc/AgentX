"""Read-only Linux process identity for a runner's isolated installation."""
from pathlib import Path
import os


def installation_processes(root, proc_root='/proc'):
    """Find executable/path arguments under root, ignoring embedded shell code.

    An inspection failure for this user's process is uncertain, never proof of
    termination. Disappearing processes are normal. Other users are out of scope.
    """
    prefix = str(Path(root).resolve()) + '/'
    found = []
    for entry in Path(proc_root).iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            executable = os.readlink(entry / 'exe')
            arguments = (entry / 'cmdline').read_bytes().split(b'\0')
            paths = [x.decode(errors='surrogateescape') for x in arguments]
            if executable.startswith(prefix) or any(x.startswith(prefix) for x in paths):
                found.append({'pid': int(entry.name), 'executable': executable})
        except (FileNotFoundError, ProcessLookupError):
            continue
    return sorted(found, key=lambda x: x['pid'])
