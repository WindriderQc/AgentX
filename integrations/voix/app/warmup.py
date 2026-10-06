"""Startup warm-up: load recognition and synthesis before the first request.

Each stage is timed and isolated. A stage that fails leaves the service
answering (the first real request then pays the cold load) and is reported in
/health and in the log, never raised.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime

from app.config import settings

_LOG = logging.getLogger("voix.warmup")
# Own handler at INFO: the root logger defaults to WARNING, which would silently
# swallow the warm-up timings this logger exists to make visible.
_LOG.setLevel(logging.INFO)
if not _LOG.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    _LOG.addHandler(_handler)
    _LOG.propagate = False

_status: dict = {
    "state": "pending" if settings.voix_startup_warmup else "disabled",
    "stage": None,
    "started_at": None,
    "completed_at": None,
    "stages": {},
}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def snapshot() -> dict:
    """A copy of the warm-up state, safe to return from /health."""
    return {**_status, "stages": {key: dict(value) for key, value in _status["stages"].items()}}


def mark(state: str, stage: str | None = None) -> None:
    _status.update({"state": state, "stage": stage})


async def _stage(name: str, run) -> bool:
    started = time.perf_counter()
    _status["stage"] = name
    _status["stages"][name] = {"state": "running", "elapsed_ms": None}
    try:
        await run()
    except Exception as exc:
        elapsed = (time.perf_counter() - started) * 1000
        _status["stages"][name] = {"state": "failed", "elapsed_ms": round(elapsed)}
        _LOG.error("warmup %s FAILED after %.0f ms: %s", name, elapsed, exc, exc_info=True)
        return False
    elapsed = (time.perf_counter() - started) * 1000
    _status["stages"][name] = {"state": "ready", "elapsed_ms": round(elapsed)}
    _LOG.info("warmup %s ok in %.0f ms", name, elapsed)
    return True


async def run(tts_provider: str) -> None:
    """Load the recognition model, then the selected synthesis engine."""
    loop = asyncio.get_running_loop()
    started = time.perf_counter()
    _status.update({"state": "running", "stage": "stt", "started_at": _now_iso(),
                    "completed_at": None, "stages": {}})

    async def stt() -> None:
        from app.stt import whisper

        await loop.run_in_executor(None, whisper.preload_model)

    async def tts() -> None:
        from app.tts import provider

        await loop.run_in_executor(None, provider.preload, tts_provider)

    results = [await _stage("stt", stt), await _stage("tts", tts)]
    elapsed = (time.perf_counter() - started) * 1000
    _status.update({"state": "ready" if all(results) else "degraded", "stage": "complete",
                    "completed_at": _now_iso()})
    if all(results):
        _LOG.info("warmup complete in %.0f ms - first request will be warm", elapsed)
    else:
        _LOG.warning("warmup INCOMPLETE in %.0f ms - the first request will pay a cold load "
                     "(stt=%s tts=%s)", elapsed, *results)
