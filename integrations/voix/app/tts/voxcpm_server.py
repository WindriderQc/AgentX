"""Single-inference-context VoxCPM2 worker; HTTP never executes CUDA work.

Run with the optional requirements-voxcpm.txt environment. The worker loads the
model once and serves one or more configured references (named voices); audio
and request text are never written to disk.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import queue
import re
import threading
import time

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


def soften_ending(audio: np.ndarray) -> np.ndarray:
    """Fade the 40 ms before the last audible sample: the compiled model sometimes stops
    mid-syllable at full level, and the chunk may already end with silence after the cut."""
    audio = audio.copy()
    window = 240  # 5 ms envelope; low noise after the cut is not speech
    usable = audio.size // window * window
    if usable:
        rms = np.sqrt(np.mean(audio[:usable].reshape(-1, window) ** 2, axis=1))
        loud = np.flatnonzero(rms > max(0.005, 0.1 * float(rms.max())))
        if not loud.size:
            return audio
        end = (int(loud[-1]) + 1) * window
    else:
        end = audio.size
    size = min(FADE_SAMPLES, end)
    audio[end - size:end] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, size))).astype(audio.dtype)
    audio[end:] = 0
    return audio


class Worker:
    def __init__(self, generate, voice: str, voices: dict[str, str] | None = None, *, soften_final: bool = True):
        """``voice`` is the default id; ``voices`` maps every served id to its display name."""
        self.generate = generate
        self.voice = voice
        self.voices = voices or {voice: voice}
        self.soften_final = soften_final
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
        frames, total = 0, 0
        try:
            if not self.send(job, dict(type="meta", protocol="voix-pcm-v1", sample_rate=48000,
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
            if not emit(np.zeros(LEAD_SILENCE, dtype="<f4")):
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
                if pending is not None and not emit(pending):
                    return
                pending = audio
            if pending is not None and not job.cancelled.is_set():
                final = soften_ending(pending) if self.soften_final else pending
                if not emit(final) or not emit(np.zeros(TAIL_SILENCE, dtype="<f4")):
                    return
            if frames and not job.cancelled.is_set():
                self.send(job, dict(type="done", frames=frames, samples=int(total)))
            elif not job.cancelled.is_set():
                self.send(job, dict(type="error", message="No audio generated"))
        except Exception as exc:
            # Log only the error class; model errors can contain private text.
            print(f"[voxcpm] synthesis failed: {type(exc).__name__}", flush=True)
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
            self.respond(200, dict(ready=worker.ready, model="openbmb/VoxCPM2", voice=worker.voice,
                                   voices=[{"id": key, "name": name} for key, name in worker.voices.items()],
                                   sample_rate=48000, streaming=True))

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


def reference_options(reference_path: str, prompt_text: str = "", *, continuation: bool = True) -> dict:
    """Clone from the reference; with its transcript, combine reference and continuation.

    Continuation (reference audio plus its exact words) can preserve an accent,
    while reference-only cloning may avoid unstable sentence endings. Compare
    both modes by listening to the affected voice.
    """
    options = {"reference_wav_path": reference_path}
    if continuation and prompt_text.strip():
        options.update(prompt_wav_path=reference_path, prompt_text=prompt_text.strip())
    return options


VOICE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def load_voices(directory, *, continuation: bool = True) -> dict[str, dict]:
    """Read named references from a directory: ``<id>.wav`` with an optional exact
    transcript ``<id>.txt`` (continuation cloning) and display name ``<id>.name``."""
    voices = {}
    for wav in sorted(Path(directory).glob("*.wav")):
        if not VOICE_ID.match(wav.stem):
            continue
        transcript = wav.with_suffix(".txt")
        label = wav.with_suffix(".name")
        name = label.read_text(encoding="utf-8").strip()[:80] if label.exists() else ""
        voices[wav.stem] = {
            "name": name or wav.stem,
            "options": reference_options(str(wav), transcript.read_text(encoding="utf-8")
                                         if continuation and transcript.exists() else "",
                                         continuation=continuation),
        }
    return voices


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--reference-path", default="",
                        help="single reference; use --voices-dir to serve several voices")
    parser.add_argument("--voices-dir", default="",
                        help="directory of <id>.wav (+ <id>.txt transcript, <id>.name label) references")
    parser.add_argument("--prompt-text-path", default="",
                        help="exact transcript of the reference; enables continuation cloning")
    parser.add_argument("--voice", default="nestor-a", help="voice id (the default when several are served)")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    parser.add_argument("--no-optimize", action="store_true",
                        help="diagnostic: skip torch.compile optimization")
    parser.add_argument("--reference-only", action="store_true",
                        help="clone from the reference without transcript continuation")
    parser.add_argument("--no-end-fade", action="store_true",
                        help="diagnostic: send the last generated chunk without softening")
    parser.add_argument("--seed", type=int, default=42,
                        help="generation seed (default: 42)")
    parser.add_argument("--min-len", type=int, default=2,
                        help="minimum generated patches before the stop decision (default: 2)")
    args = parser.parse_args()
    if not 0 <= args.seed <= 2**32 - 1 or not 1 <= args.min_len <= 128:
        parser.error("--seed must be 0..4294967295 and --min-len must be 1..128")
    if args.voices_dir:
        references = load_voices(args.voices_dir, continuation=not args.reference_only)
        if not references:
            parser.error("--voices-dir holds no <id>.wav reference")
        default = args.voice if args.voice in references else next(iter(references))
    elif args.reference_path:
        prompt_text = (Path(args.prompt_text_path).read_text(encoding="utf-8")
                       if args.prompt_text_path and not args.reference_only else "")
        references = {args.voice: {"name": args.voice, "options": reference_options(
            args.reference_path, prompt_text, continuation=not args.reference_only)}}
        default = args.voice
    else:
        parser.error("--reference-path or --voices-dir is required")
    import torch
    from voxcpm import VoxCPM
    torch.set_num_threads(4)
    model = VoxCPM.from_pretrained(args.model_path, load_denoiser=False, optimize=False, device="cuda")
    if not args.no_optimize:
        model.tts_model.optimize()

    def generate(text, voice=default):
        torch.manual_seed(args.seed)
        np.random.seed(args.seed)
        yield from model.generate_streaming(text=text, **references[voice]["options"],
                                            cfg_value=2.0, inference_timesteps=10, min_len=args.min_len,
                                            max_len=768,
                                            normalize=False, denoise=False, retry_badcase=False)

    worker = Worker(generate, default, {key: value["name"] for key, value in references.items()},
                    soften_final=not args.no_end_fade)
    server = ThreadingHTTPServer((args.bind, args.port), handler_for(worker))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # Two lengths initialize the compiled path before accepting speech.
        for text in ("Bonjour. On peut continuer tranquillement.",
                     "Bonjour. On peut prendre notre temps pour choisir la suite. "
                     "Je peux reprendre plus lentement, ou poursuivre avec une autre question."):
            for _ in generate(text):
                pass
        for voice in references:  # each reference once, so a first request is not a cold one
            for _ in generate("Bonjour.", voice):
                pass
        worker.ready = True
        print(f"[voxcpm] ready voices={','.join(references)} default={default} rate=48000", flush=True)
        while True:
            worker.execute(worker.pending.get())
    finally:
        worker.ready = False
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
