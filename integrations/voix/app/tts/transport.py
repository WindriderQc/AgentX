"""Provider-neutral PCM events for the existing local speech service."""
import asyncio
import base64
from contextlib import aclosing
import json
import time
from urllib.parse import quote

import numpy as np

from app.cancel import CancelToken
from app.tts import provider
from app.tts.chunker import ClauseChunker


def headers(profile: dict) -> dict:
    return {"X-Voix-Provider": profile["provider"], "X-Voix-Voice": quote(profile.get("voice") or "", safe=""),
            "X-Voix-Language": profile.get("language") or "", "Cache-Control": "no-store"}


def event(data: dict) -> bytes:
    return (json.dumps(data, separators=(",", ":")) + "\n").encode("utf-8")


async def pcm_events(text: str, profile: dict):
    cancel = CancelToken()
    started = time.perf_counter()
    sequence, count, rate = 0, 0, None
    try:
        async with aclosing(speech_chunks(text, profile, cancel)) as chunks:
            async for samples, sample_rate, _elapsed in chunks:
                samples = np.asarray(samples, dtype="<f4").reshape(-1)
                if not len(samples) or not np.isfinite(samples).all():
                    raise ValueError("Invalid generated audio")
                if rate is None:
                    rate = sample_rate
                    yield event({"type": "meta", "protocol": "voix-pcm-v1", "encoding": "f32le", "channels": 1,
                                 **profile, "sample_rate": rate})
                if rate != sample_rate:
                    raise ValueError("Audio sample rate changed within the request")
                for offset in range(0, len(samples), 4800):
                    frame = samples[offset:offset + 4800]
                    sequence += 1
                    count += len(frame)
                    yield event({"type": "audio", "sequence": sequence, "samples": len(frame),
                                 "pcm": base64.b64encode(frame.tobytes()).decode("ascii")})
        if not sequence:
            raise ValueError("No audio generated")
        yield event({"type": "done", "frames": sequence, "samples": count,
                     "generation_ms": round((time.perf_counter() - started) * 1000)})
    except asyncio.CancelledError:
        raise
    except Exception:
        yield event({"type": "error", "message": "Local speech synthesis failed"})
    finally:
        cancel.set()


async def speech_chunks(text: str, profile: dict, cancel):
    # Frame-streaming VoxCPM retains its full prosodic context. Local engines
    # that return complete buffers start after the first sentence of a long reply.
    clauses = [text]
    if profile["provider"] != "voxcpm":
        chunker = ClauseChunker(sentence_only=True)
        clauses = chunker.feed(text)
        tail = chunker.flush()
        if tail:
            clauses.append(tail)
    for clause in clauses:
        if cancel.is_set():
            return
        async with aclosing(provider.stream(clause, profile["provider"], language=profile.get("language"),
                                            voice=profile.get("voice"), cancel=cancel)) as chunks:
            async for chunk in chunks:
                yield chunk
