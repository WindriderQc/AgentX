"""Routes of the slim speech service: what Core calls, and nothing native."""
import asyncio
import json

import numpy as np
import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from app import warmup  # noqa: E402
from app.service import app  # noqa: E402
import app.service as service  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_speech_state(tmp_path, monkeypatch):
    from app.runtime import RuntimeConfig

    monkeypatch.setenv("VOIX_PREFERENCES_PATH", str(tmp_path / "speech-preferences.json"))
    monkeypatch.setattr("app.tts.windows_sapi.installed_voices", lambda: [
        {"name": "Microsoft David", "locale": "en-US"}, {"name": "Microsoft Claude", "locale": "fr-CA"}])
    monkeypatch.setattr(service, "speech", RuntimeConfig.from_settings())
    monkeypatch.setattr(service, "speech_preferences_error", "")
    monkeypatch.setattr(warmup, "_status", {
        "state": "ready", "stage": "complete", "started_at": None, "completed_at": None, "stages": {}})


# ======================= health / discovery =======================

def test_health_reports_only_the_speech_service():
    for path in ("/health", "/api/health"):
        body = client.get(path).json()
        assert body == {"status": "ok", "version": service.VERSION, "running": False,
                        "warmup": warmup.snapshot()}
        assert body["warmup"]["state"] == "ready"


def test_version():
    assert client.get("/version").json() == {"version": service.VERSION}


def test_player_script_is_served():
    response = client.get("/assets/voice-audio.js")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/javascript")
    assert "voix-pcm-v1" in response.text


def test_voice_catalog_is_served_without_loading_a_model(tmp_path, monkeypatch):
    from app.tts import catalog

    monkeypatch.setattr(catalog, "get_kokoro_asset_paths",
                        lambda: (tmp_path / "missing.onnx", tmp_path / "missing.bin"))
    monkeypatch.setattr(catalog, "worker_ready", lambda: (False, "VoxCPM2 worker is not configured"))
    body = client.get("/api/voices").json()
    assert body["schema"] == 1 and body["streamProtocol"] == "voix-pcm-v1"
    assert {row["id"] for row in body["providers"]} == {"kokoro", "windows_sapi", "voxcpm"}
    assert {row["id"] for row in body["voices"]} == {"Microsoft David", "Microsoft Claude"}


@pytest.mark.parametrize("method,path", [
    ("get", "/"), ("get", "/devices"), ("get", "/metrics"), ("get", "/memory/status"),
    ("get", "/media-vault/status"), ("get", "/media-vault/clips"), ("get", "/voice-profile"),
    ("get", "/openclaw/voice-profile"), ("get", "/sessions"), ("get", "/sessions/status"),
    ("post", "/sessions"), ("post", "/sessions/start"), ("post", "/sessions/stop"),
    ("post", "/sessions/cancel"), ("post", "/sessions/text-turn"), ("post", "/api/speak"),
    ("post", "/api/play"), ("post", "/api/stop"), ("post", "/diagnostics/smoke"),
])
def test_native_conversation_routes_are_gone(method, path):
    assert getattr(client, method)(path).status_code == 404


def test_only_the_speech_routes_are_registered():
    routes = {(method, route.path) for route in app.routes if hasattr(route, "methods")
              for method in route.methods - {"HEAD", "OPTIONS"}
              if not route.path.startswith(("/docs", "/redoc", "/openapi"))}
    assert routes == {
        ("GET", "/health"), ("GET", "/api/health"), ("GET", "/version"), ("GET", "/v1/models"),
        ("GET", "/api/voices"), ("GET", "/assets/voice-audio.js"),
        ("GET", "/config"), ("POST", "/config"),
        ("POST", "/v1/audio/transcriptions"), ("POST", "/api/preload-stt"), ("POST", "/api/stt/warm"),
        ("POST", "/api/tts"), ("POST", "/api/tts/stream"), ("POST", "/v1/audio/speech"),
        ("POST", "/diagnostics/tts-smoke"),
    }


# ======================= speech settings =======================

def test_config_holds_only_speech_settings():
    body = client.get("/config").json()
    assert set(body) == {"config", "static", "running", "speech_preferences", "restart_note"}
    assert set(body["config"]) == {"language", "tts_provider", "tts_voice_en", "tts_voice_fr"}
    assert body["running"] is False
    assert body["config"]["tts_provider"] in {"kokoro", "windows_sapi"}
    assert body["static"]["whisper_model"]
    assert body["static"]["kokoro_onnx_provider"] in {"CPUExecutionProvider", "CUDAExecutionProvider"}
    assert {row["language"] for row in body["static"]["tts_language_profiles"]} == {"en", "fr"}
    assert body["speech_preferences"] == {"fields": ["tts_provider", "tts_voice_en", "tts_voice_fr"], "error": ""}


def test_post_config_updates_speech_choices_and_ignores_native_settings():
    response = client.post("/config", json={
        "tts_provider": "windows_sapi", "tts_voice_fr": "Microsoft Claude",
        "brain": "agentx", "conversation_mode": "dad", "vad_end_silence_ms": 800,
    })
    body = response.json()
    assert response.status_code == 200
    assert body["changed"] == ["tts_provider", "tts_voice_fr"]
    assert body["config"] == {"language": service.speech.language, "tts_provider": "windows_sapi",
                              "tts_voice_en": "", "tts_voice_fr": "Microsoft Claude"}
    assert body["applies"] == "immediately" and body["speech_preferences_saved"] is False


def test_post_config_does_not_partially_apply_invalid_payload():
    before = service.speech.to_dict()
    response = client.post("/config", json={"language": "en", "tts_provider": "not-real"})
    assert response.status_code == 400
    assert service.speech.to_dict() == before
    assert client.post("/config", content=b"not json",
                       headers={"Content-Type": "application/json"}).status_code == 400


def test_voxcpm_cannot_be_selected_before_its_worker_is_configured():
    response = client.post("/config", json={"tts_provider": "voxcpm"})
    assert response.status_code == 400
    assert "VOXCPM_BASE_URL" in response.json()["error"]


def test_saved_speech_choices_survive_a_restart(tmp_path):
    from app.runtime import RuntimeConfig
    from app.tts import preferences

    response = client.post("/config", json={"tts_provider": "windows_sapi",
                                            "tts_voice_en": "Microsoft David", "persist": True})
    assert response.json()["speech_preferences_saved"] is True
    assert json.loads(preferences.path().read_text()) == {
        "tts_provider": "windows_sapi", "tts_voice_en": "Microsoft David", "tts_voice_fr": ""}
    restarted = RuntimeConfig.from_settings()
    assert preferences.load(restarted) == ""
    assert restarted.tts_provider == "windows_sapi" and restarted.tts_voice_en == "Microsoft David"


def test_unwritable_preferences_are_reported_and_not_applied(monkeypatch):
    from app.tts import preferences

    def refuse(_config):
        raise OSError("read-only")

    monkeypatch.setattr(preferences, "save", refuse)
    before = service.speech.to_dict()
    response = client.post("/config", json={"tts_provider": "windows_sapi", "persist": True})
    assert response.status_code == 503
    assert service.speech.to_dict() == before


def test_saved_voice_is_used_only_when_the_caller_asks_for_service_defaults(monkeypatch):
    import app.tts.provider as tts

    seen = []

    def synthesize(text, provider=None, **kwargs):
        seen.append((provider, kwargs))
        return np.zeros(64, dtype=np.float32), 24000, 1.0

    monkeypatch.setattr(tts, "synthesize", synthesize)
    service.speech.update({"language": "en", "tts_voice_en": "bm_lewis"})
    assert client.post("/api/tts", json={"text": "Hello", "native_defaults": True}).status_code == 200
    assert seen[-1] == ("kokoro", {"language": "en-us", "voice": "bm_lewis"})
    assert client.post("/api/tts", json={"text": "Hello", "language": "en"}).status_code == 200
    assert seen[-1] == ("kokoro", {"language": "en-us", "voice": "af_heart"})


# ======================= startup warm-up =======================

def test_startup_warmup_loads_recognition_then_synthesis_and_no_brain(monkeypatch):
    from app.stt import whisper
    from app.tts import provider

    loaded = []
    monkeypatch.setattr(whisper, "preload_model", lambda: loaded.append("stt"))
    monkeypatch.setattr(provider, "preload", lambda name: loaded.append("tts:" + name))
    asyncio.run(warmup.run("kokoro"))
    status = client.get("/health").json()["warmup"]
    assert loaded == ["stt", "tts:kokoro"]
    assert status["state"] == "ready" and status["stage"] == "complete"
    assert set(status["stages"]) == {"stt", "tts"}
    assert all(stage["state"] == "ready" for stage in status["stages"].values())


def test_a_failed_warmup_stage_degrades_the_service_without_stopping_it(monkeypatch):
    from app.stt import whisper
    from app.tts import provider

    def missing():
        raise RuntimeError("model files are missing")

    monkeypatch.setattr(whisper, "preload_model", missing)
    monkeypatch.setattr(provider, "preload", lambda name: None)
    monkeypatch.setattr(warmup._LOG, "error", lambda *args, **kwargs: None)
    monkeypatch.setattr(warmup._LOG, "warning", lambda *args, **kwargs: None)
    asyncio.run(warmup.run("kokoro"))
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["warmup"]["state"] == "degraded"
    assert body["warmup"]["stages"]["stt"]["state"] == "failed"
    assert body["warmup"]["stages"]["tts"]["state"] == "ready"


def test_preload_reports_the_loaded_recognition_model(monkeypatch):
    from app.stt import whisper

    monkeypatch.setattr(whisper, "preload_model",
                        lambda: {"device": "cpu", "computeType": "int8", "model": "fixture"})
    assert client.post("/api/preload-stt").json() == {
        "ok": True, "device": "cpu", "computeType": "int8", "model": "fixture"}


# ======================= recognition and synthesis =======================

def test_uploaded_audio_larger_than_spool_threshold_stays_in_memory(monkeypatch):
    import tempfile
    from starlette import formparsers
    from app.stt import whisper

    files = []
    original = tempfile.SpooledTemporaryFile

    def tracked(*args, **kwargs):
        file = original(*args, **kwargs)
        files.append(file)
        return file

    def forbidden(*args, **kwargs):
        raise AssertionError("Upload must not write a temporary file")

    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", tracked)
    monkeypatch.setattr(tempfile, "TemporaryFile", forbidden)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", forbidden)
    raw = b"audio" * (300 * 1024)

    def decode(audio, language=None):
        assert audio.read() == raw
        assert language == "en"
        return "Private upload", 3.0

    monkeypatch.setattr(whisper, "transcribe_path", decode)
    result = client.post("/v1/audio/transcriptions", files={"file": ("mic.wav", raw)}, data={"language": "en"})
    assert result.status_code == 200
    assert result.json()["text"] == "Private upload"
    assert files and all(file.closed and not file._rolled for file in files)


@pytest.mark.parametrize("provider", ["kokoro", "windows_sapi", "voxcpm"])
@pytest.mark.parametrize("path,text_field", [
    ("/api/tts", "text"), ("/v1/audio/speech", "input"), ("/api/tts/stream", "text"),
])
@pytest.mark.parametrize("text,expected", [
    ("**Bonjour.** C'est *prêt*.", "Bonjour. C'est prêt."),
    (r"\*\*Bonjour\*\*", "Bonjour"),
    ("**", ""),
])
def test_http_speech_removes_markdown_before_every_engine(monkeypatch, provider, path, text_field, text, expected):
    import base64
    import json
    from app.tts import kokoro, voxcpm, windows_sapi

    spoken = []

    def synthesize(value, **kwargs):
        spoken.append(value)
        return np.ones(24, dtype=np.float32), 24000, 1.0

    async def stream(value, **kwargs):
        yield synthesize(value)

    monkeypatch.setattr(kokoro, "synthesize", synthesize)
    monkeypatch.setattr(windows_sapi, "synthesize", synthesize)
    monkeypatch.setattr(voxcpm, "synthesize", synthesize)
    monkeypatch.setattr(voxcpm, "stream", stream)
    monkeypatch.setattr("app.tts.catalog.worker_ready", lambda: (True, ""))
    response = client.post(path, json={text_field: text, "tts_provider": provider,
                                      "language": "fr", "response_format": "wav"})
    assert response.status_code == 200
    assert " ".join(spoken) == expected
    if path.endswith("/stream"):
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[-1]["type"] == "done"
        if not expected:
            samples = np.frombuffer(base64.b64decode(events[1]["pcm"]), dtype="<f4")
            assert samples.size == 1
            assert not np.any(samples)
    else:
        assert response.content.startswith(b"RIFF")


def _voxcpm_worker(monkeypatch, *, up):
    """A configured VoxCPM2 worker whose /health answer the test controls."""
    from dataclasses import replace
    import httpx
    from app.tts import catalog, provider
    configured = replace(catalog.settings, voxcpm_base_url="http://127.0.0.1:8092", voxcpm_voice="nestor-a")
    monkeypatch.setattr(catalog, "settings", configured)
    monkeypatch.setattr(provider, "settings", configured)
    monkeypatch.setattr(catalog, "_worker_health", (0.0, False, "Not checked", {}))
    probes = []
    def health(url, **kwargs):
        probes.append(url)
        if not up:
            raise httpx.ConnectError("refused")
        return httpx.Response(200, json={"ready": True, "voice": "nestor-a",
                                         "voices": [{"id": "nestor-a"}, {"id": "helper"}]},
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(catalog.httpx, "get", health)
    return probes


def test_configured_voxcpm_voice_streams_when_its_worker_is_ready(monkeypatch):
    import json
    from app.tts import voxcpm
    probes = _voxcpm_worker(monkeypatch, up=True)
    async def stream(text, **kwargs):
        yield np.ones(48, dtype=np.float32), 48000, 1.0
    monkeypatch.setattr(voxcpm, "stream", stream)
    for _ in range(2):
        response = client.post("/api/tts/stream", json={"text": "Bonjour", "tts_provider": "voxcpm", "language": "fr"})
        assert response.status_code == 200
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[0]["voice"] == "nestor-a" and events[-1]["type"] == "done"
    assert len(probes) == 1, "the second request reuses the cached readiness answer"


@pytest.mark.parametrize("voice", [None, "helper"])
@pytest.mark.parametrize("path,text_field", [
    ("/api/tts/stream", "text"), ("/api/tts", "text"), ("/v1/audio/speech", "input"),
])
def test_unready_voxcpm_worker_answers_503_before_any_synthesis(monkeypatch, path, text_field, voice):
    from app.tts import kokoro, voxcpm, windows_sapi
    probes = _voxcpm_worker(monkeypatch, up=False)
    spoken = []
    def synthesize(text, **kwargs):
        spoken.append(text)
        return np.ones(24, dtype=np.float32), 24000, 1.0
    async def stream(text, **kwargs):
        yield synthesize(text)
    for engine in (kokoro, windows_sapi, voxcpm):
        monkeypatch.setattr(engine, "synthesize", synthesize)
    monkeypatch.setattr(voxcpm, "stream", stream)
    body = {text_field: "Bonjour", "tts_provider": "voxcpm", "language": "fr", "response_format": "wav"}
    if voice:
        body["voice"] = voice
    response = client.post(path, json=body)
    assert response.status_code == 503
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {"error": "VoxCPM2 worker is unavailable"}
    assert spoken == [], "The service neither starts the stream nor substitutes another voice"
    assert len(probes) == 1


def test_post_config_rejects_bad_tts_provider():
    r = client.post("/config", json={"tts_provider": "not-real"})
    assert r.status_code == 400
    assert "tts_provider" in r.json()["error"]


def test_models_lists_active_whisper_model():
    j = client.get("/v1/models").json()
    assert j["object"] == "list"
    assert j["data"][0]["type"] == "whisper"


def test_transcribe_requires_audio():
    # missing file field -> FastAPI validation error (422)
    assert client.post("/v1/audio/transcriptions").status_code == 422


def test_tts_requires_text():
    assert client.post("/api/tts", json={}).status_code == 400


def test_tts_passes_matching_language_and_voice(monkeypatch):
    import app.tts.provider as tts

    seen = {}

    def fake_synthesize(text, provider=None, **kwargs):
        seen.update(text=text, provider=provider, **kwargs)
        return np.zeros(64, dtype=np.float32), 16000, 2.0

    monkeypatch.setattr(tts, "synthesize", fake_synthesize)
    response = client.post("/api/tts", json={
        "text": "The English brief is ready.",
        "language": "en",
        "voice": "af_heart",
    })
    assert response.status_code == 200
    assert seen["language"] == "en-us"
    assert seen["voice"] == "af_heart"


def test_tts_allows_cross_language_timbre_with_requested_phonemes(monkeypatch):
    import app.tts.provider as tts

    seen = {}

    def fake_synthesize(text, provider=None, **kwargs):
        seen.update(text=text, provider=provider, **kwargs)
        return np.zeros(64, dtype=np.float32), 16000, 2.0

    monkeypatch.setattr(tts, "synthesize", fake_synthesize)
    response = client.post("/api/tts", json={
        "text": "Bonsoir.",
        "language": "fr",
        "voice": "am_michael",
    })
    assert response.status_code == 200
    assert seen["language"] == "fr-fr"
    assert seen["voice"] == "am_michael"


def test_kokoro_language_profiles_cover_english_and_french():
    import app.tts.provider as tts
    from app.config import settings

    profiles = {entry["language"]: entry for entry in tts.language_profiles("kokoro")}
    assert profiles["en"] == {"language": "en", "locale": "en-us", "voice": "af_heart"}
    assert profiles["fr"] == {
        "language": "fr",
        "locale": "fr-fr",
        "voice": settings.kokoro_voice,
    }


def test_speech_openai_requires_input():
    assert client.post("/v1/audio/speech", json={}).status_code == 400


def test_speech_openai_accepts_form(monkeypatch):
    import app.tts.provider as tts

    monkeypatch.setattr(
        tts,
        "synthesize",
        lambda text, provider=None, **kwargs: (np.zeros(64, dtype=np.float32), 16000, 3.0),
    )
    r = client.post("/v1/audio/speech", data={"input": "Bonjour"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"


def test_diagnostics_tts_smoke(monkeypatch):
    import app.tts.provider as tts

    monkeypatch.setattr(
        tts,
        "synthesize",
        lambda text, provider=None, **kwargs: (np.zeros(64, dtype=np.float32), 16000, 3.0),
    )
    j = client.post("/diagnostics/tts-smoke", json={"text": "Bonjour"}).json()
    assert j["ok"] is True
    assert j["timings"]["tts_ms"] == 3


def test_tts_uses_runtime_selected_provider(monkeypatch):
    import app.tts.provider as tts

    seen = {}

    def fake_synthesize(text, provider=None, **kwargs):
        seen["provider"] = provider
        return np.zeros(64, dtype=np.float32), 16000, 2.0

    service.speech.tts_provider = "windows_sapi"
    monkeypatch.setattr(tts, "synthesize", fake_synthesize)

    r = client.post("/api/tts", json={"text": "Bonjour"})
    assert r.status_code == 200
    assert seen["provider"] == "windows_sapi"


@pytest.mark.parametrize("requested,expected", [(None, "auto"), ("auto", "auto"), ("en", "en"), ("fr", "fr"), ("fr-en", "fr-en")])
def test_transcription_text_format_and_request_language(monkeypatch, requested, expected):
    seen = {}

    def fake_transcribe(raw, filename, language):
        seen["language"] = language
        return "bonjour texte", 12.0

    service.speech.language = "fr"
    monkeypatch.setattr(service, "_transcribe_bytes", fake_transcribe)
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("audio.wav", b"RIFFfake", "audio/wav")},
        data={"response_format": "text", **({"language": requested} if requested else {})},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert response.text == "bonjour texte"
    assert seen["language"] == expected


def test_oversized_upload_is_rejected_before_spooling_or_decoding(monkeypatch):
    import tempfile
    from app import audio_upload

    def forbidden(*args, **kwargs):
        raise AssertionError("Oversized request must not reach disk or decoder")

    monkeypatch.setattr(audio_upload, "MAX_UPLOAD_BYTES", 1024)
    monkeypatch.setattr(tempfile, "TemporaryFile", forbidden)
    monkeypatch.setattr(service, "_transcribe_bytes", forbidden)
    response = client.post("/v1/audio/transcriptions", files={"file": ("mic.wav", b"x" * 2048)})
    assert response.status_code == 413


@pytest.mark.parametrize("elapsed,expected", [
    (412.6, {"warmed": True, "warmMs": 413}),
    (None, {"warmed": False}),
])
def test_stt_warm_reports_a_duration_only_when_the_model_ran(monkeypatch, elapsed, expected):
    from app.stt import whisper

    calls = []

    def warm():
        calls.append(True)
        return elapsed

    monkeypatch.setattr(whisper, "warm", warm)
    response = client.post("/api/stt/warm")
    assert response.status_code == 200
    assert response.json() == expected
    assert calls == [True]


def test_multipart_missing_file_and_boundary_are_rejected():
    assert client.post("/v1/audio/transcriptions", files={"wrong": ("mic.wav", b"audio")}).status_code == 422
    assert client.post("/v1/audio/transcriptions", content=b"invalid", headers={"Content-Type": "multipart/form-data"}).status_code == 400


def test_speech_honors_wav_and_rejects_unknown_format(monkeypatch):
    import app.tts.provider as tts

    monkeypatch.setattr(
        tts,
        "synthesize",
        lambda text, provider=None, **kwargs: (np.zeros(64, dtype=np.float32), 16000, 3.0),
    )
    wav = client.post(
        "/v1/audio/speech",
        json={"input": "Bonjour", "response_format": "wav"},
    )
    assert wav.status_code == 200
    assert wav.headers["content-type"] == "audio/wav"
    assert wav.content.startswith(b"RIFF")

    invalid = client.post(
        "/v1/audio/speech",
        json={"input": "Bonjour", "response_format": "aac"},
    )
    assert invalid.status_code == 400


def test_speech_supports_opus(monkeypatch):
    import app.tts.provider as tts

    monkeypatch.setattr(
        tts,
        "synthesize",
        lambda text, provider=None, **kwargs: (np.zeros(256, dtype=np.float32), 24000, 3.0),
    )
    response = client.post(
        "/v1/audio/speech",
        json={"input": "Bonjour", "response_format": "opus"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/ogg"
    assert response.content.startswith(b"OggS")


def test_invalid_speech_format_is_rejected_before_synthesis(monkeypatch):
    import app.tts.provider as tts

    monkeypatch.setattr(
        tts,
        "synthesize",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid format must not synthesize")
        ),
    )
    response = client.post(
        "/v1/audio/speech", json={"input": "Bonjour", "response_format": "aac"}
    )
    assert response.status_code == 400


def test_tts_form_save_false_returns_audio(monkeypatch):
    import app.tts.provider as tts

    monkeypatch.setattr(
        tts,
        "synthesize",
        lambda text, provider=None, **kwargs: (np.zeros(64, dtype=np.float32), 16000, 3.0),
    )
    response = client.post("/api/tts", data={"text": "Bonjour", "save": "false"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"


@pytest.mark.parametrize("path,text_field", [("/api/tts", "text"), ("/v1/audio/speech", "input")])
def test_request_provider_does_not_mutate_shared_defaults(monkeypatch, path, text_field):
    from app.tts import provider as tts
    from app.tts import windows_sapi
    monkeypatch.setattr(windows_sapi, "installed_voices", lambda: [{"name": "Microsoft David", "locale": "en-US"}])
    service.speech.tts_provider = "windows_sapi"
    seen = []
    def synthesize(text, provider=None, **kwargs):
        seen.append((provider, kwargs))
        return np.zeros(240, dtype=np.float32), 24000, 1.0
    monkeypatch.setattr(tts, "synthesize", synthesize)
    response = client.post(path, json={text_field: "Bonjour", "tts_provider": "kokoro", "language": "fr", "voice": "am_michael:0.50+ff_siwis:0.50", "response_format": "wav"})
    assert response.status_code == 200
    assert seen[0] == ("kokoro", {"language": "fr-fr", "voice": "am_michael:0.50+ff_siwis:0.50"})
    assert service.speech.tts_provider == "windows_sapi"
    response = client.post(path, json={text_field: "Hello", "response_format": "wav"})
    assert response.status_code == 200
    assert seen[1][0] == "windows_sapi"
    assert seen[1][1]["voice"] == "Microsoft David"
    assert response.headers["x-voix-voice"] == "Microsoft%20David"
    assert service.speech.tts_provider == "windows_sapi"


def test_invalid_request_provider_cannot_change_machine_defaults():
    previous = service.speech.tts_provider
    response = client.post("/api/tts", json={"text": "Hello", "tts_provider": "made-up"})
    assert response.status_code == 400
    assert service.speech.tts_provider == previous


def test_transcription_reports_detected_language_for_one_voice_per_reply(monkeypatch):
    from app.stt.whisper import _transcript

    monkeypatch.setattr(service, "_transcribe_bytes", lambda raw, filename, language: (_transcript("Hello there", "en"), 9.0))
    body = client.post("/v1/audio/transcriptions", files={"file": ("mic.wav", b"RIFFfake")}, data={"language": "fr-en"}).json()
    assert body["language"] == "fr-en"
    assert body["detectedLanguage"] == "en"
