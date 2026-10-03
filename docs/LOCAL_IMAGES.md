# Local image generation and editing

The full profile serves `/images` and `/api/images`. Core owns the requests,
GPU reservation, recovery journal and archived results. ComfyUI executes a
server-owned workflow on a local worker. The service is disabled until an
external worker manifest and `IMAGE_ARCHIVE_DIR` are configured.

One request can create an image or edit up to two PNG/JPEG references. The
browser offers a prompt, qualified profiles, resolution, progress, cancellation
and the original output. A generated image is decoded, checked against the
pixel budget, archived and hashed before Core returns an artifact URL. The
configured archive may be part of the household photo library; generation and
private operation receipts still require adult access at the parental gateway.

## Configure a worker

Run a qualified ComfyUI version outside the AgentX checkout. The client uses
the v0.38.0 prompt identity, job-scoped cancellation, history and memory APIs.
Install only the model files the selected profile requires. Record their source
revision, digest and license in the private instance manifest or receipt.
Do not import unreviewed custom nodes or API nodes for this service.

Use a dedicated worker that only Core submits to. Disable API nodes and saved
prompt metadata. Keep it on loopback or a private container bridge reachable
by Core; do not publish the ComfyUI UI or submit prompts manually while Core
owns the worker. On hosts sharing RAM with other services, qualify the cache
and offload policy with those services present.

Set `LOCAL_IMAGES_CONFIG` to the manifest path **inside Core**, and mount that
file read-only through the instance Compose override. Set `IMAGE_ARCHIVE_DIR`
to writable external storage. A minimal manifest is:

```json
{
  "workerUrl": "http://127.0.0.1:8188",
  "ollamaHosts": ["http://127.0.0.1:11434"],
  "defaultProfile": "klein",
  "timeoutMs": 900000,
  "drainMs": 60000,
  "profiles": {
    "klein": {
      "label": "FLUX.2 klein 4B",
      "family": "klein",
      "diffusion": "flux-2-klein-4b.safetensors",
      "encoder": "qwen_3_4b.safetensors",
      "vae": "flux2-vae.safetensors",
      "weightDtype": "fp8_e4m3fn",
      "steps": 4,
      "maxPixels": 1048576,
      "license": "Apache-2.0"
    }
  }
}
```

Container loopback is the container itself. Select a bridge or LAN address
when the worker is native on another host. Endpoints accept explicit private
IP addresses or localhost; public URLs and URL credentials are refused.
`ollamaHosts` must name **every managed endpoint consuming the image GPU**,
using the same endpoint identities as Core inference. It does not discover
physical GPU aliases or stop games, voice workers or other unmanaged consumers.

The `qwen21` family uses Qwen-Image-2.1 ConvRot INT8 diffusion and encoder
files, its own VAE, Euler/simple sampling and lossless CPU prefix caching.
Its license is research/evaluation: label that profile explicitly. Enable
only the resolution and step budget qualified on the actual host. References
are decoded, bounded to an 8:1 aspect ratio, and their editing pixel budget is explicit; a large source photo
does not silently create a 12 MP render. The browser prepares smaller JPEG
reference copies; Qwen editing follows the first reference's framing at the
selected pixel budget, with a margin for its 32-pixel rounding.
It preserves the generated output at full
quality; upload originals remain the conversation attachment capability's job.

## Request and recovery contract

`POST /api/images/operations` requires `actionKey`, `prompt`, optional `profile`,
`width`, `height`, `seed` and a `references` array of at most two base64 images.
Dimensions must be multiples of 32, 256–2048, under the profile's pixel limit.
Use a fresh action key for an explicit new variation. Replaying the same key
and input returns its existing operation; changed input returns 409.

Accepted requests return 202 immediately. `GET /api/images/operations/:id`
reports progress; `.../:id/image` serves the verified archive. Core reserves
the configured endpoints, records the exact resident snapshot before mutation,
unloads them, computes, releases worker memory, and restores the original
digests, contexts, lifetime policy and GPU placement before marking completion.
It does not edit benchmarked Modelfiles or context settings.

An offline worker is refused immediately. A busy GPU has only the bounded
admission/drain window; expiration requires a new explicit request. There is
no dormant queue waiting for a computer to return. Only one operation owns a
worker slot. A restart marks unfinished operations `unknown` and never retries
the prompt. Unknown outcomes retain the GPU recovery fence.

`POST .../:id/cancel` records cancellation and the executor uses job-scoped
cancellation. Acknowledgement is not terminal proof: Core observes the original
history before restoring. `POST .../:id/archive` retries only output import
after an archive failure; it never calculates another image. `POST .../:id/recover`
adopts an expired recovery lease only when the original image job is proven
terminal, then restores and imports its original result. A pre-generation
mutation with an uncertain outcome requires native operator reconciliation;
an empty queue, timeout or HTTP 404 never clears that fence.

The native `local_image` tool is optional and available only to the private
owner through the Nestor harness. It returns a durable operation and studio
link. Nestor ends that turn to release its LLM reservation on a shared GPU;
status in a later turn can return the archived image. It does not block the
same agent loop waiting for its own GPU or silently use a cloud provider.
This asynchronous tool does not promise automatic completed-image delivery
to Telegram.

## Qualification

Measure cold and repeated generation, editing, multiple references, actual
RAM/VRAM peaks, cancellation, offline refusal, storage recovery and restored
Nestor inference. Compare the same graph and seed across hosts before changing
placement. A file's byte size is not its pipeline's minimum VRAM. Passing code
tests is separate from container, GPU and real-device acceptance.
