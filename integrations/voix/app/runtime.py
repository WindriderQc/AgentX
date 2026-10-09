"""Speech choices a caller may change without a restart.

Model-level settings (the Whisper model and device, the concrete voice files)
come from the environment and need a restart. The synthesis engine, the default
language and the per-language voices are live-editable through POST /config.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace

from app.config import TTS_PROVIDERS, settings
from app.tts import provider as tts

EDITABLE = ("language", "tts_provider", "tts_voice_en", "tts_voice_fr")


@dataclass
class RuntimeConfig:
    language: str
    tts_provider: str
    tts_voice_en: str = ""
    tts_voice_fr: str = ""

    @classmethod
    def from_settings(cls) -> "RuntimeConfig":
        return cls(language=settings.voix_language, tts_provider=settings.tts_provider)

    def to_dict(self) -> dict:
        return asdict(self)

    def update(self, data: dict) -> list[str]:
        """Validate all edits, then apply them as one atomic update."""
        candidate = replace(self)
        data = dict(data)
        if "tts_provider" in data and self._coerce("tts_provider", data["tts_provider"]) != self.tts_provider:
            # A voice belongs to its engine: changing engine clears the saved voices.
            data.setdefault("tts_voice_en", "")
            data.setdefault("tts_voice_fr", "")
        changed: list[str] = []
        for key in EDITABLE:
            if key not in data:
                continue
            value = self._coerce(key, data[key])
            if getattr(candidate, key) != value:
                setattr(candidate, key, value)
                changed.append(key)
        for key in changed:
            setattr(self, key, getattr(candidate, key))
        return changed

    def snapshot(self) -> "RuntimeConfig":
        return replace(self)

    @staticmethod
    def _coerce(key: str, value):
        if key == "tts_provider":
            provider = str(value).strip().lower().replace("-", "_")
            if provider not in TTS_PROVIDERS:
                raise ValueError("tts_provider must be one of: kokoro, windows_sapi, voxcpm")
            if settings.tts_pocket_only and provider != settings.tts_provider:
                raise ValueError("This instance uses one synthesis provider; other engines are retired")
            if provider == "voxcpm" and not settings.voxcpm_base_url:
                raise ValueError("Configure VOXCPM_BASE_URL before selecting VoxCPM2")
            return provider
        if key in ("tts_voice_en", "tts_voice_fr"):
            voice = str(value or "").strip()
            if len(voice) > 120 or any(ord(c) < 32 for c in voice):
                raise ValueError("Voice names must be at most 120 printable characters")
            return voice
        return str(value)


def static_settings() -> dict:
    """Read-only, restart-required settings a caller may show for context."""
    return {
        "whisper_model": settings.whisper_model,
        "whisper_device": settings.whisper_device,
        "whisper_compute_type": settings.whisper_compute_type,
        "whisper_vad_threshold": settings.whisper_vad_threshold,
        "whisper_hotwords": settings.whisper_hotwords,
        "whisper_initial_prompt": settings.whisper_initial_prompt,
        "tts_provider_default": settings.tts_provider,
        "tts_pocket_only": settings.tts_pocket_only,
        "kokoro_voice": settings.kokoro_voice,
        "kokoro_language": settings.kokoro_language,
        "kokoro_onnx_provider": settings.kokoro_onnx_provider,
        "tts_language_profiles": tts.language_profiles(settings.tts_provider),
        "windows_sapi_voice": settings.windows_sapi_voice,
        "voxcpm_voice": settings.voxcpm_voice,
        "voxcpm_configured": bool(settings.voxcpm_base_url),
        "tts_output_rate": settings.tts_output_rate,
    }
