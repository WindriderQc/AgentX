'use strict';

const Layout = require('../../surfaces/household/public/nestor-sky-layout');

// Describe the same geometry the painter uses. Browser viewport is bounded
// presentation metadata; astronomical values always come from Core's snapshot.
function describeSky(snapshot, background, receipt) {
  const sky = snapshot.sky;
  const plan = Layout.plan(sky, background, receipt.skyViewport);
  const frame = Layout.frame();
  const directions = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
  function position(id, point) {
    if (!point) return null;
    const item = plan.objects.find(o => o.id === id);
    const p = frame.project(point);
    const rendered = !!(receipt.visible && item?.rendered);
    const hiddenBy = !receipt.visible ? 'display_hidden' : !background.sky ? 'sky_hidden'
      : point.altDeg < 0 ? 'below_horizon' : !frame.visible(point) ? 'outside_panorama'
        : item?.hiddenBy || (background.light === 'day' ? 'daylight' : 'too_close_to_sun');
    return { altitudeDeg: point.altDeg, azimuthDeg: point.azDeg,
      direction: directions[Math.round(point.azDeg / 45) % 8], aboveHorizon: point.altDeg > 0, rendered,
      ...(rendered || item?.inFrame ? { screen: { x: +p.x.toFixed(3), y: +p.y.toFixed(3),
        side: p.x < 0.4 ? 'gauche' : p.x > 0.6 ? 'droite' : 'centre' } } : {}),
      ...(!rendered ? { reason: hiddenBy } : {}),
      label: receipt.visible && item?.label ? item.label.text : null };
  }
  return {
    planets: (sky?.planetPositions || sky?.planets || []).map(p => ({ id: p.id, name: p.name, ...position(p.id, p) })),
    sun: sky?.sun ? { ...position('sun', sky.sun), size: 'enlarged_for_readability', sizeCaption: 'Soleil · agrandi' } : null,
    moon: sky?.moon ? { phase: sky.moon.name, ...position('moon', sky.moon),
      size: 'enlarged_for_readability', sizeCaption: 'Lune · agrandie' } : null,
    presentation: { frame: plan.frame, viewport: { width: plan.width, height: plan.height },
      occlusionZones: plan.zones.map(r => r.id),
      objects: plan.objects.map(o => ({ id: o.id, rendered: !!(receipt.visible && o.rendered),
        hiddenBy: receipt.visible ? o.hiddenBy : 'display_hidden', labelled: !!(receipt.visible && o.label) })) }
  };
}

module.exports = { describeSky };
