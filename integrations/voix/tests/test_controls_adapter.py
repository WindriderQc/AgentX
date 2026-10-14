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
    decoded = []
    def transcribe(raw, filename, language, **kwargs):
        decoded.append((raw, language))
        return ("bonjour", 5.0)
    monkeypatch.setattr(adapter, "_transcribe_bytes", transcribe)
    client = TestClient(adapter.app)
    upload = {"file": ("mic.wav", wav(), "audio/wav")}
    stopped = client.post("/v1/audio/transcriptions/controls", files=upload).json()
    assert stopped["control"] == "stop" and stopped["text"] == ""
    assert decoded == []
    adapter.control.model.heard = "[unk]"
    spoken = client.post("/v1/audio/transcriptions/controls", files=upload, data={"language": "fr"}).json()
    assert spoken["text"] == "bonjour" and "control" not in spoken
    assert spoken["language"] == "fr" and spoken["model"] == service.settings.whisper_model
    assert decoded == [(wav(), "fr")]


def test_standalone_stop_still_works_when_general_gpu_recognition_is_unavailable(adapter, monkeypatch):
    def unavailable(*_args, **_kwargs):
        raise service.RecognitionUnavailable("private decoder detail")
    monkeypatch.setattr(adapter, "_transcribe_bytes", unavailable)
    client = TestClient(adapter.app)
    upload = {"file": ("mic.wav", wav(), "audio/wav")}
    stopped = client.post("/v1/audio/transcriptions/controls", files=upload)
    assert stopped.status_code == 200 and stopped.json()["control"] == "stop"
    adapter.control.model.heard = "stop [unk]"
    request = client.post("/v1/audio/transcriptions/controls", files=upload)
    assert request.status_code == 503 and request.json()["code"] == "STT_GPU_UNAVAILABLE"
    assert "private" not in request.text


def test_control_adapter_keeps_general_recognition_evidence_but_never_borrows_it_for_stop(adapter, monkeypatch):
    from app.stt.whisper import _transcript
    evidence = {"schema": 1, "queueMs": 10, "decodeMs": 20, "languageSource": "requested"}
    monkeypatch.setattr(adapter, "_transcribe_bytes", lambda *_args, **_kwargs: (_transcript("Oui", "fr", evidence), 30))
    client = TestClient(adapter.app)
    upload = {"file": ("mic.wav", wav(), "audio/wav")}
    adapter.control.model.heard = "[unk]"
    assert client.post("/v1/audio/transcriptions/controls", files=upload).json()["recognition"] == evidence
    adapter.control.model.heard = "stop"
    stopped = client.post("/v1/audio/transcriptions/controls", files=upload).json()
    assert stopped["control"] == "stop" and "recognition" not in stopped


@pytest.mark.parametrize("heard,effective", [("stop", "vosk-command"), ("[unk]", None)])
def test_controls_name_the_recognizer_that_ran_instead_of_the_requested_model(adapter, monkeypatch, heard, effective):
    decoded = []

    def transcribe(*_args, **_kwargs):
        decoded.append(True)
        return "Bonjour.", 5.0

    adapter.control.model.heard = heard
    monkeypatch.setattr(adapter, "_transcribe_bytes", transcribe)
    body = TestClient(adapter.app).post(
        "/v1/audio/transcriptions/controls",
        files={"file": ("mic.wav", wav(), "audio/wav")},
        data={"model": "requested-model-not-loaded", "language": "fr"},
    ).json()
    actual = effective or service.settings.whisper_model
    assert body["model"] == actual and body["effectiveModel"] == actual
    assert body["requestedModel"] == "requested-model-not-loaded"
    assert decoded == ([] if heard == "stop" else [True])
