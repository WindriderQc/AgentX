# Hermes in the personal conversation

Nestor's personal surface can use Hermes for its native agent loop while Core
keeps the visible conversation, selected context and receipts. The browser's
existing microphone, local transcription, segmented speech, interruption and
reactive avatar remain in use. Family and LLMx scene sessions cannot select
Hermes. Existing conversations keep their selected engine.

## Configuration

Set `HOUSEHOLD_HERMES_URL` to the private Hermes API origin and
`HOUSEHOLD_HERMES_TOKEN` to its server-only bearer credential. Optionally set
`HOUSEHOLD_PERSONAL_CONVERSATION_BACKEND=hermes` for new personal conversations.
The catalog exposes only whether Hermes is configured, never its token or
endpoint. The browser retains its own explicit engine choice.

Use the native Hermes gateway API (`/v1/runs`), which differs from its web
dashboard. Configure an isolated instance with its chosen provider, identity
and toolset. A Codex subscription connection belongs in Hermes' protected
native credential store. No OpenAI credential is passed to Core or the browser.
The operator chooses the fallback provider in Hermes; a local Core inference
endpoint retains Core's ordinary model routing and admission. Do not lock
each request to a provider/model when native fallback is required.

## Shared tools and usage guidance

Hermes consumes AgentX capabilities; it does not own a parallel tool library.
Follow [the shared capability contract](SHARED_AGENT_CAPABILITIES.md) when
developing tools from any coding client or runtime. Configure its native MCP
client against Core's private `/mcp` bus and explicitly select the toolset and
tools appropriate to the profile. Keep the narrower `/mcp/memory` endpoint for
memory-only consumers. Never expose the owner bus to a family profile.

An owner profile can select `personal_task_dossier` on Core's personal
`/api/consumers/nestor/v1/mcp` transport for
evidence-based personal-task review. Its read/propose operations are shared
with Local; the human decision remains in My day. Explicitly add the tool to
the native profile's selected MCP tools when installing this capability.
Discovery alone does not grant it to an existing Hermes or OpenClaw session.

Install the reviewed [AgentX Core skill](../skills/agentx-core/SKILL.md) through
the native Hermes skill mechanism. The same source is suitable for other
authorized clients. Native skill-reading tools and API toolsets must be enabled
explicitly; a copied skill alone does not activate Core tools. Keep native
sampling disabled unless the instance deliberately admits that extra inference.

Qualify discovery and real tool execution separately. Core's catalogue is not
evidence that the current Hermes turn can call it, and a configured MCP URL is
not a completed capability check.

## Turns and interruption

Core records a dispatch fence in the canonical conversation before admission.
The browser turn determines a stable idempotency key; native session affinity
uses a stable server-generated conversation header. An existing Hermes session
keeps its history, including compression, without retransmitting Core history
on every turn. Selected notes and reference material remain user-context data.

Public text deltas and content-free tool activity are translated into the
existing conversation stream. Internal reasoning and raw tool arguments/results
are excluded. The terminal native receipt supplies the actual model/provider
and usage, including fallback; a configured model label alone is insufficient.

An interruption requests the native run's stop and waits for terminal status.
An uncertain result retains its fence and blocks replacement. A lost acceptance
is reconciled using exactly the stored body and key, for at most fifteen minutes;
older uncertainty requires native-owner reconciliation before any new launch.
A completed turn whose stream was lost is recoverable from its terminal receipt.
Repeating the same latest browser identity returns the saved terminal result.
No Core-level retry through a different agent loop occurs.

Hermes retains its own native execution history on the operator's host. Core's
conversation erasure does not automatically erase that external native store.
The operator manages that store through Hermes' own lifecycle controls.

## Acceptance

CPU fixtures cover session persistence, family exclusion, private credentials,
streaming, local-fallback attribution, lost responses, idempotency expiry and
confirmed cancellation. Live conversation and speech checks require the
instance's heavy-work queue and native admission. Physical microphone/playback
acceptance remains distinct from synthetic tests and a healthy API listener.

## Stream completion and uncertain stops

A terminal native receipt completes any missing streamed suffix through the same
speech/display parser, without repeating the prefix. A divergent terminal answer
refuses success and retains its receipt. A terminal SSE event ends the subscription
even if the HTTP connection stays open; Core still reads the terminal status.

A failed stop response never authorizes another turn. Core can confirm the original
run by a fresh status read, without repeating the stop. If it remains uncertain,
the original fence stays held. Content-free error codes and run identity accompany
the error in server diagnostics, including failures after HTTP streaming began.
These fixtures do not establish the root cause of a historical transport failure.
