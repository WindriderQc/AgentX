# Speech service

This directory holds AgentX's local speech service (historically "VoiX") and its
optional spoken-controls adapter. The service turns audio into text
(faster-whisper) and text into audio (Kokoro, Windows SAPI, or an optional
VoxCPM2 cloned voice) for AgentX Core, on the instance's voice host.

It owns no conversation, memory, microphone or speaker. Spoken conversation runs
in the Household page: the browser captures and plays audio, Core owns the turn
and its memory, and this service only transcribes and synthesizes. The earlier
native conversation loop (its own microphone, turn engine, wake gate, clip vault
and dashboard) is retired; see WindriderQc/AgentX#478.

## What it serves

Core reaches the service through `VOIX_BASE_URL` (and `VOIX_FALLBACK_URL`).

| Route | Purpose |
| --- | --- |
| `GET /health`, `GET /api/health`, `GET /version` | Liveness, version and startup warm-up state |
| `GET /api/voices` | Installed voices and engines; never loads a model |
| `GET /assets/voice-audio.js` | Browser player for the streamed audio protocol |
| `POST /v1/audio/transcriptions` | One uploaded utterance to text (`language`: `auto`, `fr`, `en`, `fr-en`) |
| `POST /api/stt/warm`, `POST /api/preload-stt` | Wake or load recognition ahead of an utterance |
| `POST /api/tts`, `POST /v1/audio/speech` | Text to one audio file (`wav`, `mp3`, `flac`, `ogg`, `opus`) |
| `POST /api/tts/stream` | Text to `voix-pcm-v1` NDJSON audio frames |
| `GET /v1/models` | The active recognition model |
| `GET /config`, `POST /config` | Speech choices only: engine, default language, per-language voices |
| `POST /diagnostics/tts-smoke` | One synthesis, timed, without returning audio |

`/health` answers `status`, `version`, `warmup` and a constant `running: false`
kept for callers written for the earlier service. Uploaded audio is decoded in
memory and never stored; logs carry sizes and timings, never text.
Uploaded transcription requires confident speech before decoding words; audio
with no detected speech returns empty text. `WHISPER_VAD_THRESHOLD` tunes that
probability threshold. Weaker phonemes remain accepted after speech starts, and
400 ms of padding preserves word boundaries. Recognized words are not rejected
for naming a website. Qualify noise and short/quiet speech together before
changing the threshold on an instance.

A synthesis request names its own `tts_provider`, `language` and `voice`; the
applied choice comes back in `X-Voix-Provider`, `X-Voix-Voice` and
`X-Voix-Language`. An unavailable cloned-voice worker answers `503` before any audio:
the caller chooses another voice, the service never substitutes one
([docs/voxcpm-streaming.md](docs/voxcpm-streaming.md)).

## Install and start

### One Pocket TTS engine

A Pocket-only instance uses `requirements-speech.txt` for this relay and
`requirements-pocket.txt` for its CPU worker. The relay keeps Whisper recognition
and its CUDA libraries; it does not need Kokoro or ONNX GPU synthesis. ONNX CPU
remains necessary for Whisper's speech detection.

Set `TTS_PROVIDER=voxcpm`, `TTS_POCKET_ONLY=true` and `VOXCPM_BASE_URL` to the
ready Pocket worker. The `voxcpm` id is the existing transport compatibility id;
the catalogue names the worker Pocket TTS. Only its voices appear, startup warms
that engine, and `/config` cannot reactivate a retired engine.

Old browser selections can be migrated with `TTS_VOICE_ALIASES`, a JSON object
such as `{"kokoro|ff_siwis":"helper"}`. A request naming a retired engine uses
the mapped Pocket reference, or the default reference when no mapping exists.
Applied response headers identify the actual engine and voice. This is a
migration to one engine, not a fallback; a failed Pocket worker returns an error.
Existing Pocket requests still require a configured reference. Instance voice
assignments should also be updated so agent settings name their current voices.

The worker loads one model and a voice state per `<id>.wav` reference, with an
optional `<id>.name` label. Add references and restart the worker to discover
them. Qualify ordinary short and longer utterances in each language actually
used before retiring an instance's useful voice assignments. A configured French
worker does not establish English quality merely because the catalogue lists it.

### Other existing deployments

Use Python 3.11 or newer on the voice host, from this directory:

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip
.venv/bin/python -m uvicorn app.service:app --host 0.0.0.0 --port 8091
```

`requirements.txt` includes the NVIDIA runtime wheels for GPU recognition and
synthesis; recognition falls back to CPU when CUDA is unavailable. Model files
are downloaded on first use into `cache/` and are never committed. Bind and
firewall the port for the local network only.

On Windows, `start.ps1` (or `start-voix.cmd`) starts the service in the
foreground and keeps `logs/voix.log`; `voix.ps1 status|start|stop|restart`
drives an instance-installed scheduled task named `VoiX-Autostart`.

Settings come from the environment, or from a `.env` file in this directory:
[voix.env.example](voix.env.example) lists them. Names of people and machines
are instance data. Give Whisper the instance's own names through
`WHISPER_HOTWORDS` and `WHISPER_INITIAL_PROMPT`, and its transcript corrections
through `VOIX_STT_CORRECTIONS_PATH`, a JSON file kept outside this repository:

```json
[{"pattern": "\\bcam+il+e?\\b", "replacement": "Camille"}]
```

Patterns are regular expressions matched without case. The built-in rules only
cover product names (Nestor, AgentX, OpenClaw, VoiX).

## Tests

```sh
cd integrations/voix
python -m pip install -r requirements-test.txt
python -m pytest -q
```

These tests need no speech model and no GPU: engines are replaced by fakes, so
they cover the HTTP contract, request validation, the voice catalog, the stream
protocol and the cloned-voice worker logic. `node --test tests/voice-audio.test.cjs`
covers the browser player. Neither proves that a host transcribes or speaks:
qualify recognition, each engine and audible playback on the real voice host.

`python -m unittest discover -s integrations/voix -p 'test_*.py'`, run from the
repository root, runs the pure spoken-controls tests without any dependency.

## Local spoken controls (optional adapter)

This optional adapter adds a bounded command recognizer to the speech service
process. Vosk checks the complete mono PCM WAV for a standalone Stop/silence
command while general transcription already runs, so an ordinary request waits
for the longer of the two passes, not their sum; a recognized command answers
at once and the transcription started beside it is dropped unread. Unknown
words and mixed requests retain Whisper, its language choice and its decoder.
Core remains the conversation and memory owner. No audio or transcript is
stored by this adapter.

Install `requirements-controls.txt` into the speech service's Python
environment. Download the Apache-2.0 French `vosk-model-small-fr-0.22` from the
[official model catalog](https://alphacephei.com/vosk/models) into an external
instance directory. Neither models nor machine settings belong in Git.

On Windows, the instance launcher invokes `start-controls.ps1` with `-VoiXRoot`
(the directory holding the service's `.venv`, normally this one) and
`-ModelDirectory`. On other hosts, put this directory on `PYTHONPATH`, set
`VOIX_CONTROL_MODEL_DIR`, then run `python -m uvicorn agentx_voix_controls:app`
in the same environment. The same process serves the routes above plus
`/v1/audio/transcriptions/controls`; `/api/voice-controls/status` reports
readiness.

Set `VOIX_SPOKEN_CONTROLS_ENABLED=true` in Core's external instance settings
only after the adapter is ready. Blank/false preserves the ordinary upload
endpoint. A structured `control: stop` resumes browser listening without a user
turn or spoken acknowledgement. Pending native cancellation still settles
before another turn. This is an endpoint command check, not an always-on wake
word.

Qualify positive commands, ordinary speech, short corrections, mixed requests
and silence against the installed model, then perform real microphone and
audible interruption acceptance.
