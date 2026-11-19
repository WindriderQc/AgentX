# Optional CPU backup speech peer

`docker/Dockerfile.cpu-backup` packages the existing speech-only service for
Linux CPU/int8 recognition and Kokoro ONNX synthesis. It contains no CUDA
wheels, conversation engine, microphone or speaker driver. The optional Vosk
spoken-controls adapter is copied from this same directory; no second checkout
or legacy native-loop setting is needed.

This image does not enable Core failover, install an instance service or manage
an on-demand lifecycle. Those optional operations remain tracked in
[AgentX #117](https://github.com/WindriderQc/AgentX/issues/117). Source tests and
HTTP discovery without models do not qualify recognition, audible synthesis,
resource consumption, cold startup or a real-device failover.

## Build

From the repository root:

```sh
docker build -f integrations/voix/docker/Dockerfile.cpu-backup \
  -t agentx-voice-cpu integrations/voix
```

The Dockerfile-specific ignore file admits only the speech Python source,
browser player and CPU dependency list. Instance `.env` files, preferences,
models, audio, Git history, tests and caches stay outside the image.
The process runs as the unprivileged `voix` user (UID 10001).

## Defaults and external state

| Setting | Image default |
| --- | --- |
| `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE` | `cpu`, `int8` |
| `WHISPER_CPU_THREADS` | `0`, faster-whisper's default; set an explicit CPU budget per instance |
| `TTS_PROVIDER`, `ONNX_PROVIDER` | `kokoro`, `CPUExecutionProvider` |
| `VOIX_APP_MODULE`, `VOIX_PORT` | `app.service:app`, `8091` |
| `VOIX_STARTUP_WARMUP` | `true`; loads recognition and synthesis at startup |
| `HF_HOME` | `/models/huggingface` |
| `KOKORO_MODEL_PATH`, `KOKORO_VOICES_PATH` | `/models/kokoro/kokoro-v1.0.onnx`, `/models/kokoro/voices-v1.0.bin` |
| `VOIX_PREFERENCES_PATH` | `/models/voix/voice-preferences.json` |

The recognition model remains the service's existing `WHISPER_MODEL` default
unless the instance sets it. Models download on first use when absent; keep
the `/models` volume external and writable by UID 10001. Saved speech choices
use that volume too. Long URL jobs remain disabled without their own explicit
configuration and optional dependencies.

## Isolated discovery check

This check starts the packaged HTTP service without loading or downloading a
speech model. It publishes no host port and has no outbound network:

```sh
docker run --rm --network none -e VOIX_STARTUP_WARMUP=false \
  agentx-voice-cpu python -c '
import json, subprocess, sys, time, urllib.request
server = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.service:app", "--host", "127.0.0.1", "--port", "8091"])
try:
    for attempt in range(40):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8091/health", timeout=1) as response:
                print(json.loads(response.read()))
            break
        except OSError:
            time.sleep(0.1)
    else:
        raise SystemExit("HTTP discovery did not start")
finally:
    server.terminate()
    server.wait(timeout=5)
'
```

A successful `/health` is liveness, not model readiness or acoustic acceptance.

## Optional spoken controls

Build with `--build-arg INSTALL_SPOKEN_CONTROLS=true`, then select
`VOIX_APP_MODULE=agentx_voix_controls:app` and mount an externally provisioned
Vosk model read-only at `VOIX_CONTROL_MODEL_DIR`. The adapter is included in the
image. Its readiness and recognition require their own qualification; model
files are never downloaded during the image build.

## Instance activation

After separate qualification, attach the peer to Core's private Docker network
without a published port, or bind a diagnostic port to loopback only. Configure
Core's existing `VOIX_FALLBACK_URL` only for that qualified peer; keep the degraded
voice notice and existing cancellation/stream failover rules. This image does not
configure a restart policy or an always-on backup. On-demand start/stop, stable
primary recovery and measured CPU/RAM limits remain separate instance work.

The image uses Kokoro voices. It does not clone a primary Pocket voice or provide
Windows SAPI. Qualify the consumer's actual voice choices and degraded ladder,
including a primary returning during a turn, before claiming continuity.
