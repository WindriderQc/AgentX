# Native questions in the personal Nestor conversation

Core retains a native question observed for the exact accepted personal work and
presents an explicit form in its work feed. The native question and its answer
remain owned by OpenClaw. Selecting and submitting the form records a human
intent in the existing Core WorkState; an ordinary voice reply, model text or a
caller header does not authorize a resolution.

The bridge applies to personal OpenClaw work in native mode with its exact Main
attempt. Family, Hermes, text, Open and other surfaces keep their existing routes.
The private session boundary is the existing LAN access contract; the form does
not identify a person, establish adult identity or grant an agent more authority.

## Availability

The feature defaults off. `PERSONAL_CONVERSATION_QUESTIONS_ENABLED=true` permits
new observations and effect admissions in Core. The personal harness requires
these private, explicitly configured fields:

| Field | Meaning |
| --- | --- |
| `questionGatewayUrl` | Explicit native `ws:` or `wss:` endpoint, without credentials in the URL |
| `questionDeviceStateDir` | Absolute existing native client root containing its `client/credentials.sqlite` identity |
| `questionDeviceToken` | Existing device-token restricted to `operator.questions` |
| `conversationWorkToken` | Existing Core work callback credential |
| `agentxUrl` | Existing Core endpoint for that callback |

Provisioning or approving the device is a separate operator action. The product
never creates an identity, pairs a device, increases a grant or changes an
instance. Secret values and identity stores stay outside the public repository.

The harness loads the public `openclaw/plugin-sdk/gateway-runtime` client. It
uses the native signing and credential owners in read-only mode and only the
configured device-token. There is no HTTP resolution, CLI, shared-secret,
default-identity or alternative-credential fallback. Core's existing HTTP
continuity transport can trigger an operation by its retained Core reference;
it cannot nominate arbitrary answers or a native session. The harness must
consume a previously accepted Core intent through the work callback first.

The native connection must authenticate with exactly `operator.questions` and
advertise `question-conditional-resolve-v1` in its hello capabilities. The bridge
refuses missing configuration, an unsupported SDK or a missing native capability.
A package version alone does not establish support. The installed Gateway and
device acceptance remain separate from source validation.

Only ordinary bounded forms are supported: one to three questions, up to sixteen
options per question, single or multiple selection and ordinary free text.
Secret/store-bound questions and resource or other unsupported inputs remain
unavailable here. No secret-store content is projected. Unavailability is visible
without an enabled submit control; a last observed form can remain visible with
its controls disabled.

## Identity and effects

The observed form retains the immutable work request hash, attempt, native
session/run, question ID, incarnation and complete question hash. Work revision
is concurrency metadata, not an intent version. A pending incarnation admits at
most one retained Core decision. The explicit request UUID is also the original
native resolution UUID.

OpenClaw generates a fresh opaque incarnation for each question entry. The
bridge requests it explicitly, and requires `expectedIncarnation` on resolve and
lookup. Native authorization, requester liveness and session/source guards still
run. The manager compares the incarnation at the effect boundary; a successor
with the same public ID and identical content refuses the old intent. Core does
not present a pre-read hash comparison as an atomic native condition.

Core persists the accepted intent and its complete payload through the existing
conversation owner before transport. The adapter's callback atomically consumes
one effect admission. Network I/O runs outside retryable Mongo mutation
callbacks. Concurrent identical HTTP deliveries share that admission; a changed
payload under the same UUID refuses.

After admission, a timeout or missing response permits only lookup with the
original question ID, incarnation and resolution UUID. Neither a new question,
a new resolution UUID nor an automatic resolve retry compensates for uncertainty.
`question.waitAnswer` uses both `expectedIncarnation` and
`includeResolutionId:true`. A missing receipt after native grace, purge or
restart stays unknown. A replacement is reported separately.

A decision retained before any effect admission can be resumed explicitly with
its same UUID. The Core admission gate rechecks current availability; disabling
the bridge refuses a new send even if the adapter still has a valid device.
Already admitted decisions retain lookup authority. The browser journals only
references before submission, preserving lookup behavior after reload without
retaining answers in browser storage.

## Context, polling and erasure

The accepted form answer remains in canonical conversation context as reference
data, separately labelled with its native delivery outcome. An accepted answer
with an unknown native receipt is not described as delivered or as new business
permission. Main's existing relay/return attribution and complete context remain
intact.

Work-feed polling observes active attempts independently of completed history.
Native reads share a bounded polling budget; pending decisions outside the recent
periodic reconciliation set remain available through their exact lookup route.
Polling never starts inference or resolves a question.

Canonical conversation erasure removes question payloads, references and intents.
Late callbacks cannot restore them or admit another effect. A native effect
already admitted before erasure may still settle with its native owner; erasure
is not a cancellation receipt. Voice Stop, work controls and answering a native
question retain their distinct meanings.
