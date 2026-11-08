# Browser voice in the Hermes dashboard

This dashboard-only plugin connects a PC or phone microphone and speakers to
the existing Hermes terminal chat. AgentX's shared browser capture, personal
voice preferences, transcription proxy, streaming speech ladder and audio
player remain the implementation used by `/dad`. The native terminal keeps its
composer, tools, approvals, transcript and provider selection. There is no
second agent or conversation store.

The microphone opens only after **Parler à Nestor**. Captured speech uses the
saved personal microphone, language and endpointing settings. A transcript
enters the current native composer as one paste followed by a separate Enter,
after the terminal acknowledges output. Combining them can leave a draft in
the native TUI. A missing acknowledgement fails visibly without replay; pause,
disconnect or a changed chat prevents the pending Enter. Only that chat's
assistant events become spoken text. Pause closes browser capture and playback;
it does not erase the native conversation or retry its work. Capture pauses
while a reply plays. Native keyboard interruption remains available. The
terminal's own `/voice` controls still describe server-side terminal audio;
the browser controls are the toolbar above it.

## Installation boundary

The plugin consumes Core on the same browser origin (`/api/voix/*`,
`/api/voice-personas/catalog` and existing shared browser assets). Service
addresses, profile names, voice selection, credentials, units and receipts are
instance choices. No provider secret is copied into the plugin or browser.
Enable `agentx-voice` only for an intended private owner profile.

The current upstream SDK does not pass a chat's PTY context to slot plugins.
`host.patch` adds a generic `context` property to slots and gives the two chat
slots a `chat` object with scoped `submitText`, `interrupt`, channel and
connection state. Stale profile/session generations refuse input. It also
preserves a named profile's explicit symlink alias when identifying the
running dashboard; native homes and histories are not moved.

These are generic host seams, without AgentX speech logic. The plugin does not
patch Hermes at load time. Prepare an isolated native checkout at reviewed base
`1744a19e0df568c647e4f3ff9c37f2a284a282fb`, then run:

```sh
python3 integrations/hermes/dashboard-voice/prepare_host.py /path/to/native-checkout
```

The preparer refuses a different revision or dirty checkout. Use the native
package manager to prepare that checkout (`python hermes pm install`), build its
web assets with the deployment's prefix, and validate before changing any unit.
Start the checkout with its PM-generated `.hermes/bin/hermes` command. The
instance pins its source/build and supplies the profile; this adapter never
selects a model.

Register this directory as a native user plugin and add `agentx-voice` to the
profile's `plugins.enabled`. Select the principal's own named profile when
launching the dashboard. Switching to another profile stops capture and prevents
late transcripts from reaching that profile. Lost transport never resends a
prompt: the native chat may still complete it and is the place to check.

## Validation

```sh
node --test integrations/hermes/dashboard-voice/test/*.test.cjs
python3 -m unittest discover -s integrations/hermes/dashboard-voice/test -p 'test_*.py'
```

The standard native-tools integration runner includes both commands. The native
web patch also has a runtime slot-context test. Verify the actual dashboard,
permission denial, device cleanup, scoped reconnect and playback using a
controlled browser microphone before claiming integration acceptance. Actual
STT/TTS/model tests use the instance heavy-work queue and native admission.
Physical-device microphone quality and speaker acoustics require owner use.

The controlled browser journey uses a native preview with a deliberately
unusable inference endpoint, mocks the PTY/event transport and speech service,
and drives real browser capture/playback with a synthetic microphone. It checks
permission denial and release on navigation without a model call:

```sh
AGENTX_HERMES_PREVIEW_URL=http://127.0.0.1:9121 \
  AGENTX_PLAYWRIGHT_MODULE=/path/to/playwright \
  node integrations/hermes/dashboard-voice/test/browser-journey.cjs
```

Keep preview configuration and reports outside Git. Never point this mocked
transport journey at a model-enabled personal deployment as a substitute for
live acceptance. A real speech check has its own queued, bounded receipt.

The native paste check executes only the TUI's local `/help` command, using the
actual host context against an authorized chat page. It verifies that one
paste and one acknowledged Enter execute without a second keypress; it opens
no microphone and requests no model:

```sh
AGENTX_HERMES_NATIVE_URL=https://example.invalid/hermes/chat \
  AGENTX_PLAYWRIGHT_MODULE=/path/to/playwright \
  node integrations/hermes/dashboard-voice/test/native-paste-journey.cjs
```
