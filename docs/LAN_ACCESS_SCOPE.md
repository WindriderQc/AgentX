# LAN access refactor scope

This inventory describes the pre-change contract and the replacement. The
authority for human access is the private network, without an account or adult
code. It does not establish the identity of a person. Voice identification is
a design proposal, not a delivered capability.

## Request paths and authorities

| Browser entry | Backend | Previous gate | Retained authority |
|---|---|---|---|
| HTTPS LAN `/`, `/dad`, `/panel`, `/lecture` | Core on loopback 3180 | `parentalAccess`, gateway entry header, adult cookie | Core surface/pack binding, conversations, memory audience, task lanes |
| HTTPS LAN `/psyx`, `/api/psyx/*` | PsyX in Core | Shared parental session; separate native token | PsyX owner namespace and explicit lifecycle/reset confirmations; native bearer remains independent |
| HTTPS LAN Benchmark port | Benchmark on loopback 3181 | Caddy forward auth to Core | Benchmark admission, leases, execution limits and qualification |
| HTTPS LAN RAG port | RAG on loopback 3182 | Caddy forward auth to Core | Retrieval classifications, ingestion policy and destructive confirmations |
| HTTPS LAN `/data-toolbox` | Core projection → internal Data 3083 | Core adult gate | Toolbox allowlist: reads, network device record edit, network scan request, MQTT publish, storage scan request, Janitor review decisions (store, import, remove; no file is deleted), report generation and report deletion (in Data's own report store); Data owns mutations |
| Optional HTTPS LAN Data entry | Data on loopback 3183 | Gateway deployment dependent | Data preview/approval/evidence rules; native collectors remain unchanged |

All four services use `shared/browserOriginGuard.js`. Compose publishes only
loopback ports; MongoDB and Qdrant remain internal. Caddy must restrict clients
by their actual peer address, keep private HTTPS and proxy every asset/API path.
An example or passing local test does not establish deployed ingress.

## Removal inventory

- Core: `src/middleware/parentalAccess.js`, `parentalCodeRoutes.js`,
  `faceUnlock.js`; `src/services/accessSessionService.js`,
  `parentalCodeService.js`, `faceUnlockService.js`, `faceRecognizer.js`,
  `faceRecognizerWorker.js`; `models/ParentalCode.js`, `FaceEnrollment.js`.
- Browser: all `core/public/access` pages/assets; layout and Data Toolbox injection; Household
  access markers and unlock link; optional `AgentXAccess` calls in Household
  browser modules; PsyX gate, lock controls, cookie auth and access epochs.
- Configuration: `AGENTX_PARENTAL_CODE`, `AGENTX_PARENTAL_SESSION_MINUTES`,
  `AGENTX_FACE_UNLOCK_*`, `X-AgentX-Entry`, Compose/environment catalogue and
  Caddy examples; CI cookie/unlock smoke.
- HTTP: `/api/access/*` retires; `/unlock` and `/access/code|face` become bounded
  bookmark redirects. Existing `agentx_adult` and `psyx_session` cookies expire
  when presented and never grant access. No adult session store remains.
- Native telemetry consumers: remove the parental bearer/code-file transport in
  memory-review Python, Codex usage sync JavaScript and its PowerShell wrapper;
  retain TLS verification, receipt checking and refusal to follow redirects.
- Coverage: replace code/enrollment/session expectations with real Core API
  access, migration, data preservation, native-token and gateway tests. Keep
  unrelated conversation, family task and service permission suites.

## Independent permissions and data

Keep external/Nestor consumer tokens, OpenClaw credentials and native tool
grants, roundtable chair token, identifier/media-vault encryption keys, DSH
Studio signed launch cookie/secret and its separate forward-auth endpoint.
The DSH gate protects a native integration and is not the adult code.
The explicit audio evidence vault is not a speaker classifier or automatic
enrollment; existing recordings must not become identity profiles implicitly.

`access_face_enrollments` contains subject `default` and arrays of 128-number
descriptors; the old recognizer did not persist submitted camera frames.
`access_parental_code` contains the hash and salt of the locally configured
code. This refactor neither queries production nor changes these collections.
Actual enrollment count is unknown until an approved live inspection. Retire
data only under the separate procedure in [LAN access](PARENTAL_ACCESS.md).

## Historical contracts and concurrent work

The requested historical `RUNTIME.md` and `SERVICE_CONTRACTS.md` are absent
from both available checkouts and their locally available Git history. No old
repository was modified or contacted. Current root `AGENTS.md`, README,
STATUS, ARCHITECTURE and OPERATIONS govern this change. Old parental claims in
archived reports contradict this decision; they remain historical evidence,
not deployment instructions.

The product checkout has concurrent uncommitted changes in shared app,
parental, Household, PsyX and documentation files. Implementation is isolated
from the committed baseline in a separate worktree. Integration into that
checkout requires reviewing overlap; this branch does not include or overwrite
the concurrent work. The instance checkout is isolated in the same way.

## Final residual-reference classification

| References | Classification and reason |
|---|---|
| Old middleware, services, models, UI/assets, timers and env settings | Removed from executable product/configuration; face/TensorFlow dependencies removed from package and lockfile; `jpeg-js` retained for the independent image codec |
| `/unlock`, `/access/code`, `/access/face`, `agentx_adult`, `psyx_session` in `legacyHumanAccess.js` | Deliberate migration only: bounded redirect/cookie expiry, no sessions or privilege |
| Retired routes and UI names in migration tests and CI | Negative assertions proving absence; never used to unlock a human request |
| Collection names in preservation tests and retirement procedure | Required historical data identity; no production deletion performed |
| Names in this inventory and `PARENTAL_ACCESS.md` | Explicit removal/migration history; filename retained for existing documentation links |
| Parental names in secret-detector regexes (`shared/envStatus.js`, private importer) | Retained leak protection for old secrets still present on-host/old imports, not access control |
| `household-parent` / parent launch in task receipts | Legacy declared surface/source identity; authenticated actor remains null; business review workflow retained |
| DSH Studio forward-auth and signed cookie | Independent native integration permission, retained; not the adult-code mechanism |
| Family safety prompts, guardian declarations, adult/child audio evidence categories | Independent domain/consent rules, retained; no biometric identity claim or implicit enrollment |
| Private archived reports/issues and legacy code-file exclusion | Historical snapshots/quarantine only; current private LAN procedure takes precedence |

The unavailable historical contracts and live gateway state remain verification
limits. There is no justified debt retaining an executable adult-code gate or
face classifier. Tests of the deleted algorithms are replaced by bookmark,
retired-route, data-preservation, UI and native-token coverage; all unrelated
business suites remain.
