#!/usr/bin/env python3
"""Forced SSH command for native host jobs; never invokes the requested shell."""
import argparse
import json
import os
from pathlib import Path
import shlex
import sys

from host_job_worker import main as worker_main
from host_jobs.schedule import instant
from host_jobs.store import JobError, exact_id, exact_request


def request_arguments(original, root, worker=None, python=None):
    refused = lambda: JobError("SSH_COMMAND_REFUSED", "Only named native worker requests are allowed.", 400)
    if not isinstance(original, str) or not original or len(original) > 4096:
        raise refused()
    try:
        words = shlex.split(original)
    except ValueError:
        raise refused()
    worker = worker or Path(__file__).with_name("host_job_worker.py")
    prefix = [python or sys.executable, str(worker), "--root", str(Path(root).expanduser().resolve())]
    if words[:4] != prefix or len(words) < 5 or len(words) > 11:
        raise refused()
    action = words[4]
    allowed = {"run": {"--job", "--request", "--source-at"}, "status": {"--request"}, "inventory": set()}
    if action not in allowed or len(words[5:]) % 2:
        raise refused()
    fields = {}
    for key, value in zip(words[5::2], words[6::2]):
        if key not in allowed[action] or key in fields:
            raise refused()
        fields[key] = value
    if action == "run" and not {"--job", "--request"} <= fields.keys():
        raise refused()
    if action == "status" and "--request" not in fields:
        raise refused()
    if "--job" in fields:
        exact_id(fields["--job"])
    if "--request" in fields:
        exact_request(fields["--request"])
    if "--source-at" in fields:
        try:
            instant(fields["--source-at"])
        except (ValueError, TypeError, OverflowError):
            raise refused()
    return ["--root", prefix[3], *words[4:]]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    try:
        return worker_main(request_arguments(os.environ.get("SSH_ORIGINAL_COMMAND"), args.root))
    except JobError as error:
        print(json.dumps({"contract": "agentx.operations-worker/v1", "status": "error",
                          "error": {"code": error.code, "message": str(error), "status": error.status}}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
