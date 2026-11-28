# Famille kitchen timer

Start, check, extend or cancel the shared kitchen timer by talking to or typing
to Nestor Famille. Nestor interprets the current conversation and calls the
scoped Core tool, rather than matching a list of commands. A question like
“Combien il reste?” can be about the timer or a different subject. Gardien does
not have timer write access. Nestor reports only what Core confirms. Eligible
Famille turns use the existing tool-capable conversation lane; the older
tool-free spoken selector cannot execute this action. The personal voice lane
is unchanged.

Core owns one timer. A second start does not overwrite it. Start duration is
one second to 24 hours; adding time updates the existing timer and cannot put
more than 24 hours on the clock. A retried extension for the same turn does
not add time twice. The panel uses the same Core deadline that the tool
reports. Reloading the panel or restarting Core with the same database does
not restart the countdown. There is no second timer store or separate worker.

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
