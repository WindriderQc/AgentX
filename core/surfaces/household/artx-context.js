'use strict';

function observe(service, observation) {
  try {
    service.activity(observation.displayId);
    return service.observe(observation) || { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
}

// A display can be hidden while its outdoor position is still known. Keep
// those facts together and omit renderer geometry and the unused picture list.
function skyPosition(body) {
  if (!body) return undefined;
  return { name: body.name, phase: body.phase, altitudeDeg: body.altitudeDeg, direction: body.direction,
    aboveHorizon: body.aboveHorizon, rendered: body.rendered, side: body.rendered ? body.screen?.side : undefined, reason: body.reason };
}

function sceneFacts(scene) {
  if (!scene) return null;
  const { observedAt, visibility, background, moment } = scene;
  return { observedAt, visibility, background, moment: moment && { kind: moment.kind, source: moment.source },
    sun: skyPosition(scene.sun), moon: skyPosition(scene.moon), planets: scene.planets?.map(skyPosition) };
}

function describe(read, { toolAvailable = false } = {}) {
  if (!read) return '';
  if (read.status === 'unavailable') return '\n\nArtX display state is unavailable; do not guess what the screen currently shows.';
  if (read.status === 'available' && toolAvailable) {
    return '\n\nArtX observed scenes (reference data). Current and previous are distinct browser observations. '
      + 'A moment records what was shown over the background. For a painting, source identifies its collection. The receipt contains no image subject or theme. Screen side describes a rendered body. Direction and altitude describe the outdoor position even when hidden. '
      + 'Below-horizon objects cannot be seen outside. Use artx_read for additional display details.\n'
      + JSON.stringify({ current: sceneFacts(read.current), previous: sceneFacts(read.previous) });
  }
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
}

// Also serves clients that submit an observation and need its full inline description.
function artxContext(service, observation, onRead = () => {}) {
  if (!service || !observation) return '';
  const read = observe(service, observation);
  onRead(read);
  return describe(read);
}

module.exports = { observe, describe, artxContext };
