import asyncio
import io
import tempfile

import pytest
from starlette.requests import ClientDisconnect, Request

from app.audio_upload import audio_form


@pytest.mark.asyncio
@pytest.mark.parametrize("ending", [ClientDisconnect, asyncio.CancelledError])
async def test_partial_upload_closes_memory_file_on_disconnect_or_cancel(monkeypatch, ending):
    from starlette import formparsers

    files = []
    original = tempfile.SpooledTemporaryFile

    def tracked(*args, **kwargs):
        file = original(*args, **kwargs)
        files.append(file)
        return file

    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", tracked)
    part = b'--sample\r\nContent-Disposition: form-data; name="file"; filename="mic.wav"\r\n\r\npartial'
    calls = 0

    async def receive():
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"type": "http.request", "body": part, "more_body": True}
        raise ending()

    request = Request({"type": "http", "headers": [(b"content-type", b"multipart/form-data; boundary=sample")]}, receive)
    with pytest.raises(ending):
        async with audio_form(request):
            pytest.fail("Incomplete request must not decode")
    assert len(files) == 1
    assert files[0].closed


def test_decoder_stream_closes_after_failure(monkeypatch):
    from app import service
    from app.stt import whisper

    streams = []

    def fail(audio, **kwargs):
        assert isinstance(audio, io.BytesIO)
        streams.append(audio)
        assert audio.read() == b"audio"
        raise ValueError("Invalid audio")

    monkeypatch.setattr(whisper, "transcribe_path", fail)
    with pytest.raises(ValueError, match="Invalid audio"):
        service._transcribe_bytes(b"audio", "mic.wav", "fr")
    assert streams[0].closed
