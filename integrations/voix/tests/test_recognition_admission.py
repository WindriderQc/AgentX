"""Admission and cancellation use fake decoders only; no model or audio archive."""
import asyncio
import threading
import time
from contextlib import asynccontextmanager

import httpx
import pytest

from app import service
from app.cancel import CancelToken
from app.stt.admission import WorkLane
from app.stt.requests import RecognitionBusy, RecognitionCancelled, inference_slot


@pytest.mark.asyncio
async def test_full_recognition_lane_refuses_before_reading_another_upload(monkeypatch):
    release, started = threading.Event(), threading.Event()
    parsed = []
    original = service.audio_form

    @asynccontextmanager
    async def observed(request):
        parsed.append(True)
        async with original(request) as form:
            yield form

    def decode(*_args, **_kwargs):
        started.set()
        release.wait(3)
        return "Bonjour", 1

    monkeypatch.setattr(service, "audio_form", observed)
    monkeypatch.setattr(service, "_transcribe_bytes", decode)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://fixture") as client:
        first = [asyncio.create_task(client.post('/v1/audio/transcriptions',
                 files={'file': ('mic.wav', b'fixture', 'audio/wav')})) for _ in range(4)]
        fifth = None
        try:
            for _ in range(100):
                if started.is_set() and len(parsed) == 4:
                    break
                await asyncio.sleep(0.005)
            assert len(parsed) == 4
            fifth = asyncio.create_task(client.post('/v1/audio/transcriptions',
                    files={'file': ('mic.wav', b'fixture', 'audio/wav')}))
            response = await asyncio.wait_for(asyncio.shield(fifth), 0.3)
            assert response.status_code == 503
            assert response.json()['code'] == 'STT_BUSY'
            assert response.headers['retry-after'] == '1'
            assert len(parsed) == 4, 'overload must be refused before multipart buffering'
        finally:
            release.set()
            await asyncio.gather(*first, *([fifth] if fifth else []), return_exceptions=True)


async def wait_until(predicate):
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0.005)
    pytest.fail('fixture did not reach its controlled state')


@pytest.mark.asyncio
async def test_cancelled_http_task_keeps_a_running_threads_permit_until_actual_completion():
    lane, cancel = WorkLane(1, 1, 'fixture'), CancelToken()
    release, entered = threading.Event(), threading.Event()

    def work():
        entered.set()
        release.wait(3)

    task = asyncio.create_task(lane.run(work, cancel=cancel))
    try:
        await wait_until(entered.is_set)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancel.is_set()
        with pytest.raises(RecognitionBusy):
            lane.admit()
        release.set()
    finally:
        release.set()
        lane.executor.shutdown(wait=True)
    with lane.admit():
        pass


@pytest.mark.asyncio
@pytest.mark.parametrize('expired', [False, True])
async def test_abandoned_or_expired_queued_job_never_starts_and_frees_only_its_own_permit(expired):
    lane, cancel = WorkLane(1, 2, 'fixture'), CancelToken()
    entered, release, decoded = threading.Event(), threading.Event(), threading.Event()

    def owner():
        entered.set()
        release.wait(3)

    active = asyncio.create_task(lane.run(owner))
    pending = None
    try:
        await wait_until(entered.is_set)
        pending = asyncio.create_task(lane.run(decoded.set, cancel=cancel, queue_timeout=0.02 if expired else 1))
        await asyncio.sleep(0.01)
        with pytest.raises(RecognitionBusy):
            lane.admit()
        if not expired:
            cancel.set()
        with pytest.raises(RecognitionBusy if expired else RecognitionCancelled):
            await asyncio.wait_for(pending, 1)
        assert not decoded.is_set() and not release.is_set()
        with lane.admit():
            with pytest.raises(RecognitionBusy):
                lane.admit()
    finally:
        release.set()
        await active
        if pending:
            await asyncio.gather(pending, return_exceptions=True)
        lane.executor.shutdown(wait=True)
    assert not decoded.is_set()


@pytest.mark.asyncio
async def test_exceptions_and_unused_permits_are_released_without_releasing_a_foreign_lane():
    lane, other = WorkLane(1, 1, 'fixture'), WorkLane(1, 1, 'other')
    try:
        with other.admit() as foreign:
            with pytest.raises(ValueError):
                await lane.run(lambda: None, admission=foreign)
            with pytest.raises(RecognitionBusy):
                other.admit()
        def broken():
            raise ValueError('fixture')
        with pytest.raises(ValueError, match='fixture'):
            await lane.run(broken)
        with lane.admit():
            pass
    finally:
        lane.executor.shutdown(wait=True)
        other.executor.shutdown(wait=True)


def test_executor_wait_and_inference_lock_share_one_deadline():
    token, lock = CancelToken(), threading.Lock()
    token.queue_deadline = time.monotonic() - 1
    with pytest.raises(RecognitionBusy):
        with inference_slot(lock, token, 120):
            pytest.fail('expired executor wait became another inference-lock budget')
    assert not lock.locked()


def test_preload_and_warm_share_normal_admission_without_entering_a_full_lane(monkeypatch):
    from contextlib import ExitStack
    from fastapi.testclient import TestClient
    from app.stt import whisper
    from app.stt.admission import recognition_lane
    monkeypatch.setattr(whisper, 'preload_model', lambda: pytest.fail('full preload entered the model'))
    monkeypatch.setattr(whisper, 'warm', lambda: pytest.fail('full warm entered the model'))
    with ExitStack() as stack:
        for _ in range(recognition_lane.capacity):
            stack.enter_context(recognition_lane.admit())
        for route in ['/api/preload-stt', '/api/stt/warm']:
            response = TestClient(service.app).post(route)
            assert response.status_code == 503 and response.json()['code'] == 'STT_BUSY'
        assert TestClient(service.app).get('/health').status_code == 200


@pytest.mark.asyncio
async def test_completed_worker_retains_its_permit_until_the_waiter_consumes_the_result():
    lane = WorkLane(1, 1, 'fixture')
    entered, release, completed = threading.Event(), threading.Event(), threading.Event()
    def work():
        entered.set()
        release.wait(3)
        completed.set()
        return 'done'
    task = asyncio.create_task(lane.run(work))
    try:
        await wait_until(entered.is_set)
        release.set()
        assert completed.wait(1)
        time.sleep(0.02)  # Only the fake worker advances; the HTTP waiter has not resumed.
        with pytest.raises(RecognitionBusy):
            lane.admit()
        assert await task == 'done'
        with lane.admit():
            pass
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        lane.executor.shutdown(wait=True)
