"""Bound uploads and submitted recognition jobs before executor queues grow.

Only standard-library dependencies: the standalone CPU controls import this too.
An abandoned running thread retains its permit until it actually terminates.
"""
from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from app.stt.requests import RecognitionBusy, RecognitionCancelled, check_cancelled

_LOG = logging.getLogger("voix.stt.requests")


class Permit:
    def __init__(self, lane):
        self.lane = lane
        self.transferred = False
        self.released = False
        self.worker_finished = False
        self.waiter_finished = False
        self.lock = threading.Lock()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        if not self.transferred:
            self.release()

    def release(self):
        with self.lock:
            if not self.released:
                self.released = True
                self.lane.slots.release()

    def finish(self, *, worker=False, waiter=False):
        with self.lock:
            self.worker_finished |= worker
            self.waiter_finished |= waiter
            if self.worker_finished and self.waiter_finished and not self.released:
                self.released = True
                self.lane.slots.release()


class WorkLane:
    def __init__(self, workers, capacity, name):
        if workers < 1 or capacity < workers:
            raise ValueError("A lane needs positive workers and capacity >= workers")
        self.capacity = capacity
        self.name = name
        self.slots = threading.BoundedSemaphore(capacity)
        self.executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=name)

    def admit(self):
        if not self.slots.acquire(blocking=False):
            raise RecognitionBusy("Speech recognition admission is full.")
        return Permit(self)

    async def run(self, function, *, cancel=None, admission=None, queue_timeout=120.0):
        """Queue bounded work; a cancelled HTTP task never frees a running job.

        The queue deadline covers waiting to start a thread. Whisper retains its
        separate inference-lock deadline; neither forcibly stops a native kernel.
        """
        permit = admission if admission is not None else self.admit()
        if permit.lane is not self or permit.transferred or permit.released:
            raise ValueError("An unused permit from this lane is required")
        future = None
        try:
            if not math.isfinite(queue_timeout) or queue_timeout <= 0:
                raise ValueError("The queue timeout must be finite and positive")
            check_cancelled(cancel)
            loop = asyncio.get_running_loop()
            done = asyncio.Event()
            queued_at = time.monotonic()
            deadline = getattr(cancel, "queue_deadline", queued_at + queue_timeout)
            if cancel is not None:
                cancel.queue_deadline = deadline
            request_id = getattr(cancel, "request_id", None)
            if request_id:
                _LOG.info("Recognition request id=%s state=executor_queued lane=%s", request_id, self.name)

            def work():
                check_cancelled(cancel)
                if time.monotonic() >= deadline:
                    raise RecognitionBusy("Speech recognition executor wait expired.")
                if request_id:
                    _LOG.info("Recognition request id=%s state=executor_started lane=%s wait_ms=%d",
                              request_id, self.name, round((time.monotonic() - queued_at) * 1000))
                return function()

            permit.transferred = True
            try:
                future = self.executor.submit(work)
            except BaseException:
                permit.release()
                raise

            def finished(_future):
                permit.finish(worker=True)
                if request_id:
                    _LOG.info("Recognition request id=%s state=%s lane=%s", request_id,
                              "executor_cancelled" if _future.cancelled() else "executor_finished", self.name)
                # The HTTP task/loop can already have ended while native work ran.
                try:
                    loop.call_soon_threadsafe(done.set)
                except RuntimeError:
                    pass

            future.add_done_callback(finished)
            while True:
                check_cancelled(cancel)
                if future.done():
                    return future.result()
                if not future.running() and time.monotonic() >= deadline:
                    if future.cancel():
                        raise RecognitionBusy("Speech recognition executor wait expired.")
                try:
                    await asyncio.wait_for(done.wait(), timeout=0.05)
                except asyncio.TimeoutError:
                    pass
        except (asyncio.CancelledError, RecognitionCancelled):
            if cancel is not None:
                cancel.set()
            if future is not None:
                future.cancel()  # Queued jobs disappear; active threads keep their permit.
            raise
        finally:
            if permit.transferred:
                permit.finish(waiter=True)
            else:
                permit.release()


# Separate admission before parsing multipart and separate executors after it.
# Four normal uploads/jobs cannot occupy the control detector or the TTS pool.
recognition_lane = WorkLane(2, 4, "voix-stt")
control_lane = WorkLane(2, 4, "voix-controls")
