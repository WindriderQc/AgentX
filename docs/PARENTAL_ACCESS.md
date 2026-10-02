# Parental access

The full profile provides one parental-code session for the household browser.
Family pages stay available; Super Dad, PsyX, private data and parent controls
require an unlocked session. This is a shared-device boundary, not individual
family accounts. Keep the application private on the LAN.

There is no default code; adult entry stays closed until one exists. When no
code exists, the unlock page offers "Définir le code parental", but only to a
request without the gateway marker, i.e. a browser on the AgentX host itself
(the backend ports are bound to loopback). Through the gateway, the page says
to set it from the host. The code has 4 to 128 characters and is typed twice.
Core keeps only a scrypt hash with a random salt, in the single-document
`access_parental_code` collection; the code is never stored or logged in clear.
An unlocked adult changes it at `/access/code` (linked from the unlock page)
with the current code and the new one twice. A wrong current code counts as a
failed unlock. A change revokes every other adult session; the browser that
made it stays unlocked.

`AGENTX_PARENTAL_CODE` in the external instance env file, when set, takes
precedence: the stored code is ignored and the page says the code is managed by
configuration and is changed there. Bearer access (`Authorization: Bearer`)
accepts only this configured code; a code set from the host opens sessions
only. The cookie is HttpOnly,
SameSite Strict and Secure through HTTPS. Sessions expire after 30 minutes;
`AGENTX_PARENTAL_SESSION_MINUTES` accepts 5 through 480. A restart invalidates
sessions. Eight failed unlocks impose a five-minute delay, shared by requests
coming through the same gateway. The code is never placed in browser storage.
For a numeric code of at most 128 digits, the unlock form submits as soon as
the code's number of digits is entered. The button remains available for
other codes and if the session status cannot load.

Extend the existing trusted LAN HTTPS gateway using
`config/household.Caddyfile.example`. It must overwrite `X-AgentX-Entry: household`
on **every** browser request, and forward its actual HTTPS scheme. Bind every
published backend port to loopback; keep Mongo/Qdrant internal. Do not expose an
alternative raw port or a proxy route that omits the marker. The marker is an
ingress contract, not a secret: unmarked internal service calls retain the
existing trusted-network contract. Native PsyX token access remains separate.
The browser entry proxies Core only; direct Benchmark/RAG/Data browser entries
need the same adult boundary before being made reachable to family devices.

For separately served Benchmark/RAG UIs, the LAN gateway can use Core's
`GET /api/access/authorize` as its forward-auth check. It returns 204 only for
the same valid parental cookie or native bearer, and 401 otherwise, even when
the entry header is absent. Keep the backend ports on loopback and proxy every
service path, including assets and APIs, through that check. Use HTTPS on the
same hostname so the host-only parental cookie is shared across service ports;
set each service's browser public URLs to these protected entries. Family
navigation revokes authorization for subsequent service requests too. A locked
browser navigation to a service page is sent to the unlock page and returned to
that page once unlocked, provided `CORE_PUBLIC_URL` and the service's public URL
are configured; API calls and unknown destinations get a plain 401.

Opening `/panel`, `/kids`, `/kids/sounds` or `/lecture` revokes this browser's
adult session. Other tabs receive a lock event and clear private content before
redirecting. On a locked family page the Household header marks adult
destinations with a lock, offers an "Espace adulte" entry in the tools menu and
sends `/` links through `/unlock`, because a locked `/` request is redirected
to `/panel`. Expiry, explicit lock, visibility changes and back/forward navigation
also check the session. The server independently rejects protected APIs, including
direct private-history, memory, settings and parent-approval requests. Family
conversation handlers retain their existing server-bound child/family scopes.
Erasing a Family conversation is a parent control: the family follow-up page
(`/dad/family`) lists them, and the family delete route requires the adult session.
Returning to Family does not cancel an already admitted server operation.

## Face unlock

`AGENTX_FACE_UNLOCK_ENABLED=true` adds "Me reconnaître par la caméra" to the
unlock page, next to the parental code. It works once a parental code exists;
the code always remains the fallback. The browser sends camera frames through the
same HTTPS gateway (browsers only open the camera on HTTPS pages). Core analyses
them in a worker thread with the face models packaged in
`@vladmandic/face-api`; no frame leaves the host and none is stored.

An adult session enrolls at `/access/face` (linked from the unlock page): at
least three frontal images, all of the same person. Core keeps only their
descriptors, in the `access_face_enrollments` collection; the same page erases
them. An unlock issues a random side and passes when one frame looks straight
at the camera and a later one turns the head to that side, both within
`AGENTX_FACE_UNLOCK_MAX_DISTANCE` (default 0.4, accepted 0.3 through 0.5) of an
enrolled descriptor. A challenge lasts 45 seconds and 24 frames. Three frames
of another face end it and count as one failed unlock, in the same counter as
wrong codes. A success opens the same session as the code.

The head turn defeats a still photo, not a video of the enrolled adult or a
close relative. Treat it as a household convenience at the same level as this
shared-device boundary.

Local HTTP/Mongo coverage exercises anonymous denial, shared Household/PsyX
access, revocation, HTTPS cookies, expiry, rate limiting and missing configuration,
setting the first code from the host only, changing it, the precedence of the
configured code, and the stored hash,
and face enrollment, challenges and the shared limit with a synthetic recognizer;
a unit test loads the real models.
Linux Compose CI exercises the same cookie across the real containers. Verify
unlock, private access and Family revocation through the actual HTTPS gateway on
every installation, and camera unlock on each device that uses it; a passing
suite does not establish it.
