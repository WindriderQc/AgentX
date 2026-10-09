"""A Pocket-only instance never loads retired engines, including old client requests."""
from dataclasses import replace
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import config, runtime, service
from app.tts import catalog, preferences, provider


@pytest.fixture
def pocket_only(monkeypatch, tmp_path):
    settings = replace(config.settings, tts_provider="voxcpm", tts_pocket_only=True,
                       voxcpm_base_url="http://worker", voxcpm_voice="narrator",
                       tts_voice_aliases={"kokoro|ff_siwis": "helper"})
    for module in (config, runtime, service, catalog, provider):
        monkeypatch.setattr(module, "settings", settings)
    monkeypatch.setattr(service, "speech", runtime.RuntimeConfig.from_settings())
    monkeypatch.setattr(catalog, "worker_ready", lambda: (True, ""))
    monkeypatch.setattr(catalog, "worker_voices", lambda: {"narrator": "Narrator", "helper": "Helper"})
    monkeypatch.setattr(catalog, "_worker_model", "kyutai/pocket-tts")
    monkeypatch.setenv("VOIX_PREFERENCES_PATH", str(tmp_path / "preferences.json"))
    return settings


def test_pocket_catalog_does_not_touch_kokoro_assets_or_windows(pocket_only, monkeypatch):
    def retired(*args, **kwargs):
        raise AssertionError("Retired engine was inspected")
    monkeypatch.setattr(catalog, "get_kokoro_asset_paths", retired)
    monkeypatch.setattr(catalog.windows_sapi, "installed_voices", retired)
    result = catalog.catalog()
    assert [(p["id"], p["name"]) for p in result["providers"]] == [("voxcpm", "Pocket TTS")]
    assert {(v["id"], v["language"]) for v in result["voices"]} == {
        ("narrator", "fr"), ("narrator", "en"), ("helper", "fr"), ("helper", "en")}
    assert result["defaults"] == {"provider": "voxcpm", "voxcpm": "narrator"}


@pytest.mark.parametrize("retired", ["kokoro", "windows_sapi"])
def test_retired_engine_cannot_be_reenabled_or_preloaded(pocket_only, retired):
    client = TestClient(service.app)
    before = service.speech.to_dict()
    assert client.post("/config", json={"tts_provider": retired, "persist": True}).status_code == 400
    assert service.speech.to_dict() == before
    assert not preferences.path().exists()
    with pytest.raises(ValueError, match="retired"):
        provider.preload(retired)


def test_old_saved_engine_does_not_override_pocket_startup(pocket_only):
    preferences.path().write_text(json.dumps({"tts_provider": "kokoro", "tts_voice_fr": "ff_siwis"}))
    current = runtime.RuntimeConfig.from_settings()
    assert preferences.load(current)
    assert current.tts_provider == "voxcpm" and current.tts_voice_fr == ""


@pytest.mark.parametrize("path", ["/api/tts", "/api/tts/stream", "/v1/audio/speech"])
def test_old_voice_requests_migrate_to_one_engine_with_applied_headers(pocket_only, monkeypatch, path):
    calls = []
    def synthesize(text, selected, **kwargs):
        calls.append((selected, kwargs["voice"]))
        return np.ones(80, dtype=np.float32), 24000, 1
    async def stream(text, selected, **kwargs):
        yield synthesize(text, selected, **kwargs)
    monkeypatch.setattr(provider, "synthesize", synthesize)
    monkeypatch.setattr(provider, "stream", stream)
    response = TestClient(service.app).post(path, json={"text": "Bonjour.", "tts_provider": "kokoro",
                                                       "voice": "ff_siwis", "language": "fr"})
    assert response.status_code == 200
    assert response.headers["x-voix-provider"] == "voxcpm"
    assert response.headers["x-voix-voice"] == "helper"
    assert calls == [("voxcpm", "helper")]


def test_old_unmapped_voice_uses_active_default_and_unknown_provider_is_refused(pocket_only, monkeypatch):
    calls = []
    def synthesize(text, selected, **kwargs):
        calls.append((selected, kwargs["voice"]))
        return np.ones(80, dtype=np.float32), 24000, 1
    monkeypatch.setattr(provider, "synthesize", synthesize)
    client = TestClient(service.app)
    response = client.post("/api/tts", json={"text": "Bonjour.", "tts_provider": "windows_sapi",
                                             "voice": "Old Windows voice", "language": "fr"})
    assert response.status_code == 200 and calls == [("voxcpm", "narrator")]
    assert response.headers["x-voix-voice"] == "narrator"
    assert client.post("/api/tts", json={"text": "Bonjour.", "tts_provider": "invented"}).status_code == 400


def test_worker_failure_never_falls_back_to_a_retired_engine(pocket_only, monkeypatch):
    monkeypatch.setattr(catalog, "worker_ready", lambda: (False, "Pocket unavailable"))
    response = TestClient(service.app).post("/api/tts", json={"text": "Bonjour.", "tts_provider": "kokoro"})
    assert response.status_code == 503 and response.json()["error"] == "Pocket unavailable"


def test_a_ready_old_gpu_worker_is_not_accepted_as_pocket(pocket_only, monkeypatch):
    import httpx
    def health(url, **kwargs):
        return httpx.Response(200, json={"ready": True, "voice": "narrator", "model": "openbmb/VoxCPM2"},
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(catalog.httpx, "get", health)
    ready, reason = catalog._probe_worker()
    assert ready is False and "Pocket TTS worker" in reason
    assert catalog._worker_health[3] == {}


def test_pocket_profile_requires_its_worker_and_valid_aliases(pocket_only):
    pocket_only.validate()
    for invalid in (replace(pocket_only, voxcpm_base_url=""), replace(pocket_only, tts_provider="kokoro"),
                    replace(pocket_only, tts_voice_aliases=[]), replace(pocket_only, tts_voice_aliases={"bad|voice": "a"})):
        with pytest.raises(ValueError):
            invalid.validate()


def test_recognition_discovery_reports_a_cpu_fallback_without_loading_a_model(pocket_only, monkeypatch):
    from app.stt import whisper
    def cannot_load(*args, **kwargs):
        raise AssertionError("Discovery must not load a model")
    monkeypatch.setattr(whisper, "_prefer_cpu", True)
    monkeypatch.setattr(whisper, "_get_model", cannot_load)
    result = TestClient(service.app).get("/v1/models").json()["data"][0]
    assert result["device"] == "cpu" and result["compute_type"] == "int8"
    assert result["configured_device"] == pocket_only.whisper_device
