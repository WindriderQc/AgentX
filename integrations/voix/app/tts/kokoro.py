"""Kokoro-onnx TTS — synthesize one clause to in-memory samples (no file I/O).

Returns float32 samples and their sample rate. Model files come from app.assets.
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

import numpy as np

from app.assets import ensure_kokoro_assets
from app.config import settings


_tts = None
_ESPEAK_LANGUAGE_SWITCH = re.compile(r"\([a-z]{2,3}(?:-[a-z]{2})?\)", re.IGNORECASE)


def _phonemes_without_language_switch_markers(tts, text: str, language: str) -> str:
    """Keep code-switched phonemes while removing eSpeak control markers.

    eSpeak emits strings such as ``(en)open-claw(fr)`` inside French text.
    Kokoro's vocabulary can turn the marker letters themselves into audible
    syllables, so only the control wrappers are removed before synthesis.
    """
    phonemes = tts.tokenizer.phonemize(text, language)
    return _ESPEAK_LANGUAGE_SWITCH.sub("", phonemes).strip()


def _voice_style(tts, voice: str):
    """Resolve a voice name or a weighted ``name:weight+name:weight`` blend."""
    if "+" not in voice and ":" not in voice:
        return voice

    weighted = []
    for raw_part in voice.split("+"):
        name, separator, raw_weight = raw_part.strip().partition(":")
        if not name:
            raise ValueError("Kokoro voice blends require a voice name")
        weight = float(raw_weight) if separator else 1.0
        if weight <= 0:
            raise ValueError("Kokoro voice blend weights must be positive")
        weighted.append((tts.get_voice_style(name), weight))
    total = sum(weight for _, weight in weighted)
    return np.asarray(
        sum(style * (weight / total) for style, weight in weighted),
        dtype=np.float32,
    )


def _prepare_onnx_runtime() -> None:
    """Make pip-provided CUDA/cuDNN DLLs visible before ONNX creates a session."""
    if settings.kokoro_onnx_provider.strip() != "CUDAExecutionProvider":
        return

    import onnxruntime as ort

    if sys.platform == "win32":
        nvidia_root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
        bin_dirs = [
            str(package / "bin")
            for package in nvidia_root.iterdir()
            if (package / "bin").is_dir()
        ] if nvidia_root.is_dir() else []
        if bin_dirs:
            os.environ["PATH"] = os.pathsep.join(bin_dirs + [os.environ.get("PATH", "")])

    preload_dlls = getattr(ort, "preload_dlls", None)
    if preload_dlls is not None:
        preload_dlls(directory="")


def _get_tts():
    global _tts
    if _tts is None:
        _prepare_onnx_runtime()
        try:
            from kokoro_onnx import Kokoro
        except ImportError as exc:  # pragma: no cover - depends on runtime packages
            raise RuntimeError("kokoro-onnx is not installed.") from exc
        model_path, voices_path = ensure_kokoro_assets()
        _tts = Kokoro(str(model_path), str(voices_path))
    return _tts


def preload() -> None:
    _get_tts()


def synthesize(
    text: str,
    *,
    language: str | None = None,
    voice: str | None = None,
) -> tuple[np.ndarray, int, float]:
    """Synthesize one clause. Returns (samples float32, sample_rate, elapsed_ms)."""
    tts = _get_tts()
    started = time.perf_counter()
    selected_language = language or settings.kokoro_language
    phonemes = _phonemes_without_language_switch_markers(tts, text, selected_language)
    samples, sample_rate = tts.create(
        text=phonemes,
        voice=_voice_style(tts, voice or settings.kokoro_voice),
        speed=1.0,
        lang=selected_language,
        is_phonemes=True,
    )
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if settings.kokoro_pad_ms:
        pad = int(sample_rate * settings.kokoro_pad_ms / 1000)
        if pad > 0:
            samples = np.concatenate([samples, np.zeros(pad, dtype=np.float32)])
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return samples, int(sample_rate), elapsed_ms
