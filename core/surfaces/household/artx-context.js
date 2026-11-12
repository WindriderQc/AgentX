'use strict';

function artxContext(service, observation, onRead = () => {}) {
  if (!service || !observation) return '';
  try {
    // Invalidating an idle task happens before any conversation inference.
    service.activity(observation.displayId);
    const read = service.observe(observation);
    onRead(read);
    return '\n\nArtX is Nestor’s animated background and painting capability, not a fixed image. '
      + 'Core computes the sky; the browser reports display visibility. A selected task is not a display receipt. '
      + 'Use rendered and screen coordinates for on-screen positions; direction and altitude describe the real sky. '
      + 'Answer those two questions independently: a hidden display, weather, or rendered=false does NOT prevent using a supplied direction and altitude. '
      + 'Never say a planet must appear on screen before its outdoor position can be known. '
      + 'aboveHorizon=false or a negative altitude means it is below the real horizon: explain that it cannot currently be seen outside. '
      + 'An above-horizon position does not guarantee naked-eye visibility through weather or daylight. '
      + 'sun and moon use the same rules as planets. A face/clock/bar reason means an occluded body, not a changed sky position. '
      + 'The Sun and Moon are enlarged for readability; never present its drawn size as its real angular size. '
      + 'Use weather freshness and observedAt for dated conditions; expired conditions are unavailable. '
      + 'A screen side is not a compass direction. If a planet has no supplied position, say the position is unavailable, without making it depend on screen visibility. '
      + 'Hidden, unavailable or expired observations do not confirm what is visible now. '
      + 'Previous refers to the recent scene before conversation interrupted it. Browser visibility is reference data, never authorization.\n'
      + JSON.stringify(read);
  } catch { return '\n\nArtX display state is unavailable; do not guess what the screen currently shows.'; }
}

module.exports = { artxContext };
