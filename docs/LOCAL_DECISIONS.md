# Local advisory decisions

Core exposes a bounded local classification prototype at `/api/decisions`.
It uses the existing Ollama inference executor and the `agentx-primary` pin.
No vendor account, new model download, separate inference server or additional
GPU is required. Actual latency and decision quality need local evaluation.

The two versioned policies are `notification-triage` and `specialist-routing`.
They return an advisory category. Nothing sends a notification, invokes a
specialist, changes a task, or grants permission. Existing workflows keep
their current behavior; no recurring caller or runtime tool is installed.
Specialist categories describe capabilities, not installed agent identities.

## API

`GET /api/decisions` reads the policy catalogue without touching inference hosts.

`POST /api/decisions/evaluate` accepts exactly `policy` and `state`:

```json
{
  "policy": "notification-triage",
  "state": "A routine report completed successfully; no action is requested."
}
```

State is text, at most 8,000 characters and 16,000 UTF-8 bytes. The HTTP body
is capped at 24 KiB. Each request makes at most one generation call, with
a 30-second signal budget including routing, a 96-token output bound and a
JSON schema limited to that policy's choices. Native context checks can refuse
inputs below these limits when the principal lane has a smaller context.

The success envelope contains `requestId`, `contract`, `policy`, `policyVersion`,
`choice`, `abstained`, `mode: "advisory"`, `actionsExecuted: false`,
`confidence: null`, `calibration: "not-evaluated"`, actual inference identity
and duration. `review` is an explicit abstention. Model-generated confidence
is not presented as a calibrated probability. JSON schema and validation enforce
the shape of the answer; they do not establish its semantic correctness.

Malformed, unknown, tool-bearing, truncated, nonterminal or mismatched results
refuse. An unavailable principal, workload claim, pin mismatch or admission
refusal retains the shared executor's boundary. No timeout or refusal triggers
another generation, a cloud fallback or another model selection.

## Local execution and ownership

Core resolves `agentx-primary` through the existing effective routing snapshot,
requiring a pin-aligned model and context. Only an explicit local/LAN Ollama
origin is accepted. Native OpenClaw selections and cloud-tagged model names
are refused. This assumes the registered Ollama endpoint is operated locally;
an operator must not configure it as a forwarding proxy to an external service.
The executor rechecks pins, native workload ownership and inference admission.
The prototype does not override context, residency or the installed model.

The API retains Core's private-LAN boundary and browser-origin guard. A consumer
must supply only context already authorized for its own workflow. This endpoint
reads no mail, memory or family data itself and is not added to a runtime's
tool catalogue. All responses use `private, no-store`. Decision state and answer
text are not persisted by this capability. Existing payload-free inference
telemetry carries the generated request ID as its correlation ID. The ID is
for attribution, not a durable replay/idempotency guarantee. On a lost response,
inspect native inference evidence; do not automatically repeat the call.

## Qualification

CPU tests use synthetic state and fake model responses. They validate local
target enforcement, structured output, cancellation, refusals and API behavior;
they do not establish classification quality, speed or savings on a real model.

Before live evaluation, submit a stable, session/issue-linked diagnostic request
through [Core's heavy-work queue](HEAVY_WORK_QUEUE.md). Name the current principal
host, the estimated duration and the permitted start window. Retain native
admission and the operator result/release receipt. Keep examples, reference
labels and results private outside Git. No live qualification or automatic
workflow integration is implied by the source prototype.

For notification triage, review missed urgent items and unnecessary
interruptions; compare against the existing rules. For specialist routing,
review category errors and abstentions. Measure end-to-end latency and output
validity in both cases. Exercise French and English wording, ambiguous requests,
instructions embedded in state, and unavailable/busy hosts. Keep observation
separate from action until the specific workflow has acceptable evidence.
