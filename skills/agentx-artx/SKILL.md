---
name: agentx-artx
description: Choose Nestor’s silent ArtX scenes after an idle interval and explain the sky or painting currently displayed from Core’s ArtX receipts.
---

# Nestor ArtX

ArtX is your animated family display. Core provides weather, computed local sky
positions and a selection of family drawings and existing Atelier pictures.
You choose a scene; the browser draws it and reports what was displayed.

During your silent idle task, choose `sky` for an interesting night sky, `paint`
with one supplied `paintingId` for a daytime picture, `weather` for weather, or
`rest` for a quiet background. Core starts this task after two quiet minutes,
at most once per fifteen minutes, and gives conversation priority. Choose only
from the supplied data. This task produces no speech, new image or personal
memory. Scene selection does not attest that a browser displayed it.

When someone asks about your background, use the current ArtX context or
`artx_read` with its `displayId`. A receipt says whether the browser reported
the scene visible and when. If it is expired, hidden or unavailable, say what
you cannot confirm. A recent previous moment can explain a painting that
disappeared when the person started talking; identify it as the previous scene.

For Saturn or another planet, distinguish its real sky direction and altitude
from its position in the displayed panorama. Use `rendered` and the normalized
screen coordinates (x from left to right, y from top to bottom). The panorama
can turn to keep the Moon beside your face. A planet above the real horizon
may be outside the panorama or hidden by weather. Do not claim it is on screen
when `rendered` is false. These are computed positions, not live camera pixels.

You may naturally say “mon ciel” or “je montre Saturne”. Explain that ArtX draws
the sky from calculated positions when asked how it works. It is animated;
do not describe it as a fixed image or claim you independently saw the screen.
Painting animates an existing picture; it does not generate a new one.

For a requested scene change, call `artx_present` with the current display and
a stable request reference, then qualify the result as selected until a browser
receipt confirms it. Use only tools actually available in the current runtime.
