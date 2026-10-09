# Optional VoxCPM2 voice

VoxCPM2 is an optional cloned voice for the speech service. Kokoro stays the
default engine and Windows SAPI stays available. Selecting VoxCPM2 changes the
speech engine and its configured reference, nothing else: personas, memory and
the conversation belong to AgentX Core.

## Worker

Run the optional worker in a separate Linux CUDA environment using
`requirements-voxcpm.txt` (PyTorch 2.8 CUDA 12.8 was tested). The speech
service's own environment needs no additional package. Download the VoxCPM2
weights and keep the chosen reference WAV outside the repository. Start it from
this directory, at the same revision as the speech service:

```sh
python -m app.tts.voxcpm_server --model-path /path/to/VoxCPM2 \
  --reference-path /path/to/voice-a.wav --prompt-text-path /path/to/voice-a.txt \
  --voice nestor-a \
  --bind LAN_ADDRESS --port 8092
```

### Diagnose clipped or added sentence endings

The defaults remain compiled inference, combined reference and transcript
continuation, seed 42, `min_len=2`, and a softened final chunk. The worker
accepts one opt-in change at a time: `--reference-only` removes transcript
continuation, `--no-end-fade` sends the last chunk unsoftened,
`--no-optimize` skips compilation, and `--seed` / `--min-len` change generation
parameters. These are startup flags; restart a managed worker to apply them.
`--reference-only` affects every voice served by that worker, so use separate
workers when voices need different cloning modes. Do not pad punctuation to
force extra audio: it can make the model add words.

From this directory, compare a fixed set of 53 synthetic French sentences
through the speech service's consumer route:

```sh
python scripts/voxcpm_ending_acceptance.py --base-url http://127.0.0.1:8091 \
  --voice VOICE_ID --label baseline --report /path/outside/repo/baseline.json
```

The checker validates every streamed PCM frame and its completion counts,
transcribes an in-memory WAV, and writes text and timing only. It does not save
waveforms. `--only 1,2,29,30` repeats selected cases. Keep reports outside
Git. ASR mismatches select clips for listening; they do not prove a missing
syllable. Check short replies and long clauses by ear, compare first-signal
latency with the baseline, and test a real conversation through the page before
adopting a mode. A duration-only automatic retry is unreliable for variable
speaking rates and cannot retract audio already streamed to a listener.

One worker can serve several voices with one loaded model: `--voices-dir DIR`
reads every `<id>.wav` reference there, with an optional exact transcript
`<id>.txt` (continuation) and display label `<id>.name`; `--voice` then names
the default. `/health` lists the served `voices` (`id`, `name`), and the voice
catalog offers each one in both languages. Adding a voice means adding its files
and restarting the worker, which warms every reference before reporting ready.
`VOXCPM_VOICE` must be one of the served ids; `VOXCPM_VOICE_NAME` labels it only
when its reference has no `.name`.

`--prompt-text-path` points to a file holding the reference's exact words. With
it the worker continues the reference instead of only cloning its timbre.
Reference-only cloning may improve unstable endings while changing accent or
pacing, so qualify the choice by listening to matched clips. Keep the
transcript next to the reference, outside the repository.

WSL2 on a Windows voice host is a supported Linux environment: the worker
shares the host GPU, and `127.0.0.1:8092` inside WSL is reachable from the
speech service. Triton needs a C compiler (`CC`). Compiled, the worker runs at
about twice real time on an RTX 5070 Ti; the uncompiled path is slower than
real time and stutters when streamed.

Use persistent `TORCHINDUCTOR_CACHE_DIR` and `TRITON_CACHE_DIR` directories and
`TORCHINDUCTOR_COMPILE_THREADS=2` on a shared host. The worker uses one GPU and
one inference execution context, including warmup. Cold compilation can take
several minutes. `/health` reports `ready:false` until warmup completes; text
and audio are not saved. The worker serializes requests and bounds each output
queue to two frames, stopping generation when a client cancels or disconnects.

## Pocket TTS worker (processor)

Pocket TTS serves the same worker protocol on the processor, with no graphics
memory. The speech service reaches it through the same `VOXCPM_BASE_URL`, and
callers keep selecting `tts_provider:"voxcpm"`: that id names the cloned-voice
lane, whichever engine the worker runs. Run one worker or the other on a port.

Install `requirements-pocket.txt` in its own environment. Cloning from a
reference needs the gated weights: accept the terms on the model's page and log
in on the worker's host (`hf auth login`); these are two separate steps. Start
it from this directory, at the same revision as the speech service:

```sh
python -m app.tts.pocket_server --voices-dir /path/to/voices --voice nestor-a \
  --bind LAN_ADDRESS --port 8092
```

It reads the same voices directory (`<id>.wav`, optional `<id>.name`); a
transcript beside a reference is ignored, because this engine clones from the
audio alone. Reading a reference takes about ten seconds per voice at startup;
`/health` reports `ready:false` until every voice has spoken once.

`--eos-threshold` defaults to 0. The model's own default (-4) ended about one
sentence in three early with cloned voices on the qualifying host; lower values
cut more. A cloned voice copies the rhythm of its reference: build references
from continuous speech, with pauses shortened, or the voice pauses the same way.
Very short replies are this engine's weak case; check them by ear.

Measured on one processor thread of a desktop host: first audio in about
0.2 s and about 1.7 times real time. Qualify each host and voice separately.

## Cloning a voice

1. Record two to five minutes of natural, conversational speech from the
   consenting speaker in a quiet room, mono, at least 24 kHz. Answering spoken
   questions sounds more natural than reading.
2. Build 20–30 s references: shorten pauses longer than about 0.35 s and
   normalize the level. Keep the exact transcript of each reference; correct
   Whisper's errors by hand, because continuation uses those words.
3. Synthesize the same phrases from each candidate reference and compare them
   blind before choosing. Check intelligibility by transcribing the output.
4. Start the worker with the chosen `--reference-path` and `--prompt-text-path`,
   then set `VOXCPM_VOICE` and `VOXCPM_VOICE_NAME` in the speech service's
   environment.

References, transcripts and recordings identify a person: keep them outside
the repository, memory and retrieval stores, on the voice host only.

## Keeping the worker running on Windows

WSL shuts a distribution down shortly after no Windows process holds it, so a
worker started with `nohup` stops when its `wsl.exe` exits. Start it in the
foreground from a logon scheduled task (hidden PowerShell running
`wsl.exe -d <distro> -- bash <worker script>`), with restart-on-failure and no
execution time limit. The worker script should stop an older worker before
starting, so re-running the task reloads the reference.

## Selecting the voice

Set these in the speech service's environment, then restart it:

```dotenv
VOXCPM_BASE_URL=http://LAN_ADDRESS:8092
VOXCPM_VOICE=nestor-a
VOXCPM_VOICE_NAME=
VOXCPM_TIMEOUT_SECONDS=60
```

`VOXCPM_VOICE_NAME` is the label voice pickers show for the configured
reference (for example a person's name); blank keeps "Voice A · VoxCPM2".

Leave `TTS_PROVIDER` unchanged to retain the existing default. A caller selects
the voice per request: `/api/tts`, `/api/tts/stream` and `/v1/audio/speech`
accept `tts_provider:"voxcpm"` and `voice:"nestor-a"`. `POST /config` accepts
`{"tts_provider":"voxcpm"}` to make it the service default once
`VOXCPM_BASE_URL` is configured. Only set `TTS_PROVIDER=voxcpm` if the operator
wants it as the startup default.

VoxCPM2 keeps commas, semicolons and colons inside their sentence to retain
pronunciation context; the other engines synthesize sentence by sentence.
`/api/tts` and `/v1/audio/speech` return one complete audio file;
`/api/tts/stream` returns the frames as they are generated.

## Readiness

`/api/tts`, `/api/tts/stream` and `/v1/audio/speech` check the worker before
synthesis whenever a request selects VoxCPM2, its configured voice included. A
worker that is unreachable, still warming up, or not serving `VOXCPM_VOICE`
answers `503` with a short JSON `error` before any audio or stream starts, so
the caller can choose another voice; the service never substitutes one. The
check reads the worker's `/health` with a 2 s timeout, shared with
`/api/voices`. A ready answer is reused for 10 s, so most requests add no probe;
a failure is reused for 2 s, then probed again beside the next request, which
still answers `503` at once: a stopped worker can take the whole timeout to
refuse, and the caller's other voice must not wait for it. The request after a
recovered probe gets the worker. A worker that fails after a ready answer still
ends the stream with an `error` event.

## Stream and interruption

Worker `POST /v1/stream` accepts `id`, `text`, and `voice`. The NDJSON response
has `meta` (`voix-pcm-v1`, mono `f32le` at the rate the worker declares: 48 kHz
for VoxCPM2, 24 kHz for Pocket TTS), numbered base64 PCM `audio`
frames, then `done` with exact frame/sample totals or `error`. Missing
completion, reordered frames, wrong format or voice, and nonfinite samples fail
the request. Audio is never stored.

Closing the connection stops generation; `DELETE /v1/requests/{id}` also cancels
queued or active work. When a caller leaves `/api/tts/stream`, the service
closes its request to the worker and signals this endpoint.

## Verification and deployment scope

`python -m pytest -q` in this directory covers worker readiness before
synthesis, incomplete streams, cancellation while waiting, queued and active
cancellation, recovery and unchanged defaults, without a model or a GPU.
Validate the actual worker on its host separately. What a listener hears in a
browser or on a device needs its own listening check.
