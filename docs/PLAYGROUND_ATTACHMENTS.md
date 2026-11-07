# Playground screen capture

The Playground composer offers **Capture screen** in a supported browser on
HTTPS or localhost. Each click invokes the browser's `getDisplayMedia` chooser;
the person chooses the screen, window or tab. AgentX requests video only,
takes one PNG snapshot and stops every returned track. It retains no live
screen feed. Browser support and a denied/cancelled chooser have separate
messages. **Cancel capture**, a conversation change and leaving the page
discard an unfinished capture. A browser chooser may need to be closed by the
person; a late grant after cancellation is stopped without taking an image.

The static preview stays in the browser draft until **Send**, alongside a
required text message. Each snapshot must fit the canonical 2 MiB limit, with
at most three per turn. An oversized snapshot is rejected explicitly; choose
a smaller window. **Remove snapshot** discards the draft selection. No captured
bytes are placed in local storage, RAG, selected notes or an image archive.

## Core ownership and transport

Playground reuses `conversationAttachmentService`, `ConversationAttachment`
and the ordinary canonical `Conversation`; there is no screenshot store.

- `POST /api/history/attachments` accepts `{ name, dataUrl, conversationId? }`.
  The server resolves the owner. For a new conversation, the browser also sends
  a stable UUID `requestId`; retries resolve to the same empty canonical
  conversation. The response contains `{ conversationId, attachment }` using
  the existing reference metadata. Existing-conversation uploads retain the
  canonical content/name deduplication rule.
- `GET /api/history/:id/attachments/:attachmentId` reads only a file belonging
  to that visible, active Playground conversation and server-resolved owner.
  Surface sessions, internal probes, foreign and archived conversations are
  excluded. Responses are private/no-store and use the existing file formats.
- `/api/chat` and `/api/chat/stream` accept `attachmentIds` for the current
  user turn. Previous user turns retain canonical reference metadata. Core
  checks ownership and prepares image bytes through the same attachment
  service for Ollama and the native OpenResponses transport. The exact selected
  local host/model must confirm vision support; images are never silently
  dropped and no vision model is selected automatically.

Successful and failed/stopped turns retain references for history, retry and
subsequent context. Original bytes stay outside the transcript. Attachment
context retains Core's existing bounds: 24 distinct references, 8 MiB of file
occurrences and 60,000 extracted document characters per exchange. Overflow
refuses explicitly. The history-context preference can omit prior turns;
current-turn attachments still accompany the current message.

## Lifecycle and verification

Upload failures retain the draft and text for retry. An upload whose response
is lost may already exist in Core; repeating the same capture reuses it.
Changing conversations during upload aborts the browser request and prevents a
late receipt from entering the next view. A submitted upload is retained even
if the following inference fails or its browser draft is removed. There is no
automatic expiry. A first upload can leave an empty **Screen capture**
conversation in History, including when its response is lost.

Deleting the conversation through History erases all its uploads, including
unreferenced files, under the canonical durable owner barrier. Already admitted
uploads must settle first. An unknown database write outcome retains that
barrier and requires the existing recovery procedure; erasure is not reported
as complete. Replaying the original capture identity after erasure cannot
recreate that conversation. Backups and native-provider copies remain outside
this erasure boundary. Human identity continues to rely on the existing
[private LAN access boundary](PARENTAL_ACCESS.md).

The integration tests use disposable MongoDB and synthetic PNGs. The browser
journey `core/tests/browser/playgroundScreenCaptureJourney.cjs` uses production
capture/composer/history modules in Chromium with its fake media device and
scripted API responses; it calls the native `getDisplayMedia` and never captures
a personal desktop. Separate injected cases exercise denial, cancellation,
late permission grants, page exit, upload failure and conversation changes.
HTTP tests exercise the actual canonical upload/download/erasure routes.
These checks do not establish manual chooser/OS permission acceptance on a real
device, a vision model response, container qualification or deployment.
