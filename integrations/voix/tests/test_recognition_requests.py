import asyncio
import threading
from types import SimpleNamespace

import pytest

from app.cancel import CancelToken
from app.stt import whisper
from app.stt.requests import RecognitionBusy, RecognitionCancelled, cancellation, inference_slot


def test_cancelled_waiter_exits_while_the_previous_decoder_still_owns_the_lock(monkeypatch):
    lock, token = threading.Lock(), CancelToken()
    monkeypatch.setattr(whisper, "_inference_lock", lock)
    monkeypatch.setattr(whisper, "_get_model", lambda *_: pytest.fail("stale request started a model"))
    errors = []

    def waiting():
        try:
            whisper.transcribe_path("discarded.wav", language="fr", cancel=token)
        except Exception as error:
            errors.append(error)

    lock.acquire()
    worker = threading.Thread(target=waiting)
    try:
        worker.start()
        token.set()
        worker.join(1)
        assert not worker.is_alive(), "cancellation must not wait for the older decode"
        assert len(errors) == 1 and isinstance(errors[0], RecognitionCancelled)
        assert lock.locked(), "only the previous decoder can release its lock"
    finally:
        lock.release()
        worker.join(1)


def test_expired_waiter_never_claims_or_releases_another_decoders_lock():
    lock = threading.Lock()
    lock.acquire()
    try:
        with pytest.raises(RecognitionBusy):
            with inference_slot(lock, None, 0.01):
                pytest.fail("expired wait entered the model")
        assert lock.locked()
    finally:
        lock.release()
    with inference_slot(lock, None, 1) as wait_ms:
        assert wait_ms >= 0
    assert not lock.locked()


def test_cancellation_after_preprocessing_does_not_pull_the_first_lazy_segment():
    token = CancelToken()

    class Model:
        def transcribe(self, *_args, **_options):
            token.set()

            def segments():
                pytest.fail("cancelled request entered lazy decoding")
                yield

            return segments(), SimpleNamespace(language="fr")

    with pytest.raises(RecognitionCancelled):
        whisper._run(Model(), "discarded.wav", "fr", cancel=token)


def test_decoder_failure_releases_its_own_slot():
    lock = threading.Lock()
    with pytest.raises(ValueError):
        with inference_slot(lock, None, 1):
            raise ValueError("fixture")
    assert not lock.locked()


@pytest.mark.asyncio
async def test_disconnect_after_complete_upload_drops_decode_waiting_behind_another_request(monkeypatch):
    from starlette.requests import Request
    from app import service

    lock, calls = threading.Lock(), []
    monkeypatch.setattr(whisper, "_inference_lock", lock)

    class Model:
        def transcribe(self, *_args, **_options):
            calls.append("decode")
            return iter([SimpleNamespace(text="Bonjour")]), SimpleNamespace(language="fr")

    monkeypatch.setattr(whisper, "_get_model", lambda *_: Model())
    body = (b'--fixture\r\nContent-Disposition: form-data; name="file"; filename="mic.wav"\r\n'
            b'Content-Type: audio/wav\r\n\r\naudio\r\n--fixture--\r\n')
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    request = Request({"type": "http", "headers": [(b"content-type", b"multipart/form-data; boundary=fixture")]}, receive)
    lock.acquire()
    task = asyncio.create_task(service.transcriptions(request))
    try:
        with pytest.raises(RecognitionCancelled):
            await asyncio.wait_for(asyncio.shield(task), 1)
        assert calls == [], "abandoned upload must never start the model"
        assert lock.locked()
    finally:
        lock.release()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_uploaded_request_disconnect_sets_the_decoder_token_and_closes_the_watcher():
    class Request:
        async def is_disconnected(self):
            return True

    async with cancellation(Request()) as token:
        for _ in range(10):
            if token.is_set():
                break
            await asyncio.sleep(0)
        assert token.is_set()


@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf"])
def test_invalid_queue_budget_is_rejected(monkeypatch, value):
    from app.config import load_settings
    monkeypatch.setenv("WHISPER_QUEUE_TIMEOUT_SECONDS", value)
    with pytest.raises(ValueError, match="WHISPER_QUEUE_TIMEOUT_SECONDS"):
        load_settings()
