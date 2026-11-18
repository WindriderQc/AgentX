# Nestor ArtX

ArtX is the shared capability behind Nestor’s animated personal and family standby screens.
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
Both Super Dad and Famille submit their own browser observation with each text
or voice turn. Personal Hermes receives the same Core-recomputed facts as other
transports; selecting an engine does not detach the screen from its conversation.

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
fixed panorama geometry and occlusion captions. Installation, a real model choosing its tool
and physical-device acceptance require separate evidence.


## Readable sky and shared geometry

`nestor-sky-layout.js` owns the fixed panorama, inverse projection, reserved
face/clock/conversation zones and bounded caption placement. Core and the
production painter use this same module. The panorama does not jump when the
Moon crosses the face: its disc is omitted and it gets no caption; Core still
reports its true position and the reason it is hidden. Other bodies
intersecting reserved zones, below the horizon or outside the panorama are also
omitted and unnamed: only drawn objects are labelled. A constellation is named
only when at least two thirds of its figure segments are drawn clear of the
reserved zones. Captions are small unboxed sans-serif text with a thin dark
halo, sized from the viewport height (bodies about 1.2 %, constellations in
italics and compass marks about 1.05 %, with a 10–11 px floor). Captions avoid
those zones and one another; crowded labels
are suppressed rather than painted over the face. Layout uses the CSS viewport,
independently of the canvas pixel ratio.
The face zone reserves the full assembled portrait with a conservative envelope
that follows the viewport aspect ratio, including its forehead and chin. It is
a layout reservation, not a measured pixel silhouette. The laboratory outlines
these same computed zones instead of maintaining separate CSS geometry.
Only the four cardinal marks (N, E, S, O) are shown, dim, just under the
horizon. They stay centred on their projected azimuth; a direction under the
portrait or otherwise obstructed is omitted instead of moved.
Body captions leave clearance around their discs, including the enlarged Sun
and Moon, so their labels do not cover a lunar crescent or the solar disc.

The Sun and Moon may appear in daylight, using Core's existing computed
positions. Daylight planets and stars are omitted. The Sun and Moon carry explicit
enlargement captions. The Moon's illuminated side uses the Sun's local tangent direction,
with the panorama's angular scaling. The sky palette follows the Sun's height
in half-degree cache bins. Decorative daytime specks and the fixed sun glow
are absent. ISS retains its separate framing and simulation badges.

ArtX receipts carry bounded viewport dimensions. Core recomputes Sun, Moon and
planet positions, disc visibility, caption presence and reserved-zone occlusions
from its original snapshot. The read distinguishes a visible disc from an
occluded body identified by a caption. It includes the computed Sun and Moon
positions even when their discs are not drawn. This remains a browser visibility
report, not a camera measurement or proof of human attention.

Weather freshness uses the oldest available observation, retrieval and snapshot
time. After thirty minutes the weather line discloses its age; after three hours
it reports unavailable weather and removes weather effects. A recent retrieval
cannot make an old observation current. Sky calculation time and weather
observation time remain distinct in Nestor's context.

## ArtX laboratory

`/artx-lab`, linked from Workshop, drives the production `NestorAmbient` painter
with an explicit UTC time, synthetic observer, weather, observation age, panorama
centre, aspect ratio and pixel ratio. The preview and manifest are permanently
labelled as simulation. The face is represented by its reserved rectangle;
this page does not load the avatar, microphone or family display controller.

`GET /api/artx/lab/sky?at=<ISO-time>&lat=<latitude>&lon=<longitude>` calls Core's
existing `skyView` calculation only, with validated explicit coordinates and a
date between 1900 and 2050. It reads no home location, weather, picture library,
model or display registry and persists nothing. Family-pinned devices cannot
reach the page or calculation endpoint. No new runtime or deployment setting is
required.

Static preview uses a fixed clock and seeded particles; submitting the same
scene produces the same canvas pixels in the same browser environment. Weather
animation is optional and reduced-motion retains a still frame. The bounded
last 300 draw samples show p50/p95 for the background painter only; they do not
measure the full frame, avatar, kitchen compositor or real device acceptance.

CPU fixtures cover geometry, collisions, daylight, expired observations, Core
read parity and laboratory route validation. `core/tests/browser/artxLabJourney.cjs`
checks the real canvas, repeatable pixels, day/night, stale weather, aspect ratio,
pixel ratio, mobile and reduced motion without live services or inference.
Use `ARTX_REPORT_DIR` outside the checkout and optionally `ARTX_CHROME` for a
local Chromium executable. Real sky accuracy, kitchen readability and full
avatar/compositor performance require their own physical reception.
