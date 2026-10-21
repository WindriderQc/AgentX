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

## Not covered

No album, upload, delete, face naming or tagging route. Indexing and its
machine-learning jobs stay in Immich; a large run is heavy work for the
instance queue.

Tests: `core/tests/routes/photos*.api.test.js` (mocked Immich, synthetic data).
