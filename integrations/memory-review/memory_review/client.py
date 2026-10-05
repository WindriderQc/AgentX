"""Thin AgentX Core client for /api/memory-review.

stdlib-only (urllib). Every write is designed to be idempotent server-side
(runKey upsert, content-hash observation dedup, candidateId upsert), so a
retried request after a network failure cannot duplicate state. Watermarks are
committed by the CLI only after `submit_observations` returns success.
"""

from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request
from .transport import urlopen

DEFAULT_BASE_URL = "http://127.0.0.1:3180"
DEFAULT_TIMEOUT_S = 30


class AgentXUnavailable(RuntimeError):
    """Core unreachable or refused — fail soft, advance nothing."""


class AgentXRejected(RuntimeError):
    """Core answered with a validation/policy rejection (4xx)."""

    def __init__(self, message: str, status: int = 400, detail: dict | None = None):
        super().__init__(message)
        self.status = status
        self.detail = detail or {}


class MemoryReviewClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout: int = DEFAULT_TIMEOUT_S):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _call(self, method: str, path: str, payload: dict | None = None) -> dict:
        url = f"{self.base_url}/api/memory-review{path}"
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as exc:
            detail: dict = {}
            try:
                detail = json.loads(exc.read().decode("utf-8"))
            except Exception:
                pass
            message = detail.get("message") or detail.get("error") or str(exc)
            if 400 <= exc.code < 500:
                raise AgentXRejected(f"{method} {path} -> {message}", exc.code, detail) from exc
            raise AgentXUnavailable(f"{method} {path} -> HTTP {exc.code} {message}") from exc
        except URLError as exc:
            raise AgentXUnavailable(f"{method} {path} -> {exc.reason}") from exc
        except OSError as exc:
            raise AgentXUnavailable(f"{method} {path} -> {exc}") from exc
        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            raise AgentXUnavailable(f"{method} {path} -> non-JSON response") from exc
        if isinstance(data, dict) and data.get("status") == "error":
            raise AgentXRejected(str(data.get("message") or "rejected"), 400, data)
        return data.get("data", data) if isinstance(data, dict) else {}

    # --- run lifecycle -------------------------------------------------------
    def open_run(self, *, run_key: str, mode: str, window: dict,
                 collector_version: str, prompt_version: str, model: dict) -> dict:
        return self._call("POST", "/runs", {
            "runKey": run_key,
            "mode": mode,
            "window": window,
            "collectorVersion": collector_version,
            "promptVersion": prompt_version,
            "model": model,
        })

    def submit_observations(self, run_id: str, collector: dict, observations: list[dict]) -> dict:
        return self._call("POST", f"/runs/{run_id}/observations", {
            "collector": collector,
            "observations": observations,
        })

    def finalize_collection(self, run_id: str) -> dict:
        return self._call("POST", f"/runs/{run_id}/finalize", {})

    def synthesis_input(self, run_id: str) -> dict:
        return self._call("GET", f"/runs/{run_id}/synthesis-input")

    def submit_candidates(self, run_id: str, candidates: list[dict],
                          prompt_version: str, model: dict) -> dict:
        return self._call("POST", f"/runs/{run_id}/candidates", {
            "candidates": candidates,
            "promptVersion": prompt_version,
            "model": model,
        })

    def fail_run(self, run_id: str, stage: str, reason: str) -> dict:
        return self._call("POST", f"/runs/{run_id}/fail", {
            "stage": stage,
            "reason": str(reason)[:500],
        })

    # --- reads ---------------------------------------------------------------
    def get_run(self, run_id: str) -> dict:
        return self._call("GET", f"/runs/{run_id}")

    def list_runs(self, limit: int = 20, status: str | None = None) -> dict:
        query = {"limit": int(limit)}
        if status:
            query["status"] = status
        return self._call("GET", f"/runs?{urlencode(query)}")

    def digest(self) -> dict:
        return self._call("GET", "/digest")

    def config(self) -> dict:
        return self._call("GET", "/config")
