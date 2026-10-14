#!/usr/bin/env python3
"""Named workstation jobs; intended for a native SSH session, never a desktop timer."""
import argparse
import json
import sys
from host_jobs.store import JobError
from host_jobs.worker import Worker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("action", choices=("run", "status", "inventory"))
    parser.add_argument("--job")
    parser.add_argument("--request")
    parser.add_argument("--source-at")
    args = parser.parse_args()
    worker = Worker(args.root)
    try:
        if args.action == "run":
            data = worker.run(args.job, args.request, args.source_at)
        elif args.action == "status":
            data = worker.status(args.request)
        else:
            data = worker.inventory()
        print(json.dumps({"contract": "agentx.operations-worker/v1", "status": "success", "data": data}))
        return 0
    except JobError as error:
        print(json.dumps({"contract": "agentx.operations-worker/v1", "status": "error",
                          "error": {"code": error.code, "message": str(error), "status": error.status}}))
        return 1
    except Exception:
        print(json.dumps({"contract": "agentx.operations-worker/v1", "status": "error",
                          "error": {"code": "WORKER_UNAVAILABLE", "message": "The native worker is unavailable.", "status": 503}}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
