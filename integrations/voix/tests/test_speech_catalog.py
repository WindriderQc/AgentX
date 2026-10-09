import asyncio
import json
import zipfile

import numpy as np
import pytest

from app.runtime import RuntimeConfig
from app.tts import catalog, preferences, provider, transport, windows_sapi


def test_windows_speech_does_not_wait_for_kokoro_gpu_work(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    monkeypatch.setattr(windows_sapi, "synthesize", lambda *args, **kwargs: (np.ones(1), 24000, 1))
    with ThreadPoolExecutor(max_workers=1) as pool:
        with provider._synthesis_locks["kokoro"]:
            result = pool.submit(provider.synthesize, "fixture", "windows_sapi").result(timeout=1)
        assert result[1] == 24000


def test_catalog_lists_installed_voices_without_loading_models(tmp_path, monkeypatch):
    model = tmp_path / "model.onnx"
    model.touch()
    voices = tmp_path / "voices.bin"
    with zipfile.ZipFile(voices, "w") as file:
        for name in ("ff_siwis", "am_michael", "bm_lewis", "jf_alpha"):
            file.writestr(name + ".npy", b"catalog-only")
    monkeypatch.setattr(catalog, "get_kokoro_asset_paths", lambda: (model, voices))
    monkeypatch.setattr(windows_sapi, "installed_voices", lambda: [{"name": "Microsoft Claude", "locale": "fr-CA"}])
    monkeypatch.setattr(catalog, "worker_ready", lambda: (False, "Not configured"))
    result = catalog.catalog()
    rows = {v["id"]: v for v in result["voices"]}
    assert rows["bm_lewis"]["locale"] == "en-GB"
    assert rows["Microsoft Claude"]["available"] is True
    assert rows["jf_alpha"]["available"] is False
    assert rows["bm_lewis:0.50+ff_siwis:0.50"]["kind"] == "blend"


def test_sapi_resolves_request_voice_and_language_without_global_changes(monkeypatch):
    monkeypatch.setattr(windows_sapi, "installed_voices", lambda: [
        {"name": "English", "locale": "en-US"}, {"name": "Claude", "locale": "fr-CA"}])
    before = windows_sapi.settings.windows_sapi_voice
    assert windows_sapi.resolve_voice(None, "fr") == "Claude"
    assert windows_sapi.resolve_voice("english", "en") == "English"
    with pytest.raises(ValueError, match="not installed"):
        windows_sapi.resolve_voice("missing", "fr")
    assert windows_sapi.settings.windows_sapi_voice == before


def test_only_speech_preferences_survive_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("VOIX_PREFERENCES_PATH", str(tmp_path / "preferences.json"))
    config = RuntimeConfig.from_settings()
    config.update({"tts_provider": "windows_sapi", "tts_voice_fr": "Microsoft Claude", "language": "en"})
    preferences.save(config)
    saved = json.loads(preferences.path().read_text())
    assert set(saved) == set(preferences.FIELDS)
    restored = RuntimeConfig.from_settings()
    original_language = restored.language
    assert preferences.load(restored) == ""
    assert restored.tts_voice_fr == "Microsoft Claude"
    assert restored.language == original_language
    restored.update({"tts_provider": "kokoro"})
    assert restored.tts_voice_fr == ""


def test_stream_counts_and_metadata_match_received_pcm(monkeypatch):
    async def chunks(*args, **kwargs):
        yield np.ones(6000, dtype=np.float32), 24000, 2
        yield np.ones(100, dtype=np.float32), 24000, 3
    monkeypatch.setattr(provider, "stream", chunks)
    async def run():
        return [json.loads(line) async for line in transport.pcm_events("fixture", {"provider": "kokoro", "voice": "ff_siwis", "language": "fr"})]
    rows = asyncio.run(run())
    assert rows[0]["protocol"] == "voix-pcm-v1"
    assert rows[-1]["type"] == "done"
    assert rows[-1]["samples"] == 6100
    assert [r["sequence"] for r in rows if r["type"] == "audio"] == [1, 2, 3]


def test_closing_stream_cancels_provider(monkeypatch):
    tokens = []
    async def chunks(*args, cancel, **kwargs):
        tokens.append(cancel)
        yield np.ones(40, dtype=np.float32), 48000, 2
    monkeypatch.setattr(provider, "stream", chunks)
    async def run():
        stream = transport.pcm_events("fixture", {"provider": "voxcpm", "voice": "nestor-a", "language": "fr"})
        await anext(stream)
        await stream.aclose()
    asyncio.run(run())
    assert tokens[0].is_set()


def test_buffered_engine_synthesizes_sentences_without_fragmenting_voxcpm(monkeypatch):
    calls = []
    async def chunks(text, *args, **kwargs):
        calls.append(text)
        yield np.ones(40, dtype=np.float32), 24000, 2
    monkeypatch.setattr(provider, "stream", chunks)
    async def run(engine):
        return [line async for line in transport.pcm_events("Bonjour. Voici la suite.", {"provider": engine, "voice": "fixture", "language": "fr"})]
    asyncio.run(run("kokoro"))
    assert calls == ["Bonjour.", "Voici la suite."]
    calls.clear()
    asyncio.run(run("voxcpm"))
    assert calls == ["Bonjour. Voici la suite."]


def test_cloned_voice_shows_its_configured_name(monkeypatch):
    from dataclasses import replace
    monkeypatch.setattr(catalog, "settings", replace(catalog.settings, voxcpm_base_url="http://127.0.0.1:8092",
                                                     voxcpm_voice="owner", voxcpm_voice_name="Owner (clone)"))
    monkeypatch.setattr(catalog, "worker_ready", lambda: (True, ""))
    monkeypatch.setattr(windows_sapi, "installed_voices", lambda: [])
    rows = [v for v in catalog.catalog()["voices"] if v["provider"] == "voxcpm"]
    assert {(v["id"], v["name"], v["language"]) for v in rows} == {("owner", "Owner (clone)", "fr"), ("owner", "Owner (clone)", "en")}


def test_catalog_lists_every_voice_a_ready_worker_serves_and_accepts_them(monkeypatch):
    from dataclasses import replace
    monkeypatch.setattr(catalog, "settings", replace(catalog.settings, voxcpm_base_url="http://127.0.0.1:8092",
                                                     voxcpm_voice="narrator", voxcpm_voice_name="Narrator (default)"))
    monkeypatch.setattr(provider, "settings", catalog.settings)
    monkeypatch.setattr(catalog, "worker_ready", lambda: (True, ""))
    monkeypatch.setattr(catalog, "worker_voices", lambda: {"narrator": "narrator", "helper": "Helper"})
    monkeypatch.setattr(windows_sapi, "installed_voices", lambda: [])
    rows = {(v["id"], v["language"]): v["name"] for v in catalog.catalog()["voices"] if v["provider"] == "voxcpm"}
    assert rows == {("narrator", "fr"): "Narrator (default)", ("narrator", "en"): "Narrator (default)",
                    ("helper", "fr"): "Helper", ("helper", "en"): "Helper"}
    assert provider.request_overrides("voxcpm", voice="helper")["voice"] == "helper"
    with pytest.raises(ValueError):
        provider.request_overrides("voxcpm", voice="unknown")


def test_worker_health_with_voices_and_legacy_single_voice():
    assert catalog._served_voices({"voice": "a", "voices": [{"id": "a", "name": "A"}, {"id": "b"}]}) == {"a": "A", "b": "b"}
    assert catalog._served_voices({"voice": "legacy"}) == {"legacy": "legacy"}


def test_worker_health_reuses_success_for_ten_seconds_and_failure_for_two(monkeypatch):
    from dataclasses import replace
    from types import SimpleNamespace
    import httpx
    url = "http://127.0.0.1:8092"
    monkeypatch.setattr(catalog, "settings", replace(catalog.settings, voxcpm_base_url=url, voxcpm_voice="narrator"))
    monkeypatch.setattr(catalog, "_worker_health", (0.0, False, "Not checked", {}))
    clock, probes, worker = [1000.0], [], {"up": False}
    monkeypatch.setattr(catalog, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    def health(address, **kwargs):
        probes.append(address)
        if not worker["up"]:
            raise httpx.ConnectError("refused")
        return httpx.Response(200, json={"ready": True, "voice": "narrator"}, request=httpx.Request("GET", address))
    monkeypatch.setattr(catalog.httpx, "get", health)

    assert catalog.worker_ready() == (False, "VoxCPM2 worker is unavailable")
    worker["up"] = True
    clock[0] += 1.9
    assert catalog.worker_ready()[0] is False and len(probes) == 1, "a failure is reused briefly"
    clock[0] += 0.2
    beside = []
    monkeypatch.setattr(catalog, "_beside_request", beside.append)
    assert catalog.worker_ready()[0] is False and len(probes) == 1, "a known failure never waits for its probe"
    assert catalog.worker_ready()[0] is False and len(beside) == 1, "one probe at a time"
    beside.pop()()
    assert catalog.worker_ready() == (True, "") and len(probes) == 2, "recovery is noticed after 2 s"
    worker["up"] = False
    clock[0] += 9.9
    assert catalog.worker_ready() == (True, "") and len(probes) == 2, "success is reused for 10 s"
    clock[0] += 0.2
    assert catalog.worker_ready()[0] is False and len(probes) == 3, "a worker that was ready is probed by the request"
    assert beside == []
    assert probes == [url + "/health"] * 3
