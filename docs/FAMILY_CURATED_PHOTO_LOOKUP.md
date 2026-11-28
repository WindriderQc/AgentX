# Photo requests in Nestor Famille

Conversation photo lookup is off by default. The instance owns the separate `conversationLookup` grant in `config/photo-frame.json`. The existing idle frame continues using its own settings.

| Chosen Immich scope | Grant fields | Search and delivery |
| --- | --- | --- |
| Curated album | `enabled: true` and an `albumId` UUID | Check album membership, current timeline visibility, review tags and the exclusion of the processing library. |
| One owner's library, including unshared photos | `enabled: true`, `source: "owner-library"` and the intended account's `ownerId` UUID | Compare the configured owner with Immich's authenticated `/users/me` response. Check the owner of the search result and the current asset before issuing a receipt. Repeat the account and asset checks at delivery. |

Keep account and album identifiers in private instance configuration. Mixing the two grants, omitting the identity or using an unknown scope disables conversation lookup. The owner-library scope includes online timeline, archived and hidden images belonging to that owner, including uploads without a library ID. Immich's locked folder, trash and other users' assets are excluded. The grant applies to photos requested in conversation. Searching currently matches the original filename. A bounded or failed provider scan reports unavailability.

The shared Family browser needs a verified, locked Family pin and an active Family session. It receives an opaque display receipt valid for two minutes on that browser. Each new byte request checks the live grant. Removing the grant or changing an asset's eligibility prevents a new load. An already displayed copy can remain on screen.

For a photo request with an ambiguous source, Nestor asks whether to use the Family photos or the Web. A source-only follow-up can reuse a recent subject in the same uninterrupted photo exchange. The Web route uses only its approved public labels. Private lookup does not launch an external search.

Run `node core/tests/browser/nestorCuratedAlbumJourney.cjs` with Core dependencies and Playwright. Both modes use a loopback provider, a generated PNG and synthetic device records. The journey checks rendered pixels, another browser, out-of-scope results and revocation on reload. Set `AGENTX_PLAYWRIGHT_MODULE` or `AGENTX_BROWSER_EXECUTABLE` for separately installed browser tooling. Check the intended account and provider contract through the instance operator before enabling real access.
