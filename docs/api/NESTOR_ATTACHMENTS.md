# Nestor conversation attachments

The full-profile personal Nestor composer accepts three files per message, each
at most 2 MiB: JPEG, PNG, UTF-8 text, Markdown, CSV, JSON and text PDFs. Documents
are limited to 24,000 extracted characters; PDFs also have a 20-page limit.
Unreadable, protected or textless PDFs and oversized documents are rejected,
never silently truncated. OCR, office formats, screen capture and family uploads
are not implemented. Playground screen capture is tracked in
[#2](https://github.com/WindriderQc/AgentX/issues/2).

Files stay in the browser draft until Send. A message is required. On success,
the draft clears; on failure it remains available for correction/retry. Repeating
an identical upload in the same conversation reuses the stored attachment. Image
previews and document links return with the recent conversation after reload.

## Core contract

`runtimeServices.attachments.forConversation` binds the server-selected surface,
session, pack and scope. `upload`, `references`, `download` and `prepare` validate
that binding against the canonical conversation. Bytes and extracted text reside
in `conversationattachments`; user messages retain reference metadata only.
Downloads are private/no-store and documents are served as downloads, not HTML.
The surface exposes:

- `POST /api/voice-personas/private/sessions/:sessionId/attachments`, with
  `{ name, dataUrl }`, returning reference metadata.
- `GET /api/voice-personas/private/sessions/:sessionId/attachments/:attachmentId`.
- The existing turn endpoint accepts `attachmentIds` with the ordinary text.
- `GET /api/voice-personas/private/sessions/:sessionId/export` downloads the
  conversation and referenced original files as `agentx.conversation-export/v1`
  JSON. Files stream individually; unreferenced uploads are excluded.
- `DELETE /api/voice-personas/private/sessions/:sessionId`, with
  `{ "confirmation": "DELETE CONVERSATION" }`, erases the conversation content
  and every submitted file belonging to it. Active responses must finish first.

Attachments use the same bounded recent-history window as the conversation.
Within it, context exceeding 8 MiB of attachment bytes or 60,000 document
characters fails explicitly. Older attachments remain downloadable in history
but are not promised as unlimited model context. No attachment enters selected
notes, RAG or a tool automatically. A document is external data, not an authority
to execute its instructions.

Ollama's exact selected host/model must confirm `vision` before a request with
images is admitted. The model is not silently changed. Native OpenClaw images use
the [OpenResponses image protocol](https://docs.openclaw.ai/gateway/openresponses-http-api).
Core extracts supported documents once with the installed pdf-parse v2 parser
and sends their text as user content on both transports. Subsequent native turns
rehydrate bounded attachment data without replaying native-owned dialogue.

## Limits and verification

Core tests use disposable MongoDB, the installed PDF parser and mocked inference
and native transport. They do not qualify a real vision model, native Gateway,
phone camera or microphone; see [status](../STATUS.md) for open acceptance.

Recent personal conversations provide Export and Erase controls. Erasure removes
text, previews, native session keys, tool evidence and all files, including uploads
whose following inference failed. Only a content-free identity tombstone remains
to reject old native events. A failed file cleanup leaves the
conversation hidden and retries on the same deletion request or Core restart.
File upload, export and deletion serialize within the supported single-Core
writer topology; this is not a distributed lock for multiple Core replicas.

Submitted files otherwise have no automatic expiry. Removing a browser draft
selection does not erase an already-submitted upload. Separately saved memories,
native-provider copies and backups are outside conversation erasure. Back up the
attachment collection with canonical conversations; restoring an older snapshot
can restore previously deleted data and must be reconciled before use.

Disposable Mongo/HTTP checks cover export, scope boundaries, repeated deletion,
an in-flight upload and interrupted cleanup.

Conversation scoping does not authenticate a person on a shared child device.
Adult entry is the [parental session](../PARENTAL_ACCESS.md).
