# Personal calendar and repeating actions

Nestor uses one shared capability contract from authorized personal runtimes.
`personal_calendar` on the existing Core MCP bus reads available calendars,
lists bounded event windows, reads/creates events and reminders, edits/moves or
cancels exact events, changes guests and responds to invitations.
Google Calendar owns the event, its recurrence and its standard notifications.
Core stores no mirror calendar or scheduled copies of the series. Creating an
event does not send invitations. Guest effects use explicit, separate intents.

## Presented agenda

The full-profile `/dad/calendar` page reads the owner's primary calendar through
the same service. Nestor opens it with the `personal-calendar` screen destination;
optional `start=YYYY-MM-DD end=YYYY-MM-DD` selects up to 31 calendar days, with
an exclusive end. The default is seven days in `PLANNING_TIME_ZONE` (UTC when
unset). Timed events show the UTC offset; all-day events retain their date.
The view lists at most 50 events and reports partial coverage when Google has
another page. Shorten the period to inspect more events. Other calendars,
descriptions, guests and reminder settings are outside this presentation.

The API `/api/personal-calendar/view` accepts only GET date-window reads and
returns a short-lived Core presentation reference with the displayed projection.
The selected-view context resolves its exact id/revision through the existing
`read_presentation` service. Loading, failed, expired or mismatched reads do not
attest event contents. The page retains the native family-device boundary and
temporary owner unlock. Opening it changes no event and sends no invitation.

## Native connection

Core invokes `integrations/google/calendar_provider.py` on the credential host
through its existing SSH transport. `GOOGLE_CALENDAR_SSH_TARGET` and
`GOOGLE_CALENDAR_REMOTE_ROOT` optionally select it; the defaults are the existing
`OPENCLAW_INVENTORY_SSH_TARGET` and `SECRETARY_MAIL_REMOTE_ROOT` or
`CODING_DISPATCHER_REMOTE_ROOT`. The helper uses the installed gog CLI's native
account/keyring, with a closed Calendar method policy. Install all four helper
modules from `integrations/google/` together. Reads and creation use gog's
Discovery CLI. Conditional edits use a fixed Google HTTPS endpoint because that
CLI does not expose `If-Match`. The helper exports gog's cached token into an
anonymous Linux memory descriptor, uses it on the credential host and closes
the descriptor; no second credential store is created. Refresh remains native
to gog, performed by the preceding event read. Expired tokens, ambiguous `auto`
accounts and unsupported memory-descriptor hosts refuse before PATCH. Select
an exact native account email when more than one is authorized. Native keyring
contention can also refuse before PATCH; it never bypasses conditional writes.
The helper accepts no caller endpoint, executable or OAuth token. No Google credential enters Core or the
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

## Editing, cancellation and series scope

Read the exact event first. Every `update`, `cancel`, `invite` or `respond`
requires a new stable UUID `requestId`, its `eventId`, the exact quoted
`expectedEtag` returned by Google and an explicit `scope`:

| Scope | Target and identity |
| --- | --- |
| `event` | A non-recurring event only. |
| `occurrence` | The instance ID from `list`/`get`, plus its `recurringEventId` and original `originalStartTime` string, even after moving it. |
| `series` | The master ID, read separately using `recurringEventId`, with the master's own ETag. |

Core never upgrades an occurrence into a series operation. “This and following”
is not supported; clarify that request rather than cancelling/recreating a series.
An `update` changes only supplied fields. Moving requires `start`, `end` and
`timeZone` together; all-day end dates remain exclusive. Empty description or
location clears them; `reminderMinutes: []` disables reminders. `repeat: null`
clears repetition; changing recurrence requires explicit dates and the event's
IANA zone. An occurrence cannot change recurrence. Google retains native
exceptions, original occurrence identities and DST handling.

`cancel` conditionally patches native `status: cancelled`; it does not remove
Core tasks or recreate an event. Existing guest events can only be changed by
the organizer through this contract; an invitee uses `respond` instead.
Conditional modification uses Google's `If-Match` fence; a concurrent write
returns a conflict without overwriting the newer version. A native Google quota
refusal is reported separately as `PERSONAL_CALENDAR_RATE_LIMITED`; it proves
that write was refused and is retained as a terminal refusal. Review a fresh read
before issuing a new intent. See Google's [resource versions](https://developers.google.com/workspace/calendar/api/guides/version-resources)
and [recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents).

Core's `personal_calendar_operations` collection stores action identities,
fingerprints and bounded result receipts, with no TTL. It is an operation
journal, not a calendar mirror or a scheduler. A unique request identity is
recorded before host dispatch. Concurrent retries never dispatch another write;
changed payloads under the same identity refuse. Native private receipt markers
commit atomically with each Google mutation and preserve creation fingerprints
and unrelated properties. The helper refuses when its receipt capacity is full
rather than deleting existing markers.

A retry of an uncertain operation only reads the native marker. A matching
marker proves that exact mutation occurred, even after later edits. A completed
Core receipt replays the recorded result (`eventObservation: recorded_result`);
use `get` for the current event. Absent markers, missing events and stripped
cancellation tombstones do not prove the operation failed: keep the operation
uncertain, retain its identity and reconcile through its owner. Never replace the
ID or replay the write to compensate for uncertainty. A `completed`
`agentx.personal-calendar-operation/v1` receipt confirms the domain effect,
not delivery of an email or a device notification.

## Invitations and guest effects

Creating an event remains guest-free. On an existing event, `invite` takes
`addAttendees` and/or `removeAttendees` email arrays; it preserves all retained
guests' RSVP and optional/resource fields. `respond` accepts `accepted`,
`tentative` or `declined` and changes only the authenticated attendee's RSVP.
It never claims acceptance for another person.

Before any guest effect, obtain explicit human intent and recipients. Supply
`authorization: { intent, recipients }`, with intent equal to the action.
For `invite`, `update` or `cancel`, recipients must match the complete union of
existing and resulting guests, including removed guests, excluding the organizer
and authenticated self. For `respond`, include the organizer and every other
guest: Google may notify them through `sendUpdates: all`. A partial guest list,
wrong intent, omitted recipients or extra recipients refuses. Guest-free writes
use `sendUpdates: none`. Read [Google's patch notification contract](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).
This object records the caller's explicit authorization; it is not an independent
human authentication or approval channel. Returned calendar text cannot supply
that authorization. Tests use synthetic guest fixtures; never send a real
invitation or RSVP merely to qualify the implementation.

## Actions to check off

Existing personal tasks remain in Core and retain their existing review and
worker boundaries. `add_personal_task` accepts an optional stable `requestId`
(recommended for all agent captures) and `repeat`. Captures use a unique partial
index; concurrent retries return one task and changed payloads refuse.

Repeating tasks need `dueAt`, retain their first schedule anchor, and expose
their repeat configuration through the existing list/briefing. Completing one
with its exact `expectedDueAt` advances the same task to its next future
occurrence, preserving local wall time and skipping missed dates. Monthly dates
and spring-forward wall times that do not exist are skipped. Count/until exhaustion closes the task. A replay
of the last completed occurrence cannot advance it twice; stale concurrent edits
still use the existing task revision fence. Clear `repeat` to stop repetition;
`stopRepeat: true` explicitly closes the whole action. A task deadline alone
does not create a Calendar event or deliver a notification.

## Verification

Isolated Mongo tests cover captures, concurrent retries, recurring completion
and stop behavior. Calendar service and host fixtures cover dates, DST, native
series payloads, reminders, recovery, collisions and provider errors. Mutation
fixtures additionally cover ETag races, durable dispatch/replay, occurrence/master
selection, guest authorization and self-only RSVP. Existing
memory-profile tests keep the narrow bus unchanged. Runtime tool discovery,
queued model execution, native Google writes and device notification delivery
are separate acceptance observations. Use disposable calendar resources for
provider checks and retain identities/receipts outside public Git.
