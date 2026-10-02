"""Allow `python -m memory_review ...` from the scripts/ directory."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
