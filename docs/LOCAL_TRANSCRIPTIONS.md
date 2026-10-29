# Local long transcriptions

The full profile exposes `/transcriptions` in Personal. A public YouTube video
can start as soon as resources are available or no earlier than a chosen date
and time. The browser sends an ISO instant with an explicit offset and retains
the selected IANA timezone. Past dates, nonexistent DST times and ambiguous DST
wall times refuse. A scheduled start is not a completion-time promise.

Core owns the searchable personal library in MongoDB's `transcriptions`
collection. Results contain text, detected language, actual audio duration and
segments with their source timestamps. The reader links to those source times;
text and SRT exports use the same result. Personal content and native receipt
files are runtime data, never source-controlled assets. This follows the
instance's existing private-LAN personal-surface boundary; there is no new
account, public hosting or external transcription provider.

## Execution and durability

This capability reuses HeavyWorkQueue, its monitor, dispatch fence, physical
resource aliases, workload admissions and release receipts. A request has one
immutable client identity and one queue identity. A repeated click, refresh or
lost HTTP answer reuses that identity. A retry of a confirmed failed/cancelled
attempt creates a linked identity; an unresolved attempt cannot be retried.

The same speech service and faster-whisper model serve interactive and long
recognition. Long work does not unload Ollama models, change pins or select a
fallback speech host. The UI explains that voice responses can be slower.

Before crossing the dispatch fence, Core checks the native capability endpoint
for the required private receipt owner and downloader dependencies, without
loading a model. An older/unconfigured speech service leaves the request visible
and unstarted. The native speech service accepts a small JSON request at
`POST /v1/audio/long-transcriptions`. It persists an SQLite receipt before
starting a bounded background job. Core polls
`GET /v1/audio/long-transcriptions/:queueId`; cancellation uses
`POST /v1/audio/long-transcriptions/:queueId/cancel`.
The receipt and original speech origin are retained for reconciliation, rather
than holding an HTTP request open for an entire video. Native start is
idempotent by identity and exact URL/language.

Closing the page does not affect execution. A Core restart observes the same
native receipt. If Core loses its workload heartbeat beyond the native lease
window, coordination can quarantine the resource: the UI shows an unresolved
receipt and does not launch replacement work. Use native workload recovery;
never clear quarantine solely because the reservation's estimated end passed.

A speech-service restart interrupts its active native job. Its exclusive
process lock proves the prior worker is gone before recording that interruption
as a failure and removing its temporary spool. It never silently restarts a
download/model run. The owner can retry after Core confirms the terminal receipt
and resource release. Cancellation stays nonterminal while a native decoder is
still running, and is checked between decoded segments. Cancellation intent is
durable in Core even during the dispatch race.

The interface reports downloading, decoding, transcription, cancellation or
reconciliation and elapsed time. It reports neither a fabricated percentage nor
a predicted completion time.

## Configuration

Both sides are disabled until explicitly configured. Keep origins and paths
in the private instance configuration.

Core:

- `TRANSCRIPTIONS_ENABLED=true`.
- `VOIX_BASE_URL`: the existing primary speech origin; long jobs never use
  `VOIX_FALLBACK_URL`.
- `AGENTX_RUNTIME_RESOURCES_JSON`: the existing native physical-resource map
  must associate the speech origin with its real GPU, alongside every other
  consumer of that GPU. An unmapped speech origin refuses before creating a
  task. Apply topology changes only after existing admissions are settled.
- `TRANSCRIPTION_RESOURCE_HOSTS`: optional JSON array of additional resource
  origins to hold. The primary speech origin is always included.
- `TRANSCRIPTION_RESERVATION_MINUTES`: configurable planning window, default
  180 minutes. This is an operational resource reservation, not an ETA or a
  transcription timeout. A running/uncertain attempt stays fenced past it.
  An expired reservation that never started stays visible with a message;
  cancel it and make a new attempt.

Speech host:

- Install `integrations/voix/requirements-long.txt` in the existing speech
  environment. It adds yt-dlp, its matching offline EJS solver, restricted Deno and PyAV, not a second model. Python 3.11 or newer is required by the pinned downloader.
- `VOIX_LONG_TRANSCRIPTIONS_DIR`: absolute private directory outside the
  repository, writable only by the speech owner and included in private
  backup policy. SQLite receipts and results remain until the operator's
  explicit retention policy removes them. Do not expose this directory as
  static assets. One speech process owns it.
- `VOIX_LONG_DECODED_BYTES`: default 536870912 bytes. The budget is for the
  decoded 16 kHz mono float32 waveform (64000 bytes/second), independently
  of compressed file size. It permits about 2 h 20 min by default. Account for
  model memory, decoder buffers and array copies in addition to that budget
  before increasing it; this default is not a hardware benchmark.
- `VOIX_LONG_DOWNLOAD_BYTES`: default 2147483648 bytes on disk. The downloader
  also preserves at least 512 MiB free. The actual decoded sample count is
  checked while writing PCM to disk before Whisper can allocate a long array.
  Temporary audio is removed after success, failure or cancellation.

Long URL requests avoid the conversation upload path entirely: there is no
32 MiB multipart ceiling, Express raw body copy or full compressed-file copy in
RAM. The existing short-utterance transport limit is unchanged.

## Download boundary

Only normalized HTTPS YouTube video URLs are accepted; playlists, arbitrary
sites, live streams and authenticated/private-cookie access refuse.
yt-dlp selects the best available native HTTPS audio track without MP3
conversion. If YouTube does not expose a supported direct track, the attempt
fails visibly; no cookie, DRM/access workaround or external downloader runs.

All downloader HTTP traffic goes through an ephemeral loopback CONNECT proxy.
Only HTTPS port 443 on youtube.com, googlevideo.com and ytimg.com (including
subdomains) is permitted. Every tunnel resolves all addresses, rejects any
nonpublic address and connects to a verified numeric address without a second
DNS lookup. Redirects need another permitted tunnel. The downloader ignores
environment proxies and does not load CLI configuration, browser cookies,
plugins or remote components. Its official packaged EJS solver runs in Deno without filesystem or network grants; remote/npm script fetching is disabled. Downloader cancellation terminates its owned process group, including that solver. PyAV's local media decoding
uses only file/pipe protocols.

YouTube still sees the audio download. Local recognition is not an anonymity
claim. The speech model must already be installed for offline recognition.

## Verification

Run the native repository test launcher, using its isolated MongoDB:

```sh
cd core
npm ci
npm run test:prepare
npm test -- --runInBand --runTestsByPath tests/unit/transcriptions.mongo.test.js tests/unit/transcriptionTimeUi.test.js tests/unit/heavyWorkQueueLauncher.mongo.test.js tests/unit/heavyWorkQueue.mongo.test.js tests/unit/heavyWorkQueueEvidence.mongo.test.js
npm run build
```

Speech tests use fake models and a generated nonprivate WAV fixture:

```sh
cd integrations/voix
python -m pip install -r requirements-test.txt -r requirements-long.txt
python -m pytest -q
```

`core/tests/browser/transcriptionJourney.cjs` uses real rendered Core routes,
isolated Mongo, native queue/admission and a synthetic speech receipt source.
Provide Playwright on the test module path, optionally
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and set `TRANSCRIPTION_REPORT_DIR` outside
Git. It covers desktop/mobile, invalid URL, timezone/DST/past dates, double click,
refresh, HTTP-server restart, actual stages, errors, cancellation, retry,
timestamped reading and subtitle download. It downloads no YouTube video and
loads no model. Real YouTube extraction and a real speech GPU still require
separate admitted qualification with an owner-approved small fixture.
