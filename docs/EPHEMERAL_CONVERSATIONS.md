# Ephemeral personal conversations

Nestor's personal conversation settings offer **Conversation éphémère** for
future exchanges. The supported execution path is **AgentX / Ollama**. Selecting
it explicitly retains normal Core model routing, pin context and admission.
There is no model-name override and no automatic native-to-local fallback.

OpenClaw and Hermes retain native histories and memory outside Core. Their
current transports do not expose a verified ephemeral contract, so an ephemeral
request to either refuses before dispatch. The interface offers an explicit
**Utiliser Ollama direct pour l’éphémère** choice. Ollama direct supplies the same
capabilities as an ordinary AgentX conversation; it does not run Hermes/OpenClaw
tools. A native profile without memory needs a separately implemented and
qualified runtime contract before it can support this switch.

## Choice, submission and transitions

The existing `open` mode and `inference.open` selector default to ephemeral.
Standard conversations retain their ordinary default. A manual ON or OFF wins
for that browser conversation. Returning to Standard leaves an already ephemeral
choice ON. A new conversation recalculates the default; privacy is never saved
in shared browser preferences. Existing retained conversations remain retained
when resumed.

The session identity binds the server's policy. Each typed/voice submission
captures its choice before asynchronous preparation. A mismatched request
refuses; a later checkbox change cannot change the current exchange's storage,
stream completion, interruption, retry or timing callback. The existing active
turn map serializes privacy changes with persona changes and generation.

`POST /api/voice-personas/private/sessions/:sessionId/privacy` creates a successor
context when the policy changes. Enabling ephemeral can copy the bounded prior
retained dialogue into volatile context; it never deletes the source history.
Explicitly disabling it creates an empty retained generation context with a
new identity. No transient messages, attachments, tool results, derived notes,
recaps, native session keys or displayed-page context are transferred. The
browser clears its reference board/reviewer/work state and shows a context-break
notice while keeping its temporary transcript visible. A late callback stays
bound to its original identity. Turning OFF never imports the ephemeral segment.

Ephemeral context is scoped to the personal surface and an opaque server-minted
identity held by that page. It is not advertised in history or exports and has
no durable restoration mechanism. Separate tabs receive separate identities;
no authenticated per-human identity is invented on this private-LAN surface.
The existing family device restrictions and server-selected scopes remain in
force. Someone with the exact live identity has the same LAN access boundary
as the existing application; this feature is not a new authentication system.

## Persistence inventory

This describes the source contracts, not an installed-service audit. Ordinary
retained conversations keep their existing storage and ingestion behavior.

| Path / source | Ephemeral contents and lifetime | Durable remainder / boundary |
| --- | --- | --- |
| `conversations/ephemeralSessions.js` | Session, bounded active dialogue, presentation/tool results and uploaded/decoded files stay in process RAM. Sliding idle expiry is 30 minutes; timers also delete unused contexts. At most 64 contexts and 16 MiB of serialized content per context. Restart loses them. | Reserved `ephemeral-` identities never fall through into durable writes after expiry, deletion or restart. No spill-to-disk cache. Expiry bounds Core context, not browser/OS memory. |
| Browser `conversation-privacy.js`, `conversation-page.js`, voice loop | Choice and submission snapshots stay in this mounted page. Transcript and audio review/playback buffers remain temporary browser data. | No privacy choice, transient transcript or identity is added to local/session storage. Ordinary engine/voice/listening preferences remain. Reload creates a fresh conversation; browser/OS recovery and swap are not secure erasure guarantees. |
| Core `surfaceConversationService`, Conversation transcript pages/chunks, history/search/export | Ephemeral creation/turns use the volatile adapter, never these writes. Recent/history/export do not expose transient dialogue. | Prior retained data remains unchanged, under existing explicit erasure rules; no new retention limit or retroactive purge. |
| Personal notes, `nestor-knowledge.retrieve`, owner/family memory search | No note lookup, memory RAG retrieval or automatic family-context lookup on an ephemeral turn. | System/persona instructions, deterministic safety rules and current dialogue still apply. There is no documentary RAG path left active in this turn handler. |
| `conversation-executor`, recaps, `brain`, conversation works | No confirmed-recap read, reviewer advice, background-review scheduling, work intake/dispatch or canonical transcript ingestion for ephemeral content. | Ordinary retained paths still work. Existing ingest/review jobs cannot discover RAM-only rows; there is no transient job or durable retry queue to replay. Explicit external domain actions remain their owner's data. |
| `conversationAttachmentService`, attachment/original routes | The same validators, PDF decoder and prompt preparation run against volatile file buffers. Reduced photos/documents are not inserted into ConversationAttachment. Original photos are not archived; the original-upload endpoint acknowledges only the already volatile working copy. | A file deliberately attached to a subsequent retained exchange is a new submission. Prior durable attachments retain their existing lifecycle. PDF parsing uses request-local buffers. |
| Core inference telemetry (`trustedRuntimeServices`, `trustedRuntimeTelemetry`, InferenceLog) | No prompt, reply, reasoning, file bytes or tool payload is recorded. Provider error strings are replaced by `ephemeral_inference_failed`, including deferred stream settlement. | Host/model/task identifiers, durations, token/character counts, hashed prompt-cache structure, outcome codes and admission metadata can persist. InferenceLog defaults to 30 days via `INFERENCE_LOG_TTL_DAYS`; deployment/index configuration owns the actual retention. |
| Native inference admission / runtime coordination | The ephemeral policy reaches the admitted attempt. Unknown completion retains native quarantine and its exact identity; the saved reason is a generic marker. | Coordination records retain native ownership and recovery rules, including records deliberately without TTL. No reset, replacement launch or quarantine clearing is introduced. |
| Household application errors / logger | Turn failures log a fixed content-free marker. | Normal Core request logs record paths without query text, not request bodies. Application files rotate at five 5 MiB files; Docker's default `json-file` output rotates at three 10 MB files (`OPERATIONS.md`). Existing operator overrides and gateway logs remain operator-owned. |
| Ollama prompt/KV cache | The local model receives the active context through the unchanged admitted inference path. | Runtime caches may retain prompt state independently of browser/Core context expiry. No model unload, cache flush, secure erasure or installed-runtime retention guarantee is promised. |
| Core voice upload/synthesis proxies | Recognition uploads and synthesized speech pass through request buffers; synthesis requests explicitly send `save: false`. Responses use the existing streaming/no-store contracts. | The configured speech service owns its actual implementation, temporary files and logs. Core does not add transcription or speech archives. Its supported stateless endpoints are listed in `voice/transport.js`. Native device sessions are a separate path. Browser speech fallback, when enabled and consented to, can send audio to the browser vendor; its existing disclosure remains visible. |
| Display/image/sound actions | Current permissions, safety checks, request identities and native service admission remain in force. Tool results in the conversation stay volatile. Web image lookup and Data media-file lookup (`visuals.fromFiles`) remain available; neither is embedding/RAG retrieval. Lookup failures in an ephemeral turn log only a generic code. | A requested image is an external action: the image owner can retain its prompt, operation, artifact and receipt, including its own error logs. Generated-media relay can archive the displayed image. Web/image/media services may retain their queries/results. Ephemeral mode does not erase or undo these effects. |
| Hermes/OpenClaw native journals, histories, memories and compression | Ephemeral dispatch is refused rather than sending a privacy instruction to a retaining runtime. | Ordinary native conversations retain their existing journals and receipts. Core cannot silently suppress their memory/tools with a prompt. |

The visible notice discloses active RAM context, no history/memory/RAG, external
tool effects, technical metadata and independent model/speech retention. This
is an application retention mode, not a promise that every service or operating
system leaves no trace. No production service, credential, network setting or
preexisting data is changed by the implementation.

## Local verification

All inference and external actions in these tests are synthetic CPU fixtures.
No live model, benchmark, render, model load/unload or deployment is needed.

```sh
node --test core/surfaces/household/test/ephemeral-policy.test.js
node core/scripts/run-jest.js --runInBand \
  tests/integration/household-ephemeral.test.js \
  tests/integration/household-persona.test.js \
  tests/integration/household-hermes.test.js \
  tests/services/conversationAttachmentService.test.js \
  tests/unit/trustedRuntimeServices.test.js \
  tests/unit/inferenceAdmissionService.test.js \
  tests/unit/trustedRuntimeTelemetry.test.js
node core/tests/browser/nestorEphemeralJourney.cjs
```

The browser test accepts `AGENTX_PLAYWRIGHT_MODULE`,
`AGENTX_BROWSER_EXECUTABLE` and `EPHEMERAL_BROWSER_OUTPUT_DIR`. It mounts the real
page, exercises default/manual choices, explicitly chooses Ollama, changes the
checkbox during a response, checks the future retained submission and reloads
without restoring ephemeral messages. Its HTTP services are fixtures; the
integration suite separately inspects real isolated Mongo collections and spies
on actual memory/RAG/recap entry points. These tests do not qualify the installed
speech service, native tools, physical microphone/playback or production logs.
