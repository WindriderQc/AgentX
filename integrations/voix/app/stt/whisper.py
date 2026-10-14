"""faster-whisper STT, GPU-first, in-memory audio.

A caller uploads one complete utterance and receives its text (beam_size=5,
GPU float16). CUDA failures use CPU int8 with bounded, request-driven GPU recovery.
"""
from __future__ import annotations

import logging
import math
import os
import sys
import threading
import time
from pathlib import Path
from typing import BinaryIO

import numpy as np

from app.config import settings
from app.stt.diagnostics import recognition_evidence
from app.stt.requests import check_cancelled, inference_slot
from app.stt.vocabulary import normalize_transcript


_models: dict[tuple[str, str], object] = {}
_models_lock = threading.Lock()
_prefer_cpu = settings.whisper_device == "cpu"
_inference_lock = threading.RLock()
_state_lock = threading.Lock()
_retry_at = 0.0
_gpu_failures = 0
_failure_reason: str | None = None
_retrying = False
_RETRY_SECONDS = 30
_MAX_RETRY_SECONDS = 300
_LOG = logging.getLogger("voix.stt")
_LOG.setLevel(logging.INFO)
if not _LOG.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    _LOG.addHandler(_handler)
    _LOG.propagate = False
_dll_directories: list[object] = []
# Monotonic time of the last completed model run, whoever asked for it.
_last_run_at: float | None = None


class RecognitionUnavailable(RuntimeError):
    """The configured GPU is unavailable and this instance forbids CPU decode."""


def _require_backend(device: str) -> None:
    if device == "cpu" and settings.whisper_device != "cpu" and not settings.whisper_cpu_fallback:
        raise RecognitionUnavailable("GPU speech recognition is temporarily unavailable.")


def _configure_windows_cuda_runtime() -> None:
    if sys.platform != "win32":
        return
    bin_paths = [
        Path(sys.prefix) / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin",
        Path(sys.prefix) / "Lib" / "site-packages" / "nvidia" / "cudnn" / "bin",
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
    with _state_lock:
        if _prefer_cpu:
            return "cpu", "int8"
        return settings.whisper_device, settings.whisper_compute_type


def backend_status() -> dict:
    """Recognition routing state, not model readiness; never loads a model.

    A disabled CPU fallback can leave a prospective CPU device in the legacy
    field during GPU backoff. ``available`` distinguishes that refused route.
    """
    with _state_lock:
        degraded = _prefer_cpu and settings.whisper_device != "cpu"
        return {
            "device": "cpu" if _prefer_cpu else settings.whisper_device,
            "compute_type": "int8" if _prefer_cpu else settings.whisper_compute_type,
            "available": not degraded or settings.whisper_cpu_fallback,
            "degraded": degraded,
            "retry_after_seconds": math.ceil(max(0, _retry_at - time.monotonic())) if degraded else 0,
            "retrying": _retrying,
            "consecutive_gpu_failures": _gpu_failures,
            "failure_reason": _failure_reason,
            "cpu_fallback_enabled": settings.whisper_cpu_fallback,
        }


def _next_backend() -> tuple[str, str]:
    device, compute = _active_backend()
    with _state_lock:
        if _prefer_cpu and settings.whisper_device != "cpu" and time.monotonic() >= _retry_at:
            return settings.whisper_device, settings.whisper_compute_type
    return device, compute


def _gpu_failed(device: str, compute: str, exc: Exception) -> None:
    global _prefer_cpu, _retry_at, _gpu_failures, _failure_reason
    # Keep transcripts, upload paths and arbitrary exception payloads out of logs.
    message = str(exc).lower()
    reason = "out_of_memory" if "out of memory" in message else "cuda_runtime_error"
    with _state_lock:
        _prefer_cpu = True
        _gpu_failures += 1
        delay = min(_MAX_RETRY_SECONDS, _RETRY_SECONDS * 2 ** min(_gpu_failures - 1, 4))
        _retry_at = time.monotonic() + delay
        _failure_reason = reason
    with _models_lock:
        _models.pop((device, compute), None)
    _LOG.warning("Recognition %s after %s; GPU retry eligible in %s seconds",
                 "using CPU" if settings.whisper_cpu_fallback else "unavailable",
                 reason, delay)


def _gpu_recovered(device: str) -> None:
    global _prefer_cpu, _retry_at, _gpu_failures, _failure_reason
    if device == "cpu":
        return
    with _state_lock:
        recovered = _prefer_cpu
        _prefer_cpu, _retry_at, _gpu_failures, _failure_reason = False, 0.0, 0, None
    if recovered:
        with _models_lock:
            _models.pop(("cpu", "int8"), None)
        _LOG.info("Recognition recovered on configured GPU")


def preload_model() -> dict[str, str]:
    with _inference_lock:
        device, compute = _next_backend()
        _require_backend(device)
        try:
            _get_model(device, compute)
        except Exception as exc:
            if device == "cpu" or not _is_cuda_runtime_error(exc):
                raise
            _gpu_failed(device, compute, exc)
            if not settings.whisper_cpu_fallback:
                raise RecognitionUnavailable("GPU speech recognition is temporarily unavailable.") from exc
            device, compute = "cpu", "int8"
            _get_model(device, compute)
        # Loading alone does not prove decoding recovered; only a successful run does.
        return {"device": device, "computeType": compute, "model": settings.whisper_model}


class Transcript(str):
    """Transcript text that also carries the language Whisper decoded.

    Callers that only need text keep treating it as a plain string; upload
    callers report the language so one reply keeps one voice.
    """

    language = ""


def _transcript(text: str, language: str | None, evidence=None) -> Transcript:
    value = Transcript(text)
    value.language = str(language or "")
    value.evidence = evidence or {}
    return value


def _run(model, audio: np.ndarray | str | BinaryIO, language: str, *, vad_filter: bool = False, cancel=None) -> Transcript:
    global _last_run_at
    check_cancelled(cancel)
    requested_language, constrained = language, False
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
        return _transcript("", None, recognition_evidence(info, [], requested_language))
    if bilingual and info.language not in {"fr", "en"}:
        # faster-whisper detects language eagerly but decodes segments lazily.
        # Choose between the two languages advertised by the caller before any
        # foreign-language segments are generated. Ordinary auto stays multilingual.
        candidates = [(lang, probability) for lang, probability in (info.all_language_probs or [])
                      if lang in {"fr", "en"}]
        if not candidates:
            raise RuntimeError("French/English speech detection is unavailable.")
        selected = max(candidates, key=lambda item: item[1])[0]
        constrained = True
        options.update(language=selected, initial_prompt=(
            settings.whisper_initial_prompt if selected == "fr" else settings.whisper_hotwords
        ) or None)
        if initial_position is not None:
            audio.seek(initial_position)
        segments, info = model.transcribe(audio, **options)
    decoded, iterator = [], iter(segments)
    while True:
        check_cancelled(cancel)
        try:
            decoded.append(next(iterator))
        except StopIteration:
            break
    check_cancelled(cancel)
    text = " ".join(seg.text.strip() for seg in decoded).strip()
    normalized = normalize_transcript(text)
    _last_run_at = time.monotonic()
    return _transcript(normalized, getattr(info, "language", ""), recognition_evidence(
        info, decoded, requested_language, constrained=constrained, changed=normalized != text))


def _transcribe_locked(audio, language: str, *, vad_filter: bool = False, cpu_fallback: bool = True, cancel=None):
    global _retrying
    device, compute = _next_backend()
    _require_backend(device)
    initial_position = audio.tell() if hasattr(audio, "tell") else None
    with _state_lock:
        _retrying = _prefer_cpu and device != "cpu"
    try:
        try:
            text = _run(_get_model(device, compute), audio, language, vad_filter=vad_filter, cancel=cancel)
        except Exception as exc:
            if device == "cpu" or not _is_cuda_runtime_error(exc):
                raise
            _gpu_failed(device, compute, exc)
            if not settings.whisper_cpu_fallback:
                raise RecognitionUnavailable("GPU speech recognition is temporarily unavailable.") from exc
            if not cpu_fallback:
                raise
            if initial_position is not None:
                audio.seek(initial_position)
            text = _run(_get_model("cpu", "int8"), audio, language, vad_filter=vad_filter, cancel=cancel)
            text.evidence.update(device="cpu", computeType="int8")
            return text
        text.evidence.update(device=device, computeType=compute)
        _gpu_recovered(device)
        return text
    finally:
        with _state_lock:
            _retrying = False


def transcribe(audio: np.ndarray, *, language: str | None = None, cancel=None) -> tuple[str, float]:
    """Transcribe a float32 mono array @ 16 kHz. Returns (text, elapsed_ms)."""
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    started = time.perf_counter()
    with inference_slot(_inference_lock, cancel, settings.whisper_queue_timeout_seconds) as queue_ms:
        decode_started = time.perf_counter()
        text = _transcribe_locked(audio, language or settings.voix_language, cancel=cancel)
        text.evidence.update(queueMs=round(queue_ms), decodeMs=round((time.perf_counter() - decode_started) * 1000))
    return text, (time.perf_counter() - started) * 1000.0


def warm(*, max_age_s: float = 20.0) -> float | None:
    """Run the model once ahead of an utterance the caller knows is coming.

    The first recognition after an idle period is slower than one that follows
    a recent run. One second of silence goes through `transcribe`, without the
    speech filter that would skip the model, and its text is discarded.
    Returns the elapsed milliseconds, or None when nothing ran: the model ran
    less than `max_age_s` ago, another warm call is in progress, or the model
    failed. A failure is left for the real request to report.
    """
    # Optional warm-up never queues behind or overlaps an ordinary transcription.
    if not _inference_lock.acquire(blocking=False):
        return None
    try:
        device, _ = _next_backend()
        if device == "cpu" and settings.whisper_device != "cpu":
            return None
        if (device == "cpu" or not _prefer_cpu) and _last_run_at is not None and time.monotonic() - _last_run_at < max_age_s:
            return None
        try:
            started = time.perf_counter()
            _transcribe_locked(np.zeros(16000, dtype=np.float32), "fr", cpu_fallback=False)
        except Exception:
            return None
        return (time.perf_counter() - started) * 1000.0
    finally:
        _inference_lock.release()


def transcribe_path(path: str | Path | BinaryIO, *, language: str | None = None, cancel=None) -> tuple[str, float]:
    """Transcribe a path or seekable memory stream (decoded through PyAV).
    Uploaded audio has not passed any speech detection. Use faster-whisper's
    bundled VAD so silence/noise returns empty text instead of invented
    subtitle credits.
    """
    started = time.perf_counter()
    audio = path if hasattr(path, "read") else str(path)
    with inference_slot(_inference_lock, cancel, settings.whisper_queue_timeout_seconds) as queue_ms:
        decode_started = time.perf_counter()
        text = _transcribe_locked(audio, language or settings.voix_language, vad_filter=True, cancel=cancel)
        text.evidence.update(queueMs=round(queue_ms), decodeMs=round((time.perf_counter() - decode_started) * 1000))
    return text, (time.perf_counter() - started) * 1000.0
