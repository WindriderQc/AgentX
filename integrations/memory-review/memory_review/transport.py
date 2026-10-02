"""Existing parental-code authentication for the native HTTPS consumer.

The supervisor selects an external code file. Read it per request so rotation
does not require resetting watermarks or copying the secret into task arguments.
"""

import os
from pathlib import Path
from urllib.request import HTTPRedirectHandler, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not forward observations or the parental code to a redirected URL.
        return None


def parental_headers() -> dict[str, str]:
    filename = os.environ.get("AGENTX_ACCESS_CODE_FILE", "").strip()
    if not filename:
        return {}
    code = Path(filename).read_text(encoding="utf-8").strip()
    if not code or "\r" in code or "\n" in code:
        raise OSError("Configured access-code file is empty or invalid")
    return {"Authorization": f"Bearer {code}"}


def urlopen(request, *, timeout):
    # Preserve standard certificate verification and system/proxy configuration.
    return build_opener(_NoRedirect()).open(request, timeout=timeout)
