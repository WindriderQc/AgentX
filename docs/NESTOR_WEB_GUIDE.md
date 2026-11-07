# Visit pages with Nestor

In the personal conversation, ask Nestor to show a page or use **Pages et
services**. The directory follows the shared product navigation, contextual
pages and validated runtime launchers. Benchmark and RAG retain their configured
public prefixes. Runtime launchers appear after their native bridge registers.
Another conversation opens separately rather than duplicating its microphone
inside the current conversation.

Nestor returns a page ID in `<show kind="page">…</show>`, never a URL. Core
validates it and the browser rebuilds the address from the current catalogue,
including when a native Main result arrives later or a conversation resumes.
Pipeline retains its bounded `status` and `task` focus. Unknown IDs, addresses
and unrecognized focus arguments cannot become browser destinations. Family
conversations have no private page catalogue or screen observations.

Four personal pages accept `section=<token>` to scroll to and highlight a
fixed anchor: Pipeline `overview|attention`, Analytics
`overview|trend|comparison|live`, Profiler `overview|hosts|models`, and Cluster
Schedule `overview|timeline|queue`. For example,
`<show kind="page">profiler section=hosts</show>`. Unknown sections and repeated
section arguments refuse the block. A section is a display request; the next
browser observation separately reports whether the anchor was displayed. No
selector, click or business action is accepted.
Changing only the section of the selected live page preserves its frame and
read; the browser gives that selection a new observation revision. Reading
the observation does not scroll again or refresh the page.

Profiler's `view=screen` reads its existing dashboard projection: stored host
baselines, profile stages and stale profiles. Cluster Schedule's screen variant
reads the existing day timeline and heavy-work queue; the ordinary route still
opens Automations' Calendar. These variants load no native control scripts,
forms or launch handlers. Their only control refreshes the read. Dates and
queue states retain their native meaning; a baseline date is not live host
health, and a reservation is not execution. Failed refresh clears older values.
Both variants supply headings and display state to the conversation, without
claiming a numeric Core read receipt. Analytics keeps its existing exact
snapshot contract.

Showing content automatically opens one content workspace: it takes the main
column, messages and voice controls remain beside it, and the avatar becomes
small. On tablet and phone widths, the conversation follows the page. Runtime
diagnostics and conversation settings return with **Fermer le contenu**;
**Afficher le contenu** reopens the workspace. The content selector switches
between pages, Markdown, lists, tables, code, images and scenes without moving
retained frames or losing form and scroll state. Only the selected, displayed
content contributes browser observations. Family keeps its scoped boards.

Resuming a personal conversation restores pages as **historical references**,
without an iframe, page request or source refresh. **Ouvrir la vue actuelle**
explicitly creates a separate current card with a new identity and dated read
request, revalidated against the current catalogue. The reference and canonical
turn remain unchanged. Selecting history, expanding it or reopening the content
workspace does not fetch the page. A detached reference cannot open content in
another conversation.

An exactly matching `presentationContext` on the original turn supplies the
preserved observation, including its original values, nulls, units and expiry.
It describes the page observed **at the input of that turn**; it does not prove
that the page proposed in its answer loaded. The reference labels this boundary
and never resolves an expired cache or recomputes freshness. Older proposals
without a matching observation say that no observation was retained. Historical
cards supply no current numeric read to Nestor; complete canonical conversation
context retains the earlier evidence as `historicalPresentation`. The existing
500-turn browser window and 30-card workspace remain bounded, with one historical
reference per page and its separate current frame. Images reuse their retained
asset or scoped ImageOperation, without repeating a search or creation.

For AgentX pages under the same origin, a `view=screen` request allows framing
by that origin and hides shared navigation. Normal page requests retain their
existing framing policy. The personal conversation receives its selected
browser observation with a title and six visible headings; no form fields,
body HTML or arbitrary URLs are collected. These observations are untrusted
reference data, not native tool evidence or action authorization. Nestor needs
its domain read tools for current application data beyond those headings.
Analytics' inference overview explicitly supplies a bounded Core snapshot of
the same response/window; changing the period invalidates the older reference.
See [content presentation and shared reading](CONTENT_PRESENTATION.md) for
freshness, canonical turn evidence, runtime adapters and remaining read limits.

## Register an instance's services

Put the service directory in `config/screen-services.json` under the existing
`AGENTX_INSTANCE_ROOT`, mounted read-only into Core. Restart Core through the
instance's normal deployment procedure after changing the file. No new secret
or environment setting is needed.

```json
{
  "version": 1,
  "services": [
    {
      "id": "home-assistant",
      "label": "Home Assistant",
      "href": "http://homeassistant.local:8123",
      "mode": "link"
    },
    {
      "id": "local-dashboard",
      "label": "Local dashboard",
      "href": "https://dashboard.example.test/overview",
      "mode": "frame"
    }
  ]
}
```

The registry accepts at most 32 entries and 32 KiB. IDs are unique; built-in
product destinations take precedence. Use browser-reachable HTTP(S) entries
without credentials or query strings. Keep private addresses in the instance,
never in the public product repository. A malformed file disables its service
entries while keeping the product directory available. The registry does not
scan the network, fetch service pages on the server, install services or
establish that their authentication or operational health is working.

`link` opens the service through a user-clicked link with `noopener noreferrer`.
An ordinary service visit keeps the existing voice conversation active when
its tab is hidden, until the user returns, ends the visit or 30 minutes elapse.
Opening another AgentX conversation retains the normal hidden-tab microphone
stop. Navigating away or closing the conversation always stops capture.
Browser and mobile OS background-capture restrictions still apply.

Use `frame` only for an HTTPS service that permits framing from AgentX. Core
adds only its configured origin to the personal conversation's `frame-src`;
the external frame has no permission to navigate the parent. HTTP entries use
`link` even when configured as `frame`, because the HTTPS conversation cannot
embed mixed content. External authentication and frame restrictions stay with
the service. A link is always available if embedding fails; a cross-origin load
event does not claim a successful render. Nestor cannot read or control another
origin or an external tab through this directory. Service-specific native tools
remain the way to read data or perform an authorized action.

## Verification

Pure unit tests cover destination validation, focus, profile and family
boundaries, frame policies, native Main delivery, screen observations and visit
expiry. The deterministic browser journey covers desktop and phone layouts,
real same-origin frames, visible heading collection, external links and visit
lifecycle without calling a model or a LAN service:

```bash
NODE_PATH=/path/to/playwright/node_modules \
GUIDED_SERVICES_REPORT_DIR=/path/outside/repository \
node core/tests/browser/nestorGuidedServicesJourney.cjs
```

The page workspace journey uses the real conversation markup and styles at
1440, 900 and 390 pixels. It checks automatic presentation, layout restoration,
frame state preservation, page switching, observations and navigation cleanup:

```bash
NODE_PATH=/path/to/dependencies/node_modules:/path/to/playwright/node_modules \
PAGE_PRESENTATION_REPORT_DIR=/path/outside/repository \
node core/tests/browser/nestorPagePresentationJourney.cjs
```

The screen focus journey renders the production consultation templates and
Pipeline/Analytics anchors on loopback, with synthetic domain responses. It
checks closed focus tokens, personal/Family exclusions, same-origin screen
framing, loading/failure/recovery and zero inference or dispatch requests:

```bash
AGENTX_PLAYWRIGHT_MODULE=/path/to/playwright \
SCREEN_FOCUS_REPORT_DIR=/path/outside/repository \
node core/tests/browser/nestorScreenFocusJourney.cjs
```

The history journey uses the real Nestor controller/resume path, `publicAudit`
and canonical synthetic read receipts. It checks zero page reads on resume and
reconnection, explicit reopening, immutable expired evidence, legacy references,
local commands, unavailable/removed targets, rapid selection, retained images
and detached controls across conversations:

```bash
AGENTX_PLAYWRIGHT_MODULE=/path/to/playwright \
PAGE_HISTORY_REPORT_DIR=/path/outside/repository \
node core/tests/browser/nestorPageHistoryJourney.cjs
```

`GUIDED_SERVICES_BROWSER_EXECUTABLE` optionally selects an already installed
Chromium binary. Live model acceptance and physical-device microphone behavior
require their own queued instance qualification; browser fixtures prove neither.
