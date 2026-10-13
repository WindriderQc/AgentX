"""Language capability is explicit evidence; these tests never load a model."""
from dataclasses import replace

import httpx
import pytest

from app.tts import catalog, provider
from app.tts.cloned_voice_worker import Worker


@pytest.mark.parametrize("reported, expected", [
    (["fr"], ("fr",)), (["en"], ("en",)), (["fr", "en", "fr"], ("fr", "en")),
    (None, ()), ("fr", ()), ([{}, "xx", None, 7, "en"], ("en",)),
])
def test_loaded_worker_declares_only_observed_languages(monkeypatch, reported, expected):
    settings = replace(catalog.settings, voxcpm_base_url="http://worker", voxcpm_voice="narrator")
    monkeypatch.setattr(catalog, "settings", settings)
    monkeypatch.setattr(catalog, "_worker_health", (0, False, "Not checked", {}))
    monkeypatch.setattr(catalog, "_worker_languages", ())
    data = {"ready": True, "model": "kyutai/pocket-tts", "voice": "narrator", "languages": reported}
    monkeypatch.setattr(catalog.httpx, "get", lambda url, **_kwargs:
                        httpx.Response(200, json=data, request=httpx.Request("GET", url)))
    assert catalog.worker_ready() == (True, "")
    assert catalog.worker_languages() == expected


def test_french_pocket_is_not_advertised_or_used_for_english(monkeypatch):
    settings = replace(catalog.settings, tts_pocket_only=True, tts_provider="voxcpm", voxcpm_voice="narrator")
    monkeypatch.setattr(catalog, "settings", settings)
    monkeypatch.setattr(provider, "settings", settings)
    monkeypatch.setattr(catalog, "worker_ready", lambda: (True, ""))
    monkeypatch.setattr(catalog, "worker_voices", lambda: {"narrator": "Narrator"})
    monkeypatch.setattr(catalog, "worker_languages", lambda: ("fr",))
    assert {row["language"] for row in catalog.catalog()["voices"]} == {"fr"}
    assert [row["language"] for row in provider.language_profiles("voxcpm")] == ["fr"]
    assert provider.resolve("voxcpm", language="fr-CA")["language"] == "fr-fr"
    with pytest.raises(provider.VoiceUnavailable, match="requested language"):
        provider.resolve("voxcpm", language="en")


def test_worker_refuses_an_unsupported_language_before_accepting_the_job():
    worker = Worker(lambda *_args: (), "narrator", languages=("fr",))
    request = {"id": "request", "text": "Hello", "voice": "narrator", "language": "en"}
    with pytest.raises(ValueError, match="language"):
        worker.submit(request)
    assert not worker.active and worker.pending.empty()
    job = worker.submit({**request, "language": "fr-CA"})
    assert job.language == "fr"


def test_missing_worker_language_evidence_is_unavailable_for_synthesis(monkeypatch):
    monkeypatch.setattr(catalog, "worker_ready", lambda: (True, ""))
    monkeypatch.setattr(catalog, "worker_languages", lambda: ())
    with pytest.raises(provider.VoiceUnavailable, match="requested language"):
        provider.resolve("voxcpm", language="fr")
