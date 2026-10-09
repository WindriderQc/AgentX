"""Selected TTS provider facade.

Kokoro is the default engine. Windows SAPI is the low-latency engine of a
Windows host, and VoxCPM2 an optional cloned voice served by a separate worker.
"""
from __future__ import annotations

import asyncio
from contextlib import aclosing
import threading

import numpy as np

from app.config import settings
from app.tts.text import sanitize_for_speech


_synthesis_locks = {name: threading.RLock() for name in ("kokoro", "windows_sapi")}

_LANGUAGE_ALIASES = {
    "en": "en-us",
    "en-ca": "en-us",
    "en-us": "en-us",
    "en-gb": "en-gb",
    "fr": "fr-fr",
    "fr-ca": "fr-fr",
    "fr-fr": "fr-fr",
}
_DEFAULT_KOKORO_VOICES = {
    "en-us": "af_heart",
    "en-gb": "bf_emma",
    "fr-fr": "ff_siwis",
}


class VoiceUnavailable(RuntimeError):
    """The selected engine cannot speak now; any fallback voice is the caller's choice."""


def _selected(provider: str | None = None) -> str:
    value = (provider or settings.tts_provider).strip().lower().replace("-", "_")
    if value not in {"kokoro", "windows_sapi", "voxcpm"}:
        raise ValueError("tts_provider must be one of: kokoro, windows_sapi, voxcpm")
    if settings.tts_pocket_only and value != settings.tts_provider:
        raise ValueError("This synthesis provider is retired on this instance")
    return value


def provider_name(provider: str | None = None) -> str:
    return _selected(provider)


def output_rate(provider: str | None = None) -> int:
    return 48000 if _selected(provider) == "voxcpm" else settings.tts_output_rate


def preload(provider: str | None = None) -> None:
    if _selected(provider) == "voxcpm":
        from app.tts import voxcpm

        voxcpm.preload()
        return
    if _selected(provider) == "windows_sapi":
        from app.tts import windows_sapi

        windows_sapi.preload()
        return

    from app.tts import kokoro

    kokoro.preload()


def normalize_language(language: str | None) -> str:
    value = str(language or "").strip().lower().replace("_", "-")
    if not value:
        return ""
    normalized = _LANGUAGE_ALIASES.get(value)
    if not normalized:
        raise ValueError("language must be one of: en, en-CA, en-US, en-GB, fr, fr-CA, fr-FR")
    return normalized


def _voice_language(voice: str) -> str:
    normalized = str(voice or "").strip().lower()
    if normalized.startswith(("af_", "am_")):
        return "en-us"
    if normalized.startswith(("bf_", "bm_")):
        return "en-gb"
    if normalized.startswith(("ff_", "fm_")):
        return "fr-fr"
    return ""


def kokoro_profile(language: str | None = None, voice: str | None = None) -> dict:
    requested_language = normalize_language(language)
    selected_language = requested_language or normalize_language(settings.kokoro_language)
    selected_voice = str(voice or "").strip()
    if not selected_voice:
        configured_language = normalize_language(settings.kokoro_language)
        selected_voice = (
            settings.kokoro_voice
            if selected_language == configured_language
            else _DEFAULT_KOKORO_VOICES[selected_language]
        )
    return {"language": selected_language, "voice": selected_voice}


def request_overrides(
    provider: str | None = None,
    *,
    language: str | None = None,
    voice: str | None = None,
) -> dict:
    if not str(language or "").strip() and not str(voice or "").strip():
        return {}
    selected = _selected(provider)
    if selected == "voxcpm":
        selected_voice = str(voice or settings.voxcpm_voice).strip()
        if selected_voice != settings.voxcpm_voice:
            from app.tts import catalog  # catalog imports this module
            if selected_voice not in catalog.worker_voices():
                raise ValueError("The requested VoxCPM2 reference is not configured")
        return {"language": normalize_language(language), "voice": selected_voice}
    if selected == "windows_sapi":
        from app.tts import windows_sapi
        return {"language": normalize_language(language), "voice": windows_sapi.resolve_voice(voice, language)}
    return kokoro_profile(language, voice)


def resolve(provider=None, *, language=None, voice=None) -> dict:
    """The effective engine, language and voice of one speech request."""
    selected = _selected(provider)
    if selected == "kokoro":
        profile = kokoro_profile(language, voice)
    elif selected == "windows_sapi":
        from app.tts import windows_sapi
        profile = {"language": normalize_language(language), "voice": windows_sapi.resolve_voice(voice, language)}
    else:
        from app.tts import catalog  # catalog imports this module
        # Every VoxCPM2 voice, the configured one included, needs a ready worker
        # before audio starts; the service never substitutes another voice.
        ready, reason = catalog.worker_ready()
        if not ready:
            raise VoiceUnavailable(reason)
        profile = request_overrides(selected, language=language or settings.voix_language, voice=voice)
    return {"provider": selected, **profile, "sample_rate": output_rate(selected)}


def language_profiles(provider: str | None = None) -> list[dict]:
    if _selected(provider) == "voxcpm":
        return [{"language": language, "locale": locale, "voice": settings.voxcpm_voice}
                for language, locale in (("en", "en-us"), ("fr", "fr-fr"))]
    if _selected(provider) != "kokoro":
        return []
    profiles = []
    for language in ("en", "fr"):
        resolved = kokoro_profile(language)
        profiles.append({
            "language": language,
            "locale": resolved["language"],
            "voice": resolved["voice"],
        })
    return profiles


def synthesize(
    text: str,
    provider: str | None = None,
    *,
    language: str | None = None,
    voice: str | None = None,
) -> tuple[np.ndarray, int, float]:
    selected = _selected(provider)
    text = sanitize_for_speech(text)
    if not text:
        # Formatting-only browser clauses still complete the audio transport.
        return np.zeros(1, dtype=np.float32), output_rate(selected), 0.0
    if selected == "voxcpm":
        from app.tts import voxcpm

        return voxcpm.synthesize(text, language=language, voice=voice)
    with _synthesis_locks[_selected(provider)]:
        if selected == "windows_sapi":
            from app.tts import windows_sapi
            return windows_sapi.synthesize(text, voice=voice, language=language)

        from app.tts import kokoro

        selected_profile = kokoro_profile(language, voice)
        return kokoro.synthesize(
            text,
            language=selected_profile["language"],
            voice=selected_profile["voice"],
        )


async def stream(text: str, provider: str | None = None, *, cancel=None, **overrides):
    text = sanitize_for_speech(text)
    if cancel is not None and cancel.is_set():
        return
    if not text:
        yield synthesize(text, provider, **overrides)
        return
    if _selected(provider) == "voxcpm":
        from app.tts import voxcpm

        async with aclosing(voxcpm.stream(text, cancel=cancel, **overrides)) as chunks:
            async for chunk in chunks:
                yield chunk
        return
    if cancel is None or not cancel.is_set():
        def render_if_current():
            with _synthesis_locks[_selected(provider)]:
                if cancel is not None and cancel.is_set():
                    raise asyncio.CancelledError()
                return synthesize(text, provider, **overrides)
        result = await asyncio.to_thread(render_if_current)
        if cancel is None or not cancel.is_set():
            yield result
