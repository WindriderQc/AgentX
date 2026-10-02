# PsyX in AgentX

The full profile serves the PsyX 2.5 conversation UI at `/psyx`. Psychological
domain rules and longitudinal state live in `core/src/domains/psyx`; generic
conversation persistence/lifecycle and admitted inference are Core capabilities.
No separate PsyX server, database client or inference router starts here.

`PSYX_ACCESS_TOKEN` configures the existing private access code. Without it,
private APIs stay locked. `PSYX_ACCESS_MODE=trusted-network` preserves the explicit
network-only option; it disables locking and is an operator decision.
Loopback bypass is off by default because Core may sit behind a local proxy.
`PSYX_LOOPBACK_BYPASS=true` is an explicit instance exception. Cookies remain
HttpOnly/SameSite Strict, random, expiring and invalidated on process restart.
Locking hides the application, aborts active browser inference and clears the
visible transcript/state. An opaque recent-session ID can remain in localStorage.

Conversations use Core's collection with owner `surface:psyx:default` and prompt
`psyx`. Ordinary default-user history cannot read them. PsyX state keeps the
existing `psyxstates` domain collection, with a unique owner index. Startup does
not merge or delete duplicate state records. No PsyX text is automatically added
to selected notes or RAG, and inference itself does not persist another transcript.

After each completed turn, a background review rereads the conversation with the
longitudinal state. It runs through Core's admitted inference on the router task
`PSYX_REVIEW_TASK` (default `deep_reasoning`), never writes into the transcript and
is never cancelled once admitted; turns completing meanwhile coalesce into one
follow-up review. It stores a digest per conversation, which later conversations
receive as `recentSessions`, and at most five memory proposals with evidence.
Proposals stay pending and outside the prompt until the user accepts (optionally
edited) or rejects them; settled proposals are not proposed again. The interface
always shows when a review runs and what it proposed. `PSYX_AUTO_REVIEW=false`
disables it.

The review also recommends the stance (talk, analyze, challenge, plan) and depth
(normal, deep) of the conversation's next turn, with a one-sentence reason. A
request whose stance or depth is `auto` (or absent) applies that recommendation,
defaulting to talk and normal before the first review; an explicit choice always
wins. The stream announces the applied stance, depth and reason in a `control`
event before the first token.

A deterministic check (`core/src/domains/psyx/safety.js`) looks for explicit crisis
phrasing in each user message, in French and English. A match overrides the stance
(talk, normal depth, lower temperature), adds a safety instruction to the system
context and streams a `safety` event; the interface then shows Québec resources
(911, 9-8-8, 1 866 APPELLE, 811) as call links. It does not depend on the model.

A new conversation opens with a recap of the last session digest and the open
experiments. The model is told it may connect to them in one sentence and ask how
a planned experiment went, without forcing it.

Normal and deep requests use Core's configured `analysis` and `deep_reasoning`
routes. Review those routes against the accepted PsyX model/host before real
private inference. There is no PsyX-owned provider: a routing failure does not
trigger a PsyX-owned fallback.

Voice remains optional: `PSYX_VOICE_MODE=voix` and an explicit `VOIX_BASE_URL`.
Recordings and synthesized audio stay transient. Browser voice preferences are
request-scoped and never change shared VoiX configuration. Actual microphone,
speech, model and live-device acceptance are separate from the portable tests.

Archive/restore, rename, export, explicit permanent transcript deletion, state
reset and longitudinal experiments remain available. A source response is saved
only after the admitted stream has a terminal result and settled host receipt.
The transcript is never silently sliced; request
context remains bounded to the latest 40 messages and the domain text budget.

`eval/` holds a small set of synthetic scenarios, one per therapeutic skill, and a
runner that builds each reply exactly as the chat does (prompt, stance, state,
safety check), asks Core's router for it and scores it with deterministic checks
and a judge model grading each criterion. Run it against the LAN gateway before
and after a prompt or model change and compare:

    AGENTX_BASE_URL=https://<core> node core/surfaces/psyx/eval/run.js --repeat 2 --out before.json
    AGENTX_BASE_URL=https://<core> node core/surfaces/psyx/eval/run.js --repeat 2 --compare before.json

Reports stay outside Git. The default judge is the router's `deep_reasoning`
model; when it is also the reply model, `--judge-model` gives a second opinion.
