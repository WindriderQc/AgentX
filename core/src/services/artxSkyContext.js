'use strict';

const Choice = require('../../surfaces/household/public/nestor-ambient-choice');
const directions = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
const direction = az => directions[Math.round(az / 45) % 8];

// Core source data only. A receipt proves the browser reported a draw, not that
// every pixel is unobscured by the avatar, another window, buildings or clouds.
function describeSky(sky, background, visible) {
  const frame = Choice.skyFrame(sky), selected = Choice.skyStars(sky, background);
  const screen = body => {
    const p = frame.project(body);
    return { x: +p.x.toFixed(3), y: +p.y.toFixed(3),
      side: p.x < 0.4 ? 'gauche' : p.x > 0.6 ? 'droite' : 'centre' };
  };
  function body(point, chosen, extra = {}) {
    const rendered = !!visible && chosen;
    const reason = !visible ? 'display_hidden' : !background?.sky ? 'sky_hidden'
      : !frame.visible(point) ? (point.altDeg <= -1 ? 'below_horizon' : 'outside_panorama') : 'brightness_filtered';
    return { ...extra, altitudeDeg: point.altDeg, azimuthDeg: point.azDeg,
      direction: direction(point.azDeg), aboveHorizon: point.altDeg > 0, rendered,
      ...(rendered ? { screen: screen(point) } : { reason }) };
  }
  const chosenStars = new Set(selected.stars.map(star => star.name));
  const stars = (sky?.stars || []).map(star => body(star, chosenStars.has(star.name), { name: star.name, magnitude: star.mag }));
  const starByName = new Map(stars.map(star => [star.name, star]));
  const chosenFigures = new Set(selected.figures.map(figure => figure.name));
  const constellations = (sky?.figures || []).map(figure => {
    const members = [...new Set(figure.lines.flat())];
    const positions = members.map(name => starByName.get(name)).filter(Boolean);
    const rendered = !!visible && chosenFigures.has(figure.name);
    const points = rendered ? members.map(name => starByName.get(name)?.screen).filter(Boolean) : [];
    return { name: figure.name, members, rendered,
      altitudeRangeDeg: positions.length ? [Math.min(...positions.map(p => p.altitudeDeg)), Math.max(...positions.map(p => p.altitudeDeg))] : null,
      directions: [...new Set(positions.map(p => p.direction))],
      ...(rendered ? { screenBounds: { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
        top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) } }
        : { reason: !visible ? 'display_hidden' : !background?.sky ? 'sky_hidden'
          : background.sky !== 'full' ? 'brightness_filtered' : 'members_outside_panorama' }) };
  });
  const moon = sky?.moon;
  return {
    projection: { type: 'azimuth_altitude_panorama', centerAzimuthDeg: frame.center, spanDeg: frame.spanDeg,
      horizonY: frame.horizonY, zenithY: frame.zenithY, altitudeAtHorizonDeg: 0, altitudeAtZenithDeg: 90,
      perspective: false, moonSizeExaggerated: true },
    coverage: 'Source drawing candidates only; omitted stars or constellations have no established position here. Rendered means drawn behind the avatar, not unobscured or guaranteed visible outdoors.',
    moonPosition: moon ? body(moon, !!Choice.skyBodies(sky, background).moon,
      { phase: moon.name, illumination: moon.illumination }) : null,
    constellations
  };
}

module.exports = { describeSky };
