"""Installed local voices. Discovery never loads or downloads a model."""
from __future__ import annotations

import threading
import time
import subprocess
import zipfile

import httpx

from app.assets import get_kokoro_asset_paths
from app.config import settings
from app.tts import provider, windows_sapi

LOCALES = {"a": "en-US", "b": "en-GB", "f": "fr-FR", "e": "es-ES", "h": "hi-IN", "i": "it-IT", "j": "ja-JP", "p": "pt-BR", "z": "zh-CN"}
_worker_health = (0.0, False, "Not checked", {})
_worker_probe = threading.Lock()


def _beside_request(task) -> None:
    threading.Thread(target=task, daemon=True).start()


def _served_voices(data: dict) -> dict[str, str]:
    """Voice ids and labels a worker serves; single-reference workers report only ``voice``."""
    voices = {}
    for item in data.get("voices") or []:
        if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]:
            voices[item["id"]] = str(item.get("name") or item["id"])
    if not voices and isinstance(data.get("voice"), str) and data["voice"]:
        voices[data["voice"]] = data["voice"]
    return voices


def worker_ready() -> tuple[bool, str]:
    global _worker_health
    if not settings.voxcpm_base_url:
        return False, "VoxCPM2 worker is not configured"
    # Reuse a ready answer for 10 s; retry a failure after 2 s so recovery is noticed quickly.
    if time.monotonic() - _worker_health[0] < (10 if _worker_health[1] else 2):
        return _worker_health[1:3]
    # A worker already known to be down is probed beside the request: a stopped
    # worker can take the whole timeout to refuse, and speech must not wait for it
    # before taking another voice. The next request sees the recovery.
    if _worker_health[0] and not _worker_health[1]:
        if _worker_probe.acquire(blocking=False):
            def probe():
                try:
                    _probe_worker()
                finally:
                    _worker_probe.release()
            _beside_request(probe)
        return _worker_health[1:3]
    return _probe_worker()


def _probe_worker() -> tuple[bool, str]:
    global _worker_health
    voices = {}
    try:
        response = httpx.get(settings.voxcpm_base_url + "/health", timeout=2, trust_env=False)
        response.raise_for_status()
        voices = _served_voices(response.json())
        ready = bool(response.json().get("ready") and settings.voxcpm_voice in voices)
        reason = "" if ready else "VoxCPM2 is warming up or does not serve the configured voice"
    except (httpx.HTTPError, ValueError):
        ready, reason = False, "VoxCPM2 worker is unavailable"
    _worker_health = (time.monotonic(), ready, reason, voices if ready else {})
    return ready, reason


def worker_voices() -> dict[str, str]:
    """Voices of a ready worker (id -> label); empty when it is unavailable."""
    worker_ready()
    return dict(_worker_health[3])


def catalog() -> dict:
    model, path = get_kokoro_asset_paths()
    voices = []
    try:
        with zipfile.ZipFile(path) as archive:
            names = sorted(n.removesuffix(".npy") for n in archive.namelist() if n.endswith(".npy"))
    except (OSError, zipfile.BadZipFile):
        names = []
    kokoro_ready = model.is_file() and bool(names)
    for name in names:
        locale = LOCALES.get(name[:1], "")
        supported = locale.startswith(("en", "fr"))
        voices.append({"id": name, "provider": "kokoro", "name": name.split("_", 1)[-1].replace("_", " ").title(),
                       "locale": locale, "language": locale[:2], "gender": "male" if name[1:2] == "m" else "female",
                       "available": kokoro_ready and supported,
                       "reason": "" if supported else "This speech service currently supports French and English"})
    # Existing Nestor blend and the distinct local Jarvis timbre, both named.
    for voice_id, label in (("am_michael:0.50+ff_siwis:0.50", "Nestor · Michael / Siwis"),
                            ("bm_lewis:0.50+ff_siwis:0.50", "Jarvis · Lewis / Siwis")):
        if all(part.split(":")[0] in names for part in voice_id.split("+")):
            voices.append({"id": voice_id, "provider": "kokoro", "name": label, "locale": "fr-FR", "language": "fr",
                           "gender": "male", "kind": "blend", "available": kokoro_ready, "reason": ""})
    sapi_reason = ""
    try:
        sapi = windows_sapi.installed_voices()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        sapi, sapi_reason = [], "Windows speech catalog is unavailable"
    for voice in sapi:
        supported = voice["locale"][:2].lower() in ("fr", "en")
        voices.append({"id": voice["name"], "provider": "windows_sapi", "name": voice["name"],
                       "locale": voice["locale"], "language": voice["locale"][:2].lower(), "gender": voice.get("gender", ""),
                       "available": supported, "reason": "" if supported else "French and English only"})
    ready, reason = worker_ready()
    if settings.voxcpm_base_url:
        # A cloned voice speaks both languages. VOXCPM_VOICE_NAME labels the default voice
        # when its reference carries no name of its own.
        served = worker_voices() or {settings.voxcpm_voice: settings.voxcpm_voice}
        for voice_id, label in served.items():
            name = settings.voxcpm_voice_name if voice_id == settings.voxcpm_voice and label == voice_id else label
            for language in ("fr", "en"):
                voices.append({"id": voice_id, "provider": "voxcpm", "name": name, "locale": language,
                               "language": language, "available": ready, "reason": reason})
    return {"schema": 1, "streamProtocol": "voix-pcm-v1", "providers": [
        {"id": "kokoro", "name": "Kokoro", "available": kokoro_ready, "streaming": "clause", "reason": "" if kokoro_ready else "Kokoro assets are not installed"},
        {"id": "windows_sapi", "name": "Windows SAPI", "available": bool(sapi), "streaming": "clause", "reason": sapi_reason or ("" if sapi else "No Windows voices installed")},
        {"id": "voxcpm", "name": "VoxCPM2", "available": ready, "streaming": "frames", "reason": reason}],
        "voices": voices, "defaults": {"provider": settings.tts_provider, "kokoro": provider.language_profiles("kokoro"), "voxcpm": settings.voxcpm_voice}}
