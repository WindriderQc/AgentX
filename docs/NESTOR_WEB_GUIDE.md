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

Showing a page automatically opens a page workspace: the page takes the main
column, messages and voice controls remain beside it, and the avatar becomes
small. On tablet and phone widths, the conversation follows the page. Runtime
diagnostics and conversation settings return with **Retour à la conversation**;
**Afficher la page** reopens the workspace. The page selector switches between
shown destinations without moving their frames or losing form and scroll state.
Only the selected, displayed page contributes browser observations. Pictures
and family conversations retain their existing display zones.

For AgentX pages under the same origin, a `view=screen` request allows framing
by that origin and hides shared navigation. Normal page requests retain their
existing framing policy. The personal conversation receives at most three
browser observations with a title and six visible headings each; no form fields,
body HTML or arbitrary URLs are collected. These observations are untrusted
reference data, not native tool evidence or action authorization. Nestor needs
its native read tools for current application data beyond those headings.

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

`GUIDED_SERVICES_BROWSER_EXECUTABLE` optionally selects an already installed
Chromium binary. Live model acceptance and physical-device microphone behavior
require their own queued instance qualification; browser fixtures prove neither.
