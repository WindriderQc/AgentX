# Famille kitchen timer

On the Famille conversation page, say or type « Mets une minuterie de deux minutes »,
« Combien il reste? », or « Annule la minuterie ». The follow-up without a named
timer is treated as a timer question only while one is running or has just finished.
There is one shared kitchen timer per Famille space. A second start reports the
original timer instead of silently replacing it. Supported durations range from
one second to 24 hours.

Core handles recognized commands before model routing in the existing Famille
conversation, with the usual scope and safety checks. Core stores an absolute
deadline and an opaque ID in MongoDB. The panel reads and shows that state in
the current view. Refreshing the panel or restarting Core with the same
database does not restart the countdown. There is no browser timer record,
cloud notification, new worker, or GPU requirement.

At expiry, a visible browser that can play audio can claim one short beep
from Core, within one minute. Core records the claim atomically before the
browser plays it. Reloads and multiple tabs cannot duplicate the claim. If the
browser is closed, offline, blocked from playing sound, or loses the claim
response, an audible alert is not guaranteed. An expired timer stays visible
when the panel reconnects, without a late beep after that minute. Browser
autoplay policy can require prior interaction with the page.

Acceptance commands (run from the product root):

```sh
npm run test:prepare --prefix core
npm test --prefix core -- --runTestsByPath tests/services/familyKitchenTimer.test.js
node --test core/surfaces/household/test/family-kitchen-timer.test.js
node core/tests/browser/nestorFamilyKitchenTimerJourney.cjs
```

For the browser fixture, make Playwright/Chromium available; use
`AGENTX_PLAYWRIGHT_MODULE` and `AGENTX_BROWSER_EXECUTABLE` if installed in
non-default locations. The fixture uses the actual Famille page, an isolated
clock/store and synthetic audio. It is not a physical microphone or speaker test.
