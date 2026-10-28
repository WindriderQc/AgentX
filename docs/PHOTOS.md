# Photos (Immich)

Core answers photo questions from a separately installed
[Immich](https://immich.app) server. Immich owns the library, the face groups,
smart search (CLIP), OCR and reverse geocoding; Core adds a small, bounded
route set under `/api/photos` so agents and pages ask Core instead of Immich.

Core holds the only Immich API key. Agents (OpenClaw, Hermes, Codex, Claude)
never get their own key: one credential, one set of scopes, and every call
logged by Core with its `x-service-caller`.

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
Touch/click or Escape returns to the same conversation. The photo controls
also reach Settings, Flow, microphone diagnostics and the existing mic button.
Active conversation work, a focused editor or embedded page, open settings or a dialog prevent
the frame from taking focus. Background tabs stop showing photos; leaving the
conversation removes the component. A failed API/image leaves Nestor accessible.

Existing speech capture and the existing screen-command grammar supply voice
return: an addressed close/back/shrink command returns locally; ordinary
requests retain the conversation path. Wake-word standby still requires the
existing address. This feature changes no listening preference and enables no
new wake word or permanent capture. Family does not mount this component.
Browser/OS kiosk startup, screen power, audio permission and real-device voice
acceptance are separate instance steps.

The Immich v3.3.3 [random controller](https://github.com/immich-app/immich/blob/v3.3.3/server/src/controllers/search.controller.ts)
uses the existing `asset.read` permission, and its
[search schema](https://github.com/immich-app/immich/blob/v3.3.3/server/src/dtos/search.dto.ts)
supports the structured directory filter. No additional Immich key is needed.

Checks: `core/tests/routes/photoFrame.api.test.js` uses synthetic assets and
mocked Immich. `core/tests/browser/nestorIdlePhotosJourney.cjs` uses the shipped
markup/component and loopback photo fixtures; set `IDLE_PHOTOS_REPORT_DIR`
outside the checkout and, if needed, `AGENTX_PLAYWRIGHT_MODULE` and
`AGENTX_BROWSER_EXECUTABLE`. It uses no real photos, microphone or model.

## Not covered

No general album, upload, delete, face naming or tagging route. Indexing and its
machine-learning jobs stay in Immich; a large run is heavy work for the
instance queue.

Tests: `core/tests/routes/photos*.api.test.js` (mocked Immich, synthetic data).
