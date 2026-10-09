"""Pocket TTS worker: the cloned-voice worker protocol, served on the processor.

It speaks the same HTTP protocol and reads the same voices directory as the
VoxCPM2 worker (``voxcpm_server``), so the speech service reaches it through
the same ``VOXCPM_BASE_URL`` and nothing else changes for a caller. Run with the
optional requirements-pocket.txt environment. The model is loaded once; audio
and request text are never written to disk. No graphics memory is used.
"""
from __future__ import annotations

import argparse
from http.server import ThreadingHTTPServer
import threading

import numpy as np

from app.tts.voxcpm_server import Worker, handler_for, load_voices

MODEL = "kyutai/pocket-tts"
# The model's default end-of-speech threshold (-4) ends about one sentence in
# three early with a cloned voice; 0 keeps the endings. Lower values cut more.
EOS_THRESHOLD = 0.0


def stream_voice(model, state, text: str):
    """Yield the model's audio as float32 arrays; stop the model when the reader stops."""
    stop = threading.Event()
    try:
        for chunk in model.generate_audio_stream(state, text, stop=stop):
            audio = chunk.detach().float().cpu().numpy() if hasattr(chunk, "detach") else np.asarray(chunk)
            yield np.asarray(audio, dtype="<f4").reshape(-1)
    finally:
        # A closed or abandoned generator must not leave the model generating.
        stop.set()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices-dir", required=True,
                        help="directory of <id>.wav references (+ optional <id>.name label)")
    parser.add_argument("--voice", default="nestor-a", help="default voice id among the references")
    parser.add_argument("--language", default="french", help="Pocket TTS language model (default: french)")
    parser.add_argument("--eos-threshold", type=float, default=EOS_THRESHOLD,
                        help=f"end-of-speech threshold (default: {EOS_THRESHOLD})")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    parser.add_argument("--no-end-fade", action="store_true",
                        help="diagnostic: send the last generated chunk without softening")
    args = parser.parse_args()
    # A transcript beside a reference is ignored: this engine clones from the audio alone.
    references = load_voices(args.voices_dir, continuation=False)
    if not references:
        parser.error("--voices-dir holds no <id>.wav reference")
    default = args.voice if args.voice in references else next(iter(references))

    from pocket_tts import TTSModel
    model = TTSModel.load_model(language=args.language, eos_threshold=args.eos_threshold)
    # Reading a reference takes seconds; do it once per voice, before accepting speech.
    states = {voice: model.get_state_for_audio_prompt(value["options"]["reference_wav_path"])
              for voice, value in references.items()}

    def generate(text, voice=default):
        yield from stream_voice(model, states[voice], text)

    worker = Worker(generate, default, {key: value["name"] for key, value in references.items()},
                    soften_final=not args.no_end_fade, sample_rate=int(model.sample_rate), model=MODEL, tag="pocket")
    server = ThreadingHTTPServer((args.bind, args.port), handler_for(worker))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for voice in references:  # each voice once, so a first request is not a cold one
            for _ in generate("Bonjour. On peut continuer tranquillement.", voice):
                pass
        worker.ready = True
        print(f"[pocket] ready voices={','.join(references)} default={default} rate={worker.sample_rate}", flush=True)
        while True:
            worker.execute(worker.pending.get())
    finally:
        worker.ready = False
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
