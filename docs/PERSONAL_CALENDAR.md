# Personal calendar and repeating actions

Nestor uses one shared capability contract from authorized personal runtimes.
`personal_calendar` on the existing Core MCP bus reads available calendars,
lists bounded event windows, reads an event and creates an event or reminder.
Google Calendar owns the event, its recurrence and its standard notifications.
Core stores no mirror calendar or scheduled copies of the series. Creating an
event does not send invitations. Editing/cancelling events is outside this
tool's current contract.

## Native connection

Core invokes `integrations/google/calendar_provider.py` on the credential host
through its existing SSH transport. `GOOGLE_CALENDAR_SSH_TARGET` and
`GOOGLE_CALENDAR_REMOTE_ROOT` optionally select it; the defaults are the existing
`OPENCLAW_INVENTORY_SSH_TARGET` and `SECRETARY_MAIL_REMOTE_ROOT` or
`CODING_DISPATCHER_REMOTE_ROOT`. The helper uses the installed gog CLI's native
account/keyring, with a closed Calendar method policy. It accepts no caller
endpoint, executable or OAuth token. No Google credential enters Core or the
browser. Standalone hosts can configure `GOOGLE_GOG_PATH`, `GOOGLE_ACCOUNT` and
`GOOGLE_KEYRING_PASSWORD_FILE`; otherwise the helper reads the existing
gmail-secretary connection settings. Calendar write scope must be authorized.

Expose `personal_calendar` in the personal runtime's Core MCP filter and tool
policy, and install the reviewed `skills/agentx-core/SKILL.md`. Runtime copies
contain no domain logic. Keep family profiles and the memory-only endpoint
unchanged. Allow a tool timeout of at least 70 seconds for native reconciliation.

## Creation and recovery

An event needs a title, start and end. Dates create all-day events with an
exclusive end. Datetimes require explicit offsets; the IANA time zone controls
local recurrence. A reminder needs an exact start and defaults to one minute,
free availability and a popup at the start. `reminderMinutes` overrides Calendar
defaults; an empty array disables notifications. Google handles the recurrence,
including DST. `repeat` selects daily, weekly (optional weekdays), monthly or
yearly, with interval and optional count or until. It is optional on creation.

Every Calendar creation requires a stable UUID `requestId`. Its hash is the
Google event ID and its normalized payload fingerprint is stored in private
Google event properties. A retry first reads that ID and checks the fingerprint;
a concurrent insert conflict is read back. Changed content under the same key
refuses. Transport loss retains the identity. A cancelled event is never
recreated by replay. The native Google result is the receipt; a configured
notification is distinct from verified device delivery.

## Actions to check off

Existing personal tasks remain in Core and retain their existing review and
worker boundaries. `add_personal_task` accepts an optional stable `requestId`
(recommended for all agent captures) and `repeat`. Captures use a unique partial
index; concurrent retries return one task and changed payloads refuse.

Repeating tasks need `dueAt`, retain their first schedule anchor, and expose
their repeat configuration through the existing list/briefing. Completing one
with its exact `expectedDueAt` advances the same task to its next future
occurrence, preserving local wall time and skipping missed dates. Monthly dates
that do not exist are skipped. Count/until exhaustion closes the task. A replay
of the last completed occurrence cannot advance it twice; stale concurrent edits
still use the existing task revision fence. Clear `repeat` to stop repetition;
`stopRepeat: true` explicitly closes the whole action. A task deadline alone
does not create a Calendar event or deliver a notification.

## Verification

Isolated Mongo tests cover captures, concurrent retries, recurring completion
and stop behavior. Calendar service and host fixtures cover dates, DST, native
series payloads, reminders, recovery, collisions and provider errors. Existing
memory-profile tests keep the narrow bus unchanged. Runtime tool discovery,
queued model execution, native Google writes and device notification delivery
are separate acceptance observations. Use disposable calendar resources for
provider checks and retain identities/receipts outside public Git.
