"""Own the downloader session after an abrupt Linux speech-owner exit.

The inherited receipt lock fences restart cleanup until this process is gone.
Only this new session is signalled; no host-wide process search is used.
"""
import ctypes
import os
import signal
import sys


def arm_parent_lifetime():
    if sys.platform != "linux":
        return
    expected = int(os.environ.get("VOIX_LONG_OWNER_PID", "0"))
    if expected < 2 or os.getpgrp() != os.getpid():
        raise RuntimeError("An owned downloader session and parent identity are required.")

    def terminate_session(_signum=None, _frame=None):
        os.killpg(os.getpgrp(), signal.SIGKILL)

    signal.signal(signal.SIGTERM, terminate_session)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), "Cannot bind downloader lifetime to its owner")
    # Covers owner death between Popen and prctl.
    if os.getppid() != expected:
        terminate_session()
