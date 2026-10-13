# Pocket TTS cloned voices

Pocket TTS provides streamed cloned voices on the processor, without graphics
memory. The speech relay reaches its worker through `VOXCPM_BASE_URL` and callers
select `tts_provider:"voxcpm"`. These names are compatibility identifiers for the
installed transport; AgentX no longer ships the VoxCPM CUDA engine or its
requirements. Personas, memory and conversations remain in Core.

## Worker

Install `requirements-pocket.txt` in a separate Python environment. Cloning from
a reference requires the gated weights: accept the terms on the model page and
log in on the worker host (`hf auth login`). Start from this directory at the
same revision as the speech relay:

```sh
python -m app.tts.pocket_server --voices-dir /path/to/voices --voice narrator \
  --language french --bind LAN_ADDRESS --port 8092
```

The worker reads `<id>.wav` references and optional `<id>.name` display labels.
Transcripts beside a reference are ignored. `--voice` names the default;
`/health` lists all served voices. Adding a reference requires a worker restart.
The model and reference states load once, and each voice warms before readiness.
Reference audio, transcripts, credentials and model files stay outside Git.

`--eos-threshold` defaults to 0. The model's lower default ended some cloned
utterances early during qualification; check short replies and long sentences
by listening before changing it. `--no-end-fade` disables the final audio fade
for diagnosis. A cloned voice follows its reference's rhythm: use continuous
speech with long pauses shortened. A configured French model does not establish
English quality; qualify each language and voice actually used.

For a managed worker, use the instance's service manager with restart-on-failure.
A WSL worker needs a foreground `wsl.exe` held by its managed Windows task, or
WSL can shut down after the launching process exits.

## Speech relay

Configure the worker in the relay's external environment:

```dotenv
TTS_PROVIDER=voxcpm
TTS_POCKET_ONLY=true
VOXCPM_BASE_URL=http://LAN_ADDRESS:8092
VOXCPM_VOICE=narrator
VOXCPM_VOICE_NAME=
VOXCPM_TIMEOUT_SECONDS=60
```

Blank `VOXCPM_VOICE_NAME` uses the reference label, or "Voice A · Pocket TTS".
Pocket-only deployments use `requirements-speech.txt` for the relay and offer
only the Pocket voices. Other existing deployments can keep Kokoro or Windows
SAPI as their default and select Pocket per request. `/api/tts`,
`/api/tts/stream` and `/v1/audio/speech` accept the compatibility provider id and
a configured voice. `/config` can select it after the worker URL is configured.
The relay passes the complete utterance to the frame-streaming worker.

## Readiness and interruption

The relay checks `/health` before synthesis. An unreachable or warming worker,
or one without the configured voice, returns `503` before audio starts. There
is no automatic voice substitution. Pocket-only mode also checks the worker's
model identity. Ready answers are cached for 10 seconds, failures for 2 seconds;
a later request probes a failed worker beside the request so another voice does
not wait for the probe. Failure after readiness ends the stream with `error`.

Worker `POST /v1/stream` accepts `id`, `text` and `voice`. Its `voix-pcm-v1`
NDJSON response declares mono `f32le` audio at the worker's rate (Pocket uses
24 kHz), numbered base64 PCM frames, and a completion with exact frame/sample
totals. Missing completion, reordered frames, unexpected format or voice, and
nonfinite samples fail the request. Audio and request text are never saved.
Closing the connection stops generation; `DELETE /v1/requests/{id}` also cancels
queued or active work.

## Verification

`python -m pytest -q` covers readiness, protocol validation, cancellation,
reference discovery and the Pocket-only migration without loading a model.
The synthetic sentence checker supports the worker's declared sample rate:

```sh
python scripts/cloned_voice_acceptance.py --base-url http://127.0.0.1:8091 \
  --voice narrator --label baseline --report /path/outside/repo/baseline.json
```

This checker performs live synthesis and recognition. Queue it through Core's
heavy-work procedure before execution. It validates streamed frames and keeps
only text and timings; ASR differences select cases for listening and do not
prove missing syllables. Actual worker quality, microphone, playback and audible
Stop require separate device acceptance.
