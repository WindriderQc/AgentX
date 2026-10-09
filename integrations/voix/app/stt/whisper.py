"""faster-whisper STT, GPU-first, in-memory audio.

A caller uploads one complete utterance and receives its text (beam_size=5,
GPU float16). Falls back to CPU int8 once if the CUDA runtime is unavailable.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import BinaryIO

import numpy as np

from app.config import settings
from app.stt.vocabulary import normalize_transcript


_models: dict[tuple[str, str], object] = {}
_models_lock = threading.Lock()
_prefer_cpu = settings.whisper_device == "cpu"
_dll_directories: list[object] = []
# Monotonic time of the last completed model run, whoever asked for it.
_last_run_at: float | None = None
_warm_lock = threading.Lock()


def _configure_windows_cuda_runtime() -> None:
    if sys.platform != "win32":
        return
    bin_paths = [
        Path(sys.prefix) / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin",
        Path(sys.prefix) / "Lib" / "site-packages" / "nvidia" / "cuda_nvrtc" / "bin",
        Path(sys.prefix) / "Lib" / "site-packages" / "nvidia" / "cuda_runtime" / "bin",
    ]
    existing = [str(p) for p in bin_paths if p.exists()]
    if not existing:
        return
    path_parts = os.environ.get("PATH", "").split(os.pathsep)
    for entry in reversed(existing):
        if entry not in path_parts:
            os.environ["PATH"] = entry + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            _dll_directories.append(os.add_dll_directory(entry))


def _build_model(device: str, compute_type: str):
    try:
        _configure_windows_cuda_runtime()
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - depends on runtime packages
        raise RuntimeError("faster-whisper is not installed.") from exc
    return WhisperModel(settings.whisper_model, device=device, compute_type=compute_type)


def _get_model(device: str, compute_type: str):
    key = (device, compute_type)
    with _models_lock:
        if key not in _models:
            _models[key] = _build_model(device, compute_type)
        return _models[key]


def _is_cuda_runtime_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "cublas" in msg or "cuda" in msg or "cudnn" in msg


def _active_backend() -> tuple[str, str]:
    if _prefer_cpu:
        return "cpu", "int8"
    return settings.whisper_device, settings.whisper_compute_type


def backend_status() -> dict[str, str]:
    """Current recognition backend, including a CPU fallback; never loads a model."""
    device, compute = _active_backend()
    return {"device": device, "compute_type": compute}


def preload_model() -> dict[str, str]:
    device, compute = _active_backend()
    _get_model(device, compute)
    return {"device": device, "computeType": compute, "model": settings.whisper_model}


class Transcript(str):
    """Transcript text that also carries the language Whisper decoded.

    Callers that only need text keep treating it as a plain string; upload
    callers report the language so one reply keeps one voice.
    """

    language = ""


def _transcript(text: str, language: str | None) -> Transcript:
    value = Transcript(text)
    value.language = str(language or "")
    return value


def _run(model, audio: np.ndarray | str | BinaryIO, language: str, *, vad_filter: bool = False) -> Transcript:
    global _last_run_at
    bilingual = language == "fr-en"
    language = None if language == "auto" or bilingual else language
    initial_position = audio.tell() if hasattr(audio, "tell") else None
    options = dict(
        beam_size=5,
        language=language,
        task="transcribe",
        vad_filter=vad_filter,
        hotwords=settings.whisper_hotwords or None,
        initial_prompt=(settings.whisper_initial_prompt if language == "fr" else settings.whisper_hotwords) or None,
        condition_on_previous_text=False,
    )
    if vad_filter:
        # Require confident speech to start; retain weaker consonants once it
        # starts. Notification chimes must not become a language-model input.
        options["vad_parameters"] = dict(
            threshold=settings.whisper_vad_threshold,
            neg_threshold=min(0.35, max(settings.whisper_vad_threshold - 0.15, 0.01)),
            min_speech_duration_ms=100,
            min_silence_duration_ms=200,
            speech_pad_ms=400,
        )
    segments, info = model.transcribe(audio, **options)
    if vad_filter and getattr(info, "duration_after_vad", None) == 0:
        return _transcript("", None)
    if bilingual and info.language not in {"fr", "en"}:
        # faster-whisper detects language eagerly but decodes segments lazily.
        # Choose between the two languages advertised by the caller before any
        # foreign-language segments are generated. Ordinary auto stays multilingual.
        candidates = [(lang, probability) for lang, probability in (info.all_language_probs or [])
                      if lang in {"fr", "en"}]
        if not candidates:
            raise RuntimeError("French/English speech detection is unavailable.")
        selected = max(candidates, key=lambda item: item[1])[0]
        options.update(language=selected, initial_prompt=(
            settings.whisper_initial_prompt if selected == "fr" else settings.whisper_hotwords
        ) or None)
        if initial_position is not None:
            audio.seek(initial_position)
        segments, info = model.transcribe(audio, **options)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    _last_run_at = time.monotonic()
    return _transcript(normalize_transcript(text), getattr(info, "language", ""))


def transcribe(audio: np.ndarray, *, language: str | None = None) -> tuple[str, float]:
    """Transcribe a float32 mono array @ 16 kHz. Returns (text, elapsed_ms)."""
    global _prefer_cpu
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    lang = language or settings.voix_language
    device, compute = _active_backend()
    started = time.perf_counter()
    try:
        text = _run(_get_model(device, compute), audio, lang)
    except Exception as exc:
        if device != "cpu" and _is_cuda_runtime_error(exc):
            _prefer_cpu = True
            with _models_lock:
                _models.pop((device, compute), None)
            print("[stt] GPU path unavailable, switching to CPU int8.")
            text = _run(_get_model("cpu", "int8"), audio, lang)
        else:
            raise
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return text, elapsed_ms


def warm(*, max_age_s: float = 20.0) -> float | None:
    """Run the model once ahead of an utterance the caller knows is coming.

    The first recognition after an idle period is slower than one that follows
    a recent run. One second of silence goes through `transcribe`, without the
    speech filter that would skip the model, and its text is discarded.
    Returns the elapsed milliseconds, or None when nothing ran: the model ran
    less than `max_age_s` ago, another warm call is in progress, or the model
    failed. A failure is left for the real request to report.
    """
    if not _warm_lock.acquire(blocking=False):
        return None
    try:
        if _last_run_at is not None and time.monotonic() - _last_run_at < max_age_s:
            return None
        try:
            _, elapsed_ms = transcribe(np.zeros(16000, dtype=np.float32), language="fr")
        except Exception:
            return None
        return elapsed_ms
    finally:
        _warm_lock.release()


def transcribe_path(path: str | Path | BinaryIO, *, language: str | None = None) -> tuple[str, float]:
    """Transcribe a path or seekable memory stream (decoded through PyAV).
    Uploaded audio has not passed any speech detection. Use faster-whisper's
    bundled VAD so silence/noise returns empty text instead of invented
    subtitle credits.
    """
    global _prefer_cpu
    import time as _time
    lang = language or settings.voix_language
    device, compute = _active_backend()
    started = _time.perf_counter()
    audio = path if hasattr(path, "read") else str(path)
    initial_position = audio.tell() if hasattr(audio, "tell") else None
    try:
        text = _run(_get_model(device, compute), audio, lang, vad_filter=True)
    except Exception as exc:
        if device != "cpu" and _is_cuda_runtime_error(exc):
            _prefer_cpu = True
            with _models_lock:
                _models.pop((device, compute), None)
            print("[stt] GPU path unavailable, switching to CPU int8.")
            if initial_position is not None:
                audio.seek(initial_position)
            text = _run(_get_model("cpu", "int8"), audio, lang, vad_filter=True)
        else:
            raise
    elapsed_ms = (_time.perf_counter() - started) * 1000.0
    return text, elapsed_ms
