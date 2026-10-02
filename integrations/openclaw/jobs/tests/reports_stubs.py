"""Synthetic HTTP stubs shared by the report job tests."""

import io
import json
from pathlib import Path
import sys
import urllib.error

JOBS_DIR = Path(__file__).resolve().parents[1]
if str(JOBS_DIR) not in sys.path:
    sys.path.insert(0, str(JOBS_DIR))


class FakeResponse(io.BytesIO):
    def __init__(self, body):
        super().__init__(json.dumps(body).encode("utf-8"))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class RouteStub:
    """Answer urllib requests by URL path and record each request."""

    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        path = "/" + request.full_url.split("://", 1)[1].split("/", 1)[1]
        answer = self.routes.get(path)
        if answer is None:
            raise urllib.error.URLError("no synthetic route")
        if isinstance(answer, int):
            raise urllib.error.HTTPError(request.full_url, answer, "error", {}, io.BytesIO(b"{}"))
        return FakeResponse(answer)


class FakeOpener:
    def __init__(self, stub):
        self.open = stub
