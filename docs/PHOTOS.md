# Photos (Immich)

Core answers photo questions from a separately installed
[Immich](https://immich.app) server. Immich owns the library, the face groups,
smart search (CLIP), OCR and reverse geocoding; Core adds a small, bounded
route set under `/api/photos` so agents and pages ask Core instead of Immich.

Core holds the only Immich API key. Agents (OpenClaw, Hermes, Codex, Claude)
never get their own key: one credential, one set of scopes, and every call
logged by Core with its `x-service-caller`.

The [native Android USB importer](PHOTO_IMPORT.md) separately saves verified
originals through Core's import capability. It leaves the phone intact and
does not upload to Immich or start its indexing/analysis jobs. The optional
[processing pipeline](PHOTO_PROCESSING.md) follows its verified Media receipts
through a dedicated external library, queued analysis and owner review.

## Configuration

| Variable | Meaning |
|---|---|
| `IMMICH_URL` | Immich base address as Core reaches it, without `/api` (for example `http://immich:2283` on a shared Docker network). |
| `IMMICH_API_KEY_FILE` | Path, inside the Core container, of a read-only file holding the key: the bare key, or JSON with a `key` field. Read at each request, so a rotated key needs no restart. |
| `IMMICH_TIMEOUT_MS` | Timeout of one Immich request (1000–60000, default 10000). |
| `IMMICH_DESCRIPTION_WRITE_ENABLED` | `true` allows the description write route. Anything else: refused. |

Unset `IMMICH_URL` or `IMMICH_API_KEY_FILE`: photos are off and every route
except `/status` answers `503 PHOTOS_NOT_CONFIGURED` without contacting
anything. The routes are in the demo exclusion list, like finance.

Immich API key permissions used: `asset.read` (searches, details, OCR),
`asset.view` (thumbnails), `person.read` (people), `tag.read` (tags). Optional:
`person.statistics` (photo count per person), `asset.statistics` (one-call
counts; without it `/count` pages through the search) and `asset.update`
(description write, only when the flag is on). A missing permission surfaces as
`502 PHOTOS_UPSTREAM_FORBIDDEN`, except the people counts, which come back
`null` with `countsAvailable: false`.

## Routes

Same private-network access as the other Core product routes. Answers are
`{ ok: true, data }` or `{ ok: false, code, error }` (with
`error.details.candidates` when a name was unknown or ambiguous),
`Cache-Control: private, no-store`. Lists hold at most 50 items (default 20).

| Route | Answer |
|---|---|
| `GET /api/photos/status` | `{ enabled, descriptionWriteEnabled }` |
| `GET /api/photos/search/smart?q=…` | Photos ranked by likeness to the words in `q` (CLIP; French works). Filters below. |
| `GET /api/photos/search?…` | Photos matching exact metadata, newest first (`order=asc` for oldest). Adds `text` (description contains), `ocr` (text seen in the photo), `fileName`, `favorite=true`; pages with `cursor` = the previous `nextCursor`. |
| `GET /api/photos/count?…` | `{ total, exact }` for the same filters as `/search`. Uses Immich statistics when the key has `asset.statistics`, else pages through the search (up to 10,000; `exact: false` beyond). |
| `GET /api/photos/people` | Named people `{ id, name }`, and how many face groups are unnamed. `counts=true` adds `photoCount`; `includeUnnamed=true` lists unnamed groups too. |
| `GET /api/photos/people/:id/assets` | Photos of one person, same filters and paging as `/search`. |
| `GET /api/photos/places` | The cities, states and countries Immich geocoded. |
| `GET /api/photos/tags` | Tag paths, for example the `AgentX/...` card tags. |
| `GET /api/photos/assets/:id` | One photo: date, time zone, place (city, state, country, rounded coordinates), people, description, `reviewPending`, tags, OCR text, camera, size, favorite. |
| `GET /api/photos/assets/:id/thumbnail` | The image itself; `size=preview` for a larger one. |
| `PUT /api/photos/assets/:id/description` | `{ description }` (≤ 2000 characters). Off unless `IMMICH_DESCRIPTION_WRITE_ENABLED=true`. |

Filters shared by the searches and the count:

- `person`: names, accents and case ignored; several separated by commas
  means photos with all of them. A part of a name works when it designates
  one person (`Jordan` → `Jordan Example`); several candidates answer
  `409 PHOTOS_PERSON_AMBIGUOUS`, none `404 PHOTOS_PERSON_UNKNOWN`, never a
  silently dropped filter. Two face groups with the same name count as one
  person (either group). `personId` takes ids.
- `city`, `state`, `country`: matched against the places Immich knows,
  ignoring accents, case and dash or apostrophe variants (`saint elan` →
  `Saint-Élan`); a part of a long name works (`elan-nord`). An unknown place
  answers `404 PHOTOS_PLACE_UNKNOWN` with close names. When a city has the
  name of a state, the answer's `notes` says so.
- `tag`: a full tag path (`AgentX/Saison/été`) or its last part (`été`).
- `year=2025`, or `from` / `to` as `2025`, `2025-07`, `2025-07-14` or a full
  ISO time. Partial dates follow the household calendar
  (`PLANNING_TIME_ZONE`, default America/Toronto); a partial `to` covers its
  whole year, month or day.
- `audience=family` for children's and family surfaces (below).

Only photos with GPS have a place. A place filter adds `placeCoverage`
(`photosWithPlace` of `photos`) so an answer never reads "no photo in X"
when most photos simply have no place.

Search items are compact: `id`, `type`, `takenAt`, `fileName`, `city`,
`state`, `country`, `people` (names; `null` when Core could not read them),
`description` (first 200 characters) and the `thumbnail` path on Core.
Immich paths and keys never appear in an answer. Smart search answers come
from Immich without people; Core adds them with one metadata call.

Search items and asset details include `takenAtSource` and `dateTimeOriginal`.
`takenAt` keeps the existing library-date order: valid EXIF
`exifInfo.dateTimeOriginal`, else Immich `localDateTime`, else `fileCreatedAt`.
`takenAtSource` names that exact upstream field, or is `null` when no valid
date is available. `dateTimeOriginal` holds only the valid EXIF original date,
or `null`; a local Immich date or a file date never fills it. Absent, malformed
or invalid calendar dates remain unknown. Core preserves valid upstream
strings and never supplies a missing time zone or capture precision.

These dates are library metadata, not independent confirmation of when a photo
was taken. Atlas labels the displayed date as **date originale EXIF**,
**date locale Immich** or **date du fichier**, and keeps unknown dates undated.
Older responses without provenance retain a library date with unknown origin.
Date filters and ordering keep Immich's existing library-date semantics; they
do not become verified capture-date filters. This projection adds no upstream
request, file-content scan, index or reindexing. Data's separate inventory
`mtime` remains a file-modification date and is never used as capture evidence.

Smart search always returns its best matches, even weak ones: it has no
"nothing found". Check the details or the thumbnail before asserting that a
photo shows something.

## Family audience

Children may see household photos and the names on faces (owner decision,
2026-10-20), but only cards the owner reviewed. With `audience=family`:

- only timeline photos: archived, hidden and locked ones are left out, and
  their details and thumbnails answer 404;
- a photo still tagged `AgentX/Relecture/à relire` shows no description and
  no `AgentX/...` tag; review tags (`AgentX/Relecture/...`,
  `AgentX/À vérifier/...`) never show.

`audience` is a product rule, not an access control: on the private network
any caller may omit it. Family surfaces and family agents must send it.

## Agents

- Core tool bus (`POST /mcp`, default profile): `photo_search` (with
  `query`: by words; without: exact), `photo_count`, `photo_details`,
  `photo_names` (`people`, `places`, `tags`). Each takes `audience`.
- Nestor (OpenClaw plugin `super-dad-memory`): `nestor_photos`. The owner's
  sessions read everything; another household agent's session always reads
  with `audience=family`. `show` attaches previews to the reply, because
  Core's thumbnail links only open on the home network.
- Other agents with plain HTTPS use the routes above.

## Idle photo frame in personal Nestor

The existing personal conversation can show one photo across the current
browser viewport after inactivity. It uses Immich's native random search,
the existing Core credential and preview transport; it does not scan the
library or start inference, recognition, playback or camera capture.

The instance enables it with a private file at
`$AGENTX_INSTANCE_ROOT/config/photo-frame.json`:

```json
{
  "version": 1,
  "originalPathPrefix": "/mnt/media/photo-frame",
  "idleSeconds": 120,
  "intervalSeconds": 30
}
```

`originalPathPrefix` is the directory **as Immich sees it**, without a trailing
slash; verify it against an asset in the requested source before installation.
It is not a browser-supplied path or a directory on the client. Missing,
invalid or unreadable configuration leaves the feature off. The configuration
is limited to 4 KiB; inactivity is 30–3600 seconds and rotation 5–3600 seconds.
The defaults are two minutes and thirty seconds, with no transition effect.

| Route | Answer |
|---|---|
| `GET /api/photos/frame/status` | Enabled state and intervals; no directory or credential. |
| `GET /api/photos/frame/next?exclude=<previous-id>` | One random `{id, src}`, or `null` when none matches. |
| `GET /api/photos/frame/:id/image` | Preview image after checking current membership again. |

Selection sends one bounded `POST /search/random` to Immich, constrained to
the configured directory and its descendants, timeline images, available
files and no trash. Both selection and image delivery verify the returned
path and reject siblings, non-normal paths, hidden/locked images and videos.
Browser parameters cannot replace the configured source. No path, EXIF,
description or face name is returned. Empty selections keep the current
photo, or leave the conversation visible when none is showing. There is no
unfiltered fallback. One-photo sources can therefore keep their current
photo when the exclusion has no other match.

When configured, **Photos en veille** toggles the feature for this visit.
**Left/Right** and the **Photo précédente / Photo suivante** buttons navigate
one shared history for the current display session. Previous returns to the
exact photo shown before; next replays forward history before requesting a new
random photo. Automatic rotation uses that same forward path. Manual navigation
restarts the rotation delay; repeated next commands while a request is pending
are coalesced. Previous cancels pending navigation, and late responses cannot
replace the selected photo. A failed next image keeps the current photo and
history available for retry. Leaving the frame clears its in-memory history.

The existing microphone/recognition loop also accepts the exact French commands
**recule** and **avance** while photos are displayed, without leaving the frame
or sending a model turn. Existing close/back commands still return to Nestor.
Wake-word standby still requires addressing Nestor (for example,
**Hey Nestor, avance**); bare commands work during an open conversation or when
wake-word mode is off. Outside the frame, these two new aliases are not captured.
Recognition briefly keeps photos visible while deciding between a local command,
ambient speech and an actual Nestor request. Text editors keep their arrow keys.

The photo shows alone, without controls or mouse cursor. Moving the mouse
reveals the control bar and cursor; they hide again after three seconds without
movement, unless the pointer rests on the bar. **Tab** reveals the bar and
focuses its first button, and the bar stays while keyboard focus is in it.
Touch, a still cursor and the synthetic move a browser sends when the photo
appears do not reveal it. A failed next image reveals the bar with its status.

Touch/click outside photo controls or Escape returns to the same conversation. The photo controls
also reach Settings, Flow, microphone diagnostics and the existing mic button.
Active conversation work, a focused editor or embedded page, open settings or a dialog prevent
the frame from taking focus. Background tabs stop showing photos; leaving the
conversation removes the component. A failed API/image leaves Nestor accessible.

While a photo is visible, the covered avatar, scene controls and content workspace
leave layout so the existing GraphysX visibility observers suspend both the face
and any math scene underneath. Their elements and content remain mounted. The dock
also stops sampling audio levels and updating the concealed face/orb. Returning
to Nestor resumes the same face and layout; photo rotation does not reload it.
The dock skips these visual updates in hidden tabs and when its face is hidden
with the existing layout control as well. Speech and wake-word capture keep
their existing lifecycle.

Unchanged presence samples do not rewrite the face or orb; the face's own
animation continues normally. Progress indicators reuse their existing rows,
skip identical text/state writes and wait while the tab or photo overlay hides
them. Received work updates remain available when the indicators resume.

Existing speech capture and its `WakeWindow` grammar supply voice return:
**Hey Nestor** (including existing Eille variants) returns locally without a
model turn. Addressed close/back/shrink commands also work; ordinary requests
retain the conversation path. While the existing wake gate is armed, ambient
speech does not exit the photos. The microphone must already be active;
when it is off, the on-screen button and touch/click/Escape remain available.
This feature changes no listening preference and enables no
new wake word or permanent capture. Family mounts the same component; its Flow
button opens the existing family voice workshop, without owner workflow data.
Pinned family devices can GET only frame status, next image and the configured
image proxy. Library search, metadata and other photo routes remain blocked.
Browser/OS kiosk startup, screen power, audio permission and real-device voice
acceptance are separate instance steps.

Photos work with OpenClaw or direct AgentX conversations as well as Hermes.
For an existing conversation, start **New conversation**, then choose
**Settings → Engine → OpenClaw** and the intended member before starting voice.
The contextual presentation companion remains Hermes-only; photo inactivity
does not enable it. The native agent's model/provider policy remains separate
from this visual component.

The Immich v3.3.3 [random controller](https://github.com/immich-app/immich/blob/v3.3.3/server/src/controllers/search.controller.ts)
uses the existing `asset.read` permission, and its
[search schema](https://github.com/immich-app/immich/blob/v3.3.3/server/src/dtos/search.dto.ts)
supports the structured directory filter. No additional Immich key is needed.

Checks: `core/tests/routes/photoFrame.api.test.js` uses synthetic assets and
mocked Immich. `core/tests/browser/nestorIdlePhotosJourney.cjs` uses the shipped
markup/component and loopback photo fixtures; set `IDLE_PHOTOS_REPORT_DIR`
outside the checkout and, if needed, `AGENTX_PLAYWRIGHT_MODULE` and
`AGENTX_BROWSER_EXECUTABLE`. It uses no real photos, microphone or model.
`nestorFamilyPhotosJourney.cjs` checks the real family controller, scoped local
session, wake return and family diagnostics with synthetic audio and photos.
`nestorIdlePhotosRenderingJourney.cjs` checks actual browser intersections and
dock sampling while photos cover all four avatar layouts, then verifies the same
face resumes. Its renderer is a counter; no WebGL or live media is started.
`nestorIdleRenderingPerformanceJourney.cjs` checks unchanged presence, retained
progress rows, hidden progress updates and both covered math-scene containers
with counter renderers at desktop and mobile sizes.

## Not covered

No general album, upload, delete or face-naming route. The phone-processing
capability manages only its configured review tags and frame album. Indexing
and its machine-learning jobs stay in Immich under Core's planned heavy-work
window for this pipeline.

Tests: `core/tests/routes/photos*.api.test.js` (mocked Immich, synthetic data).

## Video playback

`GET /api/photos/assets/:id/video` streams Immich playback through Core, with
a single optional HTTP byte range. The route checks the asset type and the same
family visibility/import-library exclusions as photo details before streaming.
Pinned family devices cannot use this general asset route; demo profiles exclude
it with the other photo APIs. Core retains the Immich credential and forwards
only media headers. The stream uses backpressure, aborts on viewer disconnect,
and refuses redirects, non-video bodies and unavailable playback. It starts no
analysis or conversion job. Immich documents this range-capable endpoint in its
[media controller](https://github.com/immich-app/immich/blob/main/server/src/controllers/asset-media.controller.ts).

DiskX opens indexed videos in its media viewer. An unavailable codec, unfinished
indexing or playback refusal remains explicit. Mock and synthetic browser tests
do not attest the installed Immich version, its permission grants or real clips.
