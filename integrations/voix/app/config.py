"""Speech service settings, read once from the environment (and a local .env)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


# Only this service's own file: never the .env of the repository around it.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

TTS_PROVIDERS = ("kokoro", "windows_sapi", "voxcpm")


def _get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _get_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return int(value)


def _get_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return float(value)


@dataclass(frozen=True)
class Settings:
    # Default language of a request that names none (recognition warm-up, VoxCPM2).
    voix_language: str
    voix_startup_warmup: bool
    # Recognition (faster-whisper).
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    whisper_vad_threshold: float
    whisper_hotwords: str
    whisper_initial_prompt: str
    # Instance-provided transcript corrections (a JSON file outside the repository).
    stt_corrections_path: str
    # Synthesis.
    tts_provider: str
    tts_output_rate: int
    kokoro_voice: str
    kokoro_language: str
    kokoro_onnx_provider: str
    kokoro_pad_ms: int
    kokoro_model_path: str
    kokoro_voices_path: str
    windows_sapi_voice: str
    windows_sapi_rate: int
    voxcpm_base_url: str = ""
    voxcpm_voice: str = "nestor-a"
    voxcpm_voice_name: str = "Voice A · VoxCPM2"
    voxcpm_timeout_seconds: float = 60.0

    def validate(self) -> None:
        if not 0 < self.whisper_vad_threshold < 1:
            raise ValueError("WHISPER_VAD_THRESHOLD must be between 0 and 1")
        if self.tts_provider not in TTS_PROVIDERS:
            raise ValueError(f"TTS_PROVIDER must be one of {sorted(TTS_PROVIDERS)}")
        if self.tts_output_rate <= 0:
            raise ValueError("TTS_OUTPUT_RATE must be positive")
        if self.voxcpm_timeout_seconds <= 0:
            raise ValueError("VOXCPM_TIMEOUT_SECONDS must be positive")


def load_settings() -> Settings:
    settings = Settings(
        voix_language=os.getenv("VOIX_LANGUAGE", "fr"),
        voix_startup_warmup=_get_bool("VOIX_STARTUP_WARMUP", True),
        whisper_model=os.getenv("WHISPER_MODEL", "large-v3-turbo"),
        whisper_device=os.getenv("WHISPER_DEVICE", "cuda"),
        whisper_compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "float16"),
        whisper_vad_threshold=_get_float("WHISPER_VAD_THRESHOLD", 0.85),
        # Product names only. An instance adds its own names (people, places)
        # through its external environment, never in this repository.
        whisper_hotwords=os.getenv("WHISPER_HOTWORDS", "Nestor, AgentX, OpenClaw, VoiX").strip(),
        whisper_initial_prompt=os.getenv(
            "WHISPER_INITIAL_PROMPT",
            "Conversation en français québécois avec Nestor. "
            "Noms propres : Nestor, AgentX, OpenClaw et VoiX.",
        ).strip(),
        stt_corrections_path=os.getenv("VOIX_STT_CORRECTIONS_PATH", "").strip(),
        tts_provider=os.getenv("TTS_PROVIDER", "kokoro").strip().lower().replace("-", "_"),
        tts_output_rate=_get_int("TTS_OUTPUT_RATE", 24000),
        kokoro_voice=os.getenv("KOKORO_VOICE", "af_sarah"),
        kokoro_language=os.getenv("KOKORO_LANGUAGE", "fr-fr"),
        kokoro_onnx_provider=os.getenv("ONNX_PROVIDER", "CPUExecutionProvider"),
        kokoro_pad_ms=_get_int("KOKORO_PAD_MS", 60),
        kokoro_model_path=os.getenv("KOKORO_MODEL_PATH", ""),
        kokoro_voices_path=os.getenv("KOKORO_VOICES_PATH", ""),
        windows_sapi_voice=os.getenv("WINDOWS_SAPI_VOICE", ""),
        windows_sapi_rate=_get_int("WINDOWS_SAPI_RATE", 0),
        voxcpm_base_url=os.getenv("VOXCPM_BASE_URL", "").strip().rstrip("/"),
        voxcpm_voice=os.getenv("VOXCPM_VOICE", "nestor-a").strip(),
        voxcpm_voice_name=os.getenv("VOXCPM_VOICE_NAME", "").strip() or "Voice A · VoxCPM2",
        voxcpm_timeout_seconds=_get_float("VOXCPM_TIMEOUT_SECONDS", 60.0),
    )
    settings.validate()
    return settings


settings = load_settings()
