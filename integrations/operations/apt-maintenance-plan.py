#!/usr/bin/python3
"""Private simulation receipts for the named host_jobs adapter; never applies."""
import argparse
import sys

from host_jobs.apt_plan import qualify


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--enforce-window", action="store_true")
    args = parser.parse_args()
    try:
        result = qualify(args.policy, args.receipt, args.request, enforce_window=args.enforce_window)
        return 0 if result["state"] == "completed" else 1
    except Exception as error:
        print(getattr(error, "code", "APT_PLAN_UNAVAILABLE"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
