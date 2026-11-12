/* Pure geometry and label placement, shared by Core, the real canvas and ArtX lab. */
(function (root) {
  'use strict';
  const DEFAULT_FRAME = Object.freeze({ center: 180, span: 220, horizon: 0.84, top: 0.1 });
  const OVERLAYS = Object.freeze([
    { id: 'clock', x: 0.28, y: 0, w: 0.44, h: 0.26 },
    { id: 'bar', x: 0, y: 0.89, w: 1, h: 0.11 }
  ]);
  const finite = (v, fallback) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  function frame(options = {}) {
    const center = ((finite(options.center, 180) % 360) + 360) % 360;
    const span = Math.max(60, Math.min(360, finite(options.span, 220)));
    const { horizon, top } = DEFAULT_FRAME;
    const project = point => {
      const offset = ((point.azDeg - center) % 360 + 540) % 360 - 180;
      return { x: 0.5 + offset / span, y: horizon - point.altDeg / 90 * (horizon - top), offset };
    };
    return { center, span, horizon, top, project,
      unproject: ({ x, y }) => ({ azDeg: ((center + (x - 0.5) * span) % 360 + 360) % 360,
        altDeg: (horizon - y) / (horizon - top) * 90 }),
      visible: p => Number.isFinite(p.altDeg) && Number.isFinite(p.azDeg)
        && p.altDeg >= 0 && p.altDeg <= 90 && Math.abs(project(p).offset) <= span / 2 };
  }
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const contains = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  function dimensions(value = {}) {
    return { width: Math.max(1, Math.min(7680, finite(value.width, 1920))),
      height: Math.max(1, Math.min(4320, finite(value.height, 1080))) };
  }
  function zones(options = {}) {
    const { width, height } = dimensions(options);
    // Reserve the assembled portrait, including its forehead and chin. Its
    // framing fits the limiting viewport axis; a fixed percentage box misses
    // the sides in portrait and the lower face in landscape. This is a safe
    // presentation envelope, not a measurement of the avatar's pixels.
    const h = Math.min(0.84, 0.88 * width / height / 0.62);
    const w = h * height / width * 0.62;
    return [{ id: 'face', x: (1 - w) / 2, y: (1 - h) / 2, w, h }, ...OVERLAYS.map(r => ({ ...r }))];
  }
  function plan(sky, background, options = {}) {
    const view = frame(options), { width, height } = dimensions(options);
    const reserved = zones(options), face = reserved.find(r => r.id === 'face');
    const fontPx = Math.max(14, height * 0.018), compassPx = Math.max(16, height * 0.022);
    const labels = [], occupied = [...reserved], objects = [];
    function label(id, text, anchor, size = fontPx) {
      const compass = id.startsWith('compass-');
      // Conservative fixed geometry; renderer uses the same bounded monospace box.
      const w = Math.max(20, (Array.from(text).length * 0.67 + 1) * size) / width;
      const h = size * 1.5 / height, gap = 12 / height;
      const candidates = [
        { x: anchor.x - w / 2, y: anchor.y + gap },
        { x: anchor.x - w / 2, y: anchor.y - h - gap },
        { x: anchor.x + 16 / width, y: anchor.y - h / 2 },
        { x: anchor.x - w - 16 / width, y: anchor.y - h / 2 }
      ];
      // A compass caption names this exact azimuth. Unlike a body with a
      // leader, it cannot move sideways to make room for the portrait.
      if (compass) candidates.length = 2;
      // A hidden body keeps its true anchor; its caption may sit beside Nestor.
      if (!compass && contains(face, anchor)) {
        const y = Math.max(0.27, Math.min(0.88 - h, anchor.y));
        candidates.unshift({ x: face.x + face.w + 12 / width, y },
          { x: face.x - w - 12 / width, y });
      }
      const box = candidates.map(r => ({ ...r, w, h })).find(r => r.x >= 0.01 && r.y >= 0.01
        && r.x + w <= 0.99 && r.y + h <= 0.88 && !occupied.some(z => overlap(r, z)));
      if (!box) return null;
      occupied.push(box);
      const result = { id, text, ...box, fontPx: size, anchor: { x: anchor.x, y: anchor.y } };
      labels.push(result); return result;
    }
    function body(id, type, point, text, radiusPx) {
      if (!point) return;
      const screen = view.project(point), inFrame = view.visible(point);
      const radius = radiusPx / height;
      const area = { x: screen.x - radiusPx / width, y: screen.y - radius,
        w: radiusPx * 2 / width, h: radius * 2 };
      const hiddenBy = inFrame ? reserved.find(z => overlap(area, z))?.id || null : point.altDeg < 0 ? 'below_horizon' : 'outside_panorama';
      const item = { id, type, screen, inFrame, hiddenBy, radiusPx, rendered: inFrame && !hiddenBy };
      objects.push(item);
      if (inFrame) item.label = label(id, hiddenBy === 'face' ? text + ' · derrière moi' : text, screen);
    }
    if (background?.sky && sky) {
      if (background.light !== 'night') body('sun', 'sun', sky.sun, 'Soleil · agrandi', height * 0.018);
      body('moon', 'moon', sky.moon, 'Lune · agrandie', height * 0.035);
      if (background.light !== 'day') {
        for (const p of sky.planets || []) if (p.sunSeparationDeg >= 10) body(p.id, 'planet', p, p.name,
          Math.max(2, 3.4 - 0.5 * p.mag) * height / 1080);
      }
      for (const [text, azDeg] of [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SO', 225], ['O', 270], ['NO', 315]]) {
        const p = { azDeg, altDeg: 0 };
        if (view.visible(p)) label('compass-' + text, text, view.project(p), compassPx);
      }
      if (background.sky === 'full') {
        const byName = new Map((sky.stars || []).filter(p => view.visible(p)).map(p => [p.name, view.project(p)]));
        for (const figure of sky.figures || []) {
          const points = figure.lines.flat().map(name => byName.get(name));
          if (points.length && points.every(Boolean)) label('figure-' + figure.name, figure.name,
            { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: Math.max(...points.map(p => p.y)) });
        }
      }
    }
    return { frame: { kind: 'panorama', centerAzDeg: view.center, spanDeg: view.span }, width, height, zones: reserved, objects, labels };
  }
  const api = { DEFAULT_FRAME, ZONES: Object.freeze(zones()), zones, frame, plan, dimensions, overlap, contains };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NestorSkyLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
