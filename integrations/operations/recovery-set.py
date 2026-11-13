#!/usr/bin/env python3
"""Use --config outside Git; no embedded instance paths, identities or secrets."""
from recovery_set.cli import main

if __name__ == '__main__':
    raise SystemExit(main())
