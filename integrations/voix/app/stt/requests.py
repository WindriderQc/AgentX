"""Request-local cancellation and bounded waiting for the serial recognizer."""
from __future__ import annotations

import asyncio
import math
import logging
import time
import uuid
from contextlib import asynccontextmanager, contextmanager, suppress

from app.cancel import CancelToken

_LOG = logging.getLogger("voix.stt.requests")


class RecognitionCancelled(RuntimeError):
    """The caller left; no further recognition should start for this request."""


class RecognitionBusy(RuntimeError):
    """The request's wait budget elapsed before the recognizer became available."""


@asynccontextmanager
async def cancellation(request):
    """Watch only after the upload has been consumed, without storing its audio.

    A running native decoder cannot be forcibly interrupted. Its caller checks
    the token before acquiring the inference lock and between decoded segments.
    """
    token = CancelToken()
    token.request_id = str(uuid.uuid4())
    _LOG.info("Recognition request id=%s state=received", token.request_id)

    async def watch():
        while not token.is_set():
            if await request.is_disconnected():
                _LOG.info("Recognition request id=%s state=disconnected", token.request_id)
                token.set()
                return
            await asyncio.sleep(0.05)

    watcher = asyncio.create_task(watch())
    try:
        yield token
    except RecognitionCancelled:
        _LOG.info("Recognition request id=%s state=cancelled", token.request_id)
        raise
    except RecognitionBusy:
        _LOG.info("Recognition request id=%s state=busy", token.request_id)
        raise
    except asyncio.CancelledError:
        _LOG.info("Recognition request id=%s state=caller_cancelled", token.request_id)
        raise
    else:
        _LOG.info("Recognition request id=%s state=completed", token.request_id)
    finally:
        token.set()
        watcher.cancel()
        with suppress(asyncio.CancelledError):
            await watcher


def check_cancelled(token):
    if token is not None and token.is_set():
        raise RecognitionCancelled("Speech request cancelled.")


@contextmanager
def inference_slot(lock, token, timeout_seconds, *, clock=time.monotonic):
    """Never let a disconnected or expired waiter enter the model afterwards."""
    started = clock()
    deadline = min(started + timeout_seconds, getattr(token, "queue_deadline", math.inf))
    while True:
        check_cancelled(token)
        remaining = deadline - clock()
        if remaining <= 0 or not math.isfinite(remaining):
            raise RecognitionBusy("Speech recognition is busy.")
        if lock.acquire(timeout=min(0.05, remaining)):
            break
    try:
        check_cancelled(token)
        if clock() >= deadline:
            raise RecognitionBusy("Speech recognition is busy.")
        if getattr(token, "request_id", None):
            _LOG.info("Recognition request id=%s state=admitted wait_ms=%d", token.request_id, round((clock() - started) * 1000))
        yield (clock() - started) * 1000
    finally:
        lock.release()
