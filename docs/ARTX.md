# Nestor ArtX

ArtX is the shared capability behind Nestor’s animated family standby screen.
Core owns the source snapshots, scene selections and display reader. The browser
draws the scenes and reports visibility. The portable
[ArtX chapter](../skills/agentx/references/artx.md) of the agentx skill guides
scene selection and explanation; it is also the idle task's system prompt.

After two minutes of visible, quiet full-screen standby, the browser requests
one silent Nestor task. Core offers only `artx_present` to the existing routed
voice model, with the family-safe weather, computed sky and available picture
identifiers. The choice is `sky`, `paint`, `weather` or `rest`. A task runs at
most once per fifteen minutes across displays. It creates no speech, image,
personal memory or business task. Existing ISS notices and alert visits retain
their rules; paintings require a completed scene choice. An unavailable model
leaves the live weather/sky background in place without claiming a painting.

Conversation, typing, hidden tabs and leaving full-screen standby reset the
idle interval. Core checks household activity before dispatch and before
applying a choice. An admitted inference settles through its native owner;
activity invalidates its choice rather than aborting shared compute. Live model
qualification from coding sessions still uses the heavy-work queue.

`GET /api/family/ambient?displayId=…` returns an opaque `snapshotId` alongside
the existing family-safe data and the current scene selection. The browser
records a receipt only after drawing, and includes the current receipt and
a recent previous moment with the next conversation request. Core re-derives
planet names, altitude, azimuth, panorama orientation and normalized screen
positions from the issued snapshot. It shares the panorama and visible-body
functions with the renderer. Browser-supplied text, labels and planet positions
are never accepted as source data. A receipt attests the browser’s report of
visibility, not camera pixels or human attention.

The sky source retains all computed `planetPositions`, including planets below
the horizon, separately from the renderer's horizon-filtered `planets` candidates.
ArtX supplies their direction, altitude and `aboveHorizon` independently of
`rendered` and `screen`. Weather, a hidden display or an off-panorama planet
does not remove its calculated outdoor position. A negative altitude means it
cannot currently be seen outside; an unavailable or expired source cannot
establish its current position. Screen left/right is not a compass direction.

The conversation receives that bounded ArtX context on both Core inference and
native agent transports. Its exact evidence is retained under
`presentationContext.artx` on the canonical turn. Hidden displays, weather-masked
sky, planets outside the panorama and expired observations remain explicit.
The recent previous receipt helps explain a painting removed when talking
began. The reader never turns a new selection into proof of display.

Core’s MCP bus exposes `artx_read` and `artx_present` outside its memory-only
profile. The Core family engine offers those same handlers only when this
turn has a valid display observation; Core binds the display and request
identities, so the family model cannot choose another screen. Native runtimes
use only their actually installed tool catalogue. The idle task loads the
portable skill directly; installing a skill alone never installs tools.

The browser reconciles a lost idle response with the same request ID. Core
retains pending, selected and failed outcomes in bounded process-local display
state. Snapshots expire after twenty minutes and display receipts after three
minutes; after a Core restart old snapshot references refuse rather than
reconstruct or replay an uncertain task. Canonical conversation evidence
remains historical, not a current display read. Task outcomes and snapshots are
not a second persistent personal-task or memory store.

CPU fixtures cover the complete family-turn path, MCP and HTTP dispatch,
idle timing, interrupted results, response reconciliation, weather masking and
the panorama’s Moon avoidance. Installation, a real model choosing its tool
and physical-device acceptance require separate evidence.
