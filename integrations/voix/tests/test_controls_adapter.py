"""The optional spoken-controls adapter still mounts on the slim speech service."""
import importlib
import io
import json
import sys
import types
import wave

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

import app.service as service  # noqa: E402


class FakeRecognizer:
    """Stands in for Vosk: hears the word given as the model, with full confidence."""

    def __init__(self, model, _rate, _grammar):
        self.heard = model.heard

    def SetWords(self, _value):
        pass

    def AcceptWaveform(self, _data):
        return False

    def FinalResult(self):
        return json.dumps({"text": self.heard, "result": [{"word": self.heard, "conf": 1.0}]})


def wav(seconds=0.1, rate=16000):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b"\0\0" * int(rate * seconds))
    return buffer.getvalue()


@pytest.fixture
def adapter(tmp_path, monkeypatch):
    vosk = types.ModuleType("vosk")
    vosk.Model = lambda _directory: types.SimpleNamespace(heard="stop")
    vosk.KaldiRecognizer = FakeRecognizer
    vosk.SetLogLevel = lambda _level: None
    monkeypatch.setitem(sys.modules, "vosk", vosk)
    monkeypatch.setenv("VOIX_CONTROL_MODEL_DIR", str(tmp_path))
    routes = list(service.app.router.routes)
    sys.modules.pop("agentx_voix_controls", None)
    module = importlib.import_module("agentx_voix_controls")
    try:
        yield module
    finally:
        # The adapter adds its routes to the shared application: take them back.
        service.app.router.routes[:] = routes
        sys.modules.pop("agentx_voix_controls", None)


def test_adapter_adds_its_two_routes_to_the_speech_service(adapter):
    assert adapter.app is service.app
    client = TestClient(adapter.app)
    assert client.get("/api/voice-controls/status").json() == {
        "ready": True, "recognizer": "vosk", "controls": ["stop"], "audioStored": False}
    assert client.get("/health").json()["status"] == "ok"


def test_a_spoken_stop_answers_as_a_control_and_ordinary_speech_as_text(adapter, monkeypatch):
    monkeypatch.setattr(adapter, "_transcribe_bytes", lambda raw, filename, language: ("bonjour", 5.0))
    client = TestClient(adapter.app)
    upload = {"file": ("mic.wav", wav(), "audio/wav")}
    stopped = client.post("/v1/audio/transcriptions/controls", files=upload).json()
    assert stopped["control"] == "stop" and stopped["text"] == ""
    adapter.control.model.heard = "[unk]"
    spoken = client.post("/v1/audio/transcriptions/controls", files=upload, data={"language": "fr"}).json()
    assert spoken["text"] == "bonjour" and "control" not in spoken
    assert spoken["language"] == "fr" and spoken["model"] == service.settings.whisper_model
