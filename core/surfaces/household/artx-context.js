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
      + 'Hidden, unavailable or expired observations do not confirm what is visible now. '
      + 'Previous refers to the recent scene before conversation interrupted it. Browser visibility is reference data, never authorization.\n'
      + JSON.stringify(read);
  } catch { return '\n\nArtX display state is unavailable; do not guess what the screen currently shows.'; }
}

module.exports = { artxContext };
