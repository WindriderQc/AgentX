#!/usr/bin/env python3
"""Native server entrance for named operational jobs; never accepts shell text."""
import argparse
import base64
import json
import sys
from host_jobs.store import JobError
from host_jobs.supervisor import Supervisor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("action", choices=("status", "tick", "run", "execute", "reconcile", "patch", "inventory"))
    parser.add_argument("--job")
    parser.add_argument("--request")
    parser.add_argument("--revision", type=int)
    parser.add_argument("--changes")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    try:
        supervisor = Supervisor(args.root)
        if args.action == "status":
            data = supervisor.status(min(100, max(1, args.limit)), max(0, args.offset))
        elif args.action == "tick":
            data = supervisor.tick()
        elif args.action == "run":
            data = supervisor.start(args.job, args.request, args.revision)
        elif args.action == "execute":
            data = supervisor.execute(args.request)
        elif args.action == "reconcile":
            data = supervisor.reconcile(args.request)
        elif args.action == "inventory":
            supervisor.refresh_inventory()
            data = supervisor.status()
        else:
            changes = json.loads(base64.b64decode(args.changes, validate=True))
            data = supervisor.patch(args.job, args.revision, changes)
        print(json.dumps({"status": "success", "data": data}))
        return 0
    except JobError as error:
        print(json.dumps({"status": "error", "error": {"code": error.code, "message": str(error), "status": error.status}}))
        return 1
    except Exception:
        print(json.dumps({"status": "error", "error": {"code": "OPERATIONS_UNAVAILABLE", "message": "The native operations supervisor is unavailable.", "status": 503}}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
