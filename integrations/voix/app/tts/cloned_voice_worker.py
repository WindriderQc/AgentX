"""Cancellable HTTP worker for streamed cloned voices.

Pocket TTS supplies the generator, sample rate and model identity. This module
has no model dependency and never loads an engine. Audio and request text are
never written to disk.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
import queue
import re
import threading

import numpy as np


@dataclass
class Job:
    id: str
    text: str
    voice: str
    output: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=2))
    cancelled: threading.Event = field(default_factory=threading.Event)


FADE_SAMPLES = 1920      # 40 ms at 48 kHz
TAIL_SILENCE = 5760      # 120 ms at 48 kHz
LEAD_SILENCE = 3840      # 80 ms at 48 kHz, like Kokoro's pad: players start late on a fresh output
REFERENCE_RATE = 48000   # the durations above are counted at this rate


def at_rate(samples: int, rate: int) -> int:
    """The same duration at another sample rate."""
    return samples * rate // REFERENCE_RATE


def soften_ending(audio: np.ndarray, rate: int = REFERENCE_RATE) -> np.ndarray:
    """Fade the 40 ms before the last audible sample: a synthesis model can stop
    mid-syllable at full level, and the chunk may already end with silence after the cut."""
    audio = audio.copy()
    window = max(1, at_rate(240, rate))  # 5 ms envelope; low noise after the cut is not speech
    usable = audio.size // window * window
    if usable:
        rms = np.sqrt(np.mean(audio[:usable].reshape(-1, window) ** 2, axis=1))
        loud = np.flatnonzero(rms > max(0.005, 0.1 * float(rms.max())))
        if not loud.size:
            return audio
        end = (int(loud[-1]) + 1) * window
    else:
        end = audio.size
    size = min(at_rate(FADE_SAMPLES, rate), end)
    audio[end - size:end] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, size))).astype(audio.dtype)
    audio[end:] = 0
    return audio


class Worker:
    def __init__(self, generate, voice: str, voices: dict[str, str] | None = None, *, soften_final: bool = True,
                 sample_rate: int = REFERENCE_RATE, model: str = "kyutai/pocket-tts", tag: str = "pocket"):
        """``voice`` is the default id; ``voices`` maps every served id to its display name.
        ``sample_rate`` is the rate of the audio ``generate`` yields; ``model`` and ``tag``
        name the engine in ``/health`` and in the log."""
        self.generate = generate
        self.voice = voice
        self.voices = voices or {voice: voice}
        self.soften_final = soften_final
        self.sample_rate = sample_rate
        self.model = model
        self.tag = tag
        self.ready = False
        self.pending = queue.Queue()
        self.active = {}
        self.lock = threading.Lock()

    def submit(self, payload):
        voice = payload.get("voice")
        if voice not in self.voices:
            raise ValueError("Unknown voice")
        text, request_id = payload.get("text"), payload.get("id")
        if not isinstance(text, str) or not text.strip() or not isinstance(request_id, str) or not request_id:
            raise ValueError("A request id and nonempty text are required")
        job = Job(request_id, text, voice)
        with self.lock:
            if request_id in self.active:
                raise ValueError("Request already active")
            self.active[request_id] = job
        self.pending.put(job)
        return job

    def cancel(self, request_id):
        with self.lock:
            job = self.active.get(request_id)
            if job is not None:
                job.cancelled.set()

    @staticmethod
    def send(job, event):
        while not job.cancelled.is_set():
            try:
                job.output.put(event, timeout=0.02)
                return True
            except queue.Full:
                pass
        return False

    def execute(self, job):
        stream = None
        frames, total, generated_samples = 0, 0, 0
        try:
            if not self.send(job, dict(type="meta", protocol="voix-pcm-v1", sample_rate=self.sample_rate,
                                       encoding="f32le", channels=1, voice=job.voice)):
                return
            def emit(audio):
                nonlocal frames, total
                frames += 1
                total += audio.size
                return self.send(job, dict(type="audio", sequence=frames, samples=int(audio.size),
                                           pcm=base64.b64encode(audio.tobytes()).decode()))

            # Lead-in silence first: a player that has just resumed its output clipped the
            # first syllable (a greeting is often the first audio of a session).
            if not emit(np.zeros(at_rate(LEAD_SILENCE, self.sample_rate), dtype="<f4")):
                return
            stream = self.generate(job.text, job.voice)
            # Hold one chunk back so the final one can end softly; this delays first audio by one chunk.
            pending = None
            while not job.cancelled.is_set():
                try:
                    chunk = next(stream)
                except StopIteration:
                    break
                audio = np.asarray(chunk, dtype="<f4").reshape(-1)
                if not audio.size or not np.isfinite(audio).all():
                    raise ValueError("Invalid generated audio")
                generated_samples += audio.size
                if pending is not None and not emit(pending):
                    return
                pending = audio
            if pending is not None and not job.cancelled.is_set():
                final = soften_ending(pending, self.sample_rate) if self.soften_final else pending
                if not emit(final) or not emit(np.zeros(at_rate(TAIL_SILENCE, self.sample_rate), dtype="<f4")):
                    return
            # Padding is transport audio, not evidence that the model spoke.
            if generated_samples and not job.cancelled.is_set():
                self.send(job, dict(type="done", frames=frames, samples=int(total)))
            elif not job.cancelled.is_set():
                self.send(job, dict(type="error", message="No audio generated"))
        except Exception as exc:
            # Log only the error class; model errors can contain private text.
            print(f"[{self.tag}] synthesis failed: {type(exc).__name__}", flush=True)
            self.send(job, dict(type="error", message="Synthesis failed"))
        finally:
            if stream is not None:
                stream.close()
            with self.lock:
                self.active.pop(job.id, None)


def handler_for(worker):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path != "/health":
                return self.respond(404, {"error": "Not found"})
            self.respond(200, dict(ready=worker.ready, model=worker.model, voice=worker.voice,
                                   voices=[{"id": key, "name": name} for key, name in worker.voices.items()],
                                   sample_rate=worker.sample_rate, streaming=True))

        def do_DELETE(self):
            prefix = "/v1/requests/"
            if not self.path.startswith(prefix):
                return self.respond(404, {"error": "Not found"})
            worker.cancel(self.path[len(prefix):])
            self.respond(200, {"ok": True})

        def do_POST(self):
            if self.path != "/v1/stream":
                return self.respond(404, {"error": "Not found"})
            if not worker.ready:
                return self.respond(503, {"error": "Voice is warming up"})
            try:
                payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                job = worker.submit(payload)
            except (ValueError, TypeError, AttributeError):
                return self.respond(400, {"error": "Invalid speech request or voice"})
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Connection", "close")
                self.end_headers()
                while not job.cancelled.is_set():
                    try:
                        event = job.output.get(timeout=0.05)
                    except queue.Empty:
                        continue
                    self.wfile.write(json.dumps(event, separators=(",", ":")).encode() + b"\n")
                    self.wfile.flush()
                    if event["type"] in ("done", "error"):
                        return
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                job.cancelled.set()
                self.close_connection = True
    return Handler


VOICE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def load_voices(directory) -> dict[str, dict]:
    """Read named audio references: ``<id>.wav`` and optional ``<id>.name``.

    Pocket clones from audio alone; transcript files beside a reference are
    ignored and never read.
    """
    voices = {}
    for wav in sorted(Path(directory).glob("*.wav")):
        if not VOICE_ID.match(wav.stem):
            continue
        label = wav.with_suffix(".name")
        name = label.read_text(encoding="utf-8").strip()[:80] if label.exists() else ""
        voices[wav.stem] = {
            "name": name or wav.stem,
            "options": {"reference_wav_path": str(wav)},
        }
    return voices
