"""Cancellable LAN streaming client for a warmed cloned-voice worker.

The worker speaks ``voix-pcm-v1`` and declares its own sample rate: the VoxCPM2
worker streams 48 kHz, the Pocket TTS worker 24 kHz.
"""
from __future__ import annotations

import asyncio
import base64
from contextlib import suppress
from functools import lru_cache
import json
import ssl
import time
from uuid import uuid4

import httpx
import certifi
import numpy as np

from app.config import settings


SAMPLE_RATES = (16000, 22050, 24000, 44100, 48000)


def _url() -> str:
    if not settings.voxcpm_base_url:
        raise ValueError("VOXCPM_BASE_URL is required for VoxCPM2")
    return settings.voxcpm_base_url.rstrip("/")


@lru_cache(maxsize=1)
def _tls_context():
    # Loading the CA store costs hundreds of milliseconds on Windows. Reuse
    # the verified context across clauses; HTTPS certificate checks stay on.
    return ssl.create_default_context(cafile=certifi.where())


def preload() -> None:
    with httpx.Client(timeout=settings.voxcpm_timeout_seconds, trust_env=False, verify=_tls_context()) as client:
        response = client.get(_url() + "/health")
        response.raise_for_status()
        data = response.json()
    served = {item.get("id") for item in data.get("voices") or [] if isinstance(item, dict)} or {data.get("voice")}
    if not data.get("ready") or settings.voxcpm_voice not in served:
        raise RuntimeError("VoxCPM2 worker is not ready with the configured voice")
    if settings.tts_pocket_only and data.get("model") != "kyutai/pocket-tts":
        raise RuntimeError("Pocket-only synthesis requires a Pocket TTS worker")


class Decoder:
    """Reject incomplete, reordered or malformed streams before declaring success."""

    def __init__(self, voice: str):
        self.voice = voice
        self.rate = None
        self.frames = 0
        self.samples = 0
        self.done = False

    def accept(self, event: dict):
        if self.done:
            raise ValueError("Audio received after stream completion")
        kind = event.get("type")
        if kind == "meta":
            if self.rate is not None or event.get("protocol") != "voix-pcm-v1":
                raise ValueError("Invalid audio stream metadata")
            if (event.get("sample_rate") not in SAMPLE_RATES or event.get("encoding") != "f32le"
                    or event.get("channels") != 1 or event.get("voice") != self.voice):
                raise ValueError("Unexpected audio format or voice")
            self.rate = event["sample_rate"]
        elif kind == "audio":
            if self.rate is None or event.get("sequence") != self.frames + 1:
                raise ValueError("Missing or reordered audio frame")
            raw = base64.b64decode(event["pcm"], validate=True)
            samples = np.frombuffer(raw, dtype="<f4").copy()
            if not samples.size or samples.size != event.get("samples") or not np.isfinite(samples).all():
                raise ValueError("Invalid audio samples")
            self.frames += 1
            self.samples += samples.size
            return samples
        elif kind == "done":
            if not self.frames or event.get("frames") != self.frames or event.get("samples") != self.samples:
                raise ValueError("Incomplete audio stream")
            self.done = True
        elif kind == "error":
            raise RuntimeError("VoxCPM2 synthesis failed")
        else:
            raise ValueError("Unexpected audio stream event")
        return None


async def stream(text: str, *, voice: str | None = None, language=None, cancel=None):
    selected_voice = voice or settings.voxcpm_voice
    decoder = Decoder(selected_voice)
    request_id = uuid4().hex
    started = time.perf_counter()
    owner = asyncio.current_task()

    async def watch_cancel():
        while not cancel.is_set():
            await asyncio.sleep(0.02)
        owner.cancel()

    watcher = asyncio.create_task(watch_cancel()) if cancel is not None else None
    try:
        async with httpx.AsyncClient(timeout=settings.voxcpm_timeout_seconds, trust_env=False,
                                     verify=_tls_context()) as client:
            try:
                async with client.stream("POST", _url() + "/v1/stream", json={
                    "id": request_id, "text": text, "voice": selected_voice,
                }) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        samples = decoder.accept(json.loads(line))
                        if samples is not None:
                            yield samples, decoder.rate, (time.perf_counter() - started) * 1000
                if not decoder.done:
                    raise RuntimeError("VoxCPM2 stream ended before completion")
            finally:
                if not decoder.done:
                    # An explicit cancellation also covers queued requests and a
                    # worker blocked before its next socket write.
                    with suppress(httpx.HTTPError):
                        await client.delete(_url() + "/v1/requests/" + request_id, timeout=1)
    finally:
        if watcher is not None:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)


def synthesize(text: str, *, language=None, voice=None):
    async def collect():
        chunks, rate, elapsed = [], 48000, 0.0
        async for samples, rate, elapsed in stream(text, voice=voice, language=language):
            chunks.append(samples)
        return np.concatenate(chunks), rate, elapsed
    return asyncio.run(collect())
