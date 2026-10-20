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
`asset.view` (thumbnails), `person.read` (people). Optional:
`person.statistics` (photo count per person) and `asset.update` (description
write, only when the flag is on). A missing permission surfaces as
`502 PHOTOS_UPSTREAM_FORBIDDEN`, except the people counts, which come back
`null` with `countsAvailable: false`.

## Routes

Same private-network access as the other Core product routes. Answers are
`{ ok: true, data }` or `{ ok: false, code, error }`, `Cache-Control:
private, no-store`. Lists hold at most 50 items (default 20).

| Route | Answer |
|---|---|
| `GET /api/photos/status` | `{ enabled, descriptionWriteEnabled }` |
| `GET /api/photos/search/smart?q=…` | Photos ranked by likeness to the words in `q` (CLIP; French works). Filters below. |
| `GET /api/photos/search?…` | Photos matching exact metadata, newest first (`order=asc` for oldest). Adds `text` (description contains), `ocr` (text seen in the photo), `fileName`, `favorite=true`; pages with `cursor` = the previous `nextCursor`. |
| `GET /api/photos/people` | Named people `{ id, name }`, and how many face groups are unnamed. `counts=true` adds `photoCount`; `includeUnnamed=true` lists unnamed groups too. |
| `GET /api/photos/people/:id/assets` | Photos of one person, same filters and paging as `/search`. |
| `GET /api/photos/assets/:id` | One photo: date, time zone, place (city, state, country, rounded coordinates), people, description, OCR text, camera, size, favorite. |
| `GET /api/photos/assets/:id/thumbnail` | The image itself; `size=preview` for a larger one. |
| `PUT /api/photos/assets/:id/description` | `{ description }` (≤ 2000 characters). Off unless `IMMICH_DESCRIPTION_WRITE_ENABLED=true`. |

Filters shared by both searches:

- `person`: a person's name, accents and case ignored; several separated by
  commas means photos with all of them. An unknown name is refused
  (`404 PHOTOS_PERSON_UNKNOWN`), never silently dropped. `personId` takes ids.
- `city`, `country`: exact names as Immich geocoded them.
- `year=2025`, or `from` / `to` as `2025`, `2025-07`, `2025-07-14` or a full
  ISO time. A partial `to` covers its whole year, month or day.

Search items are compact: `id`, `type`, `takenAt`, `fileName`, `city`,
`country`, `people` (names), `description` (first 200 characters) and the
`thumbnail` path on Core. Immich paths and keys never appear in an answer.

Smart search always returns its best matches, even weak ones: it has no
"nothing found". Check the details or the thumbnail before asserting that a
photo shows something.

## Not covered

No album, upload, delete, face naming or tagging route. Indexing and its
machine-learning jobs stay in Immich; a large run is heavy work for the
instance queue.

Tests: `core/tests/routes/photos*.api.test.js` (mocked Immich, synthetic data).
