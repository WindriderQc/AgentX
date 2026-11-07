"""Keep the identity of an explicitly selected, symlinked named home."""
from pathlib import Path
import re


def resolve_active_profile_name(home, default_home, profiles_root):
    home, default_home, profiles_root = map(Path, (home, default_home, profiles_root))
    resolved = home.resolve()
    if resolved == default_home.resolve():
        return "default"
    for candidate, root in ((home.absolute(), profiles_root.absolute()), (resolved, profiles_root.resolve())):
        try:
            parts = candidate.relative_to(root).parts
        except ValueError:
            continue
        if len(parts) == 1 and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", parts[0]):
            return parts[0]
    return "custom"
