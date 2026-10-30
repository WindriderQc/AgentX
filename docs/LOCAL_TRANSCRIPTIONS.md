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
A Mongo compare-and-swap admits only one active child retry per failed/cancelled
attempt, including clicks from different tabs with different keys. A crash between accepting a retry and inserting its child is repaired under
the already accepted identity. A lost reply reuses that child identity; a new deliberate retry waits for its terminal receipt.

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

Admission heartbeats run independently of potentially slow shared receipt
sweeps; they also renew immediately on startup/Mongo reconnection and never
start or replace native work. Expired admissions are not revived. Closing the page does not
affect execution. A Core restart observes the same
native receipt. If Core loses its workload heartbeat beyond the native lease
window, coordination can quarantine the resource: the UI shows an unresolved
receipt and does not launch replacement work. Use native workload recovery;
never clear quarantine solely because the reservation's estimated end passed.

A speech-service restart interrupts its active native job. Its exclusive
process lock, inherited by the downloader, proves the prior writer is gone before recording that interruption
as a failure and removing its temporary spool. On Linux the downloader binds
its lifetime to the speech parent with a parent-death signal and kills only its
owned session, including Deno, if the parent exits abruptly. This crash-path
contract is tested on Linux; Windows/macOS abrupt-child cleanup is not qualified. It never silently restarts a
download/model run. The owner can retry after Core confirms the terminal receipt
and resource release. Cancellation stays nonterminal while a native decoder is
still running, and is checked between decoded segments. A terminal receipt is
published only after temporary audio cleanup; the final cancellation check and
completion receipt share the cancellation lock. Cancellation intent is
durable in Core even during the dispatch race.

The interface reports downloading, decoding, transcription, cancellation or
reconciliation and elapsed time. It reports neither a fabricated percentage nor
a predicted completion time.

## Read the request path

The personal page shows the serial path using the conversation workflow's
node, LED and evidence-wire vocabulary. Its explanatory view starts no job.
Selecting a library entry follows that entry's receipts: URL acceptance, queue
and physical admission, native download, bounded decoding, Whisper, cleanup and
durable storage, then reading and on-demand TXT/SRT exports. Admission precedes
download in this implementation. Exports are not separate background jobs.

Animation follows a receipt observed within 20 seconds and stops on old or
unknown observations, cancellation, failure and historical completion. It is
not GPU utilization telemetry. Whole-job elapsed time uses persisted start/end
instants; per-stage durations are not recorded and are not fabricated. The
queue's existing presentation provides earliest start, timezone and wait reasons.

GET /api/transcriptions/status is a bounded, cached composition of the existing
speech model catalog, health, native capabilities and runtime coordination.
Configured model/device are labelled as configuration, not active inference.
The capability response adds metadata-only active long jobs and effective
download-disk budget; it neither loads a model nor exposes source URLs/text.
Older native services remain readable with activity explicitly unavailable.
Completed new receipts retain the decoder's model/device/compute evidence;
older results without it are labelled unattributed, not assigned today's model.
The current host label comes from Core's existing host registry when matched.

Language and timezone preferences stay in this browser's local storage. The
accepted request and schedule remain durable Core data. This page offers no
per-request model selector because the native service does not support one.

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

## YouTube solver dependency

"Restricted official solver" means the yt-dlp project's own companion package
`yt-dlp-ejs` (0.8.0, pinned transitively by the selected downloader), not a
YouTube-provided API or an OpenAI transcription component. The optional dependency
file selects `yt-dlp[default,deno]==2026.10.26`, `deno==2.9.8` and
`av==18.1.0`. EJS resolves ordinary public-player JavaScript media URL
signatures. Deno executes its locally installed code with yt-dlp's restricted
run options, without filesystem/network grants and with remote/npm component
downloads disabled. No login cookies, DRM, authentication, geographic-restriction
bypass or private video access is added. A refused video stays a visible failure.
See the [upstream EJS setup guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
