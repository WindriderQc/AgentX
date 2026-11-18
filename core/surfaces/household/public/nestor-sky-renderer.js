/* Production sky painter. The lab calls this same code through NestorAmbient. */
(function (root) {
  'use strict';
  const Layout = typeof module === 'object' && module.exports ? require('./nestor-sky-layout') : root.NestorSkyLayout;
  const COLORS = { venus: '#fffbe8', mars: '#ffb08a', jupiter: '#fff0d0', saturn: '#f3dca0' };
  const LABEL_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const LABEL_STYLES = {
    body: { font: 'normal', color: 'rgba(226,238,246,0.82)' },
    figure: { font: 'italic', color: 'rgba(176,210,236,0.72)' },
    compass: { font: '600', color: 'rgba(167,204,223,0.55)' }
  };
  const STOPS = [
    [-18, '#02060d', '#08172a'], [-12, '#081027', '#25213b'], [-6, '#182747', '#845654'],
    [-2, '#294b70', '#bf8b78'], [2, '#367ba5', '#b9c7ca'], [10, '#287fae', '#b5dae6'], [30, '#207cba', '#bde4f1']
  ];
  function palette(altitude) {
    const a = Math.round(altitude * 2) / 2;
    const i = STOPS.findIndex(s => s[0] >= a);
    if (i <= 0) return (i < 0 ? STOPS.at(-1) : STOPS[0]).slice(1);
    const low = STOPS[i - 1], high = STOPS[i], t = (a - low[0]) / (high[0] - low[0]);
    return [1, 2].map(n => '#' + [1, 3, 5].map(k => Math.round(parseInt(low[n].slice(k, k + 2), 16) * (1 - t)
      + parseInt(high[n].slice(k, k + 2), 16) * t).toString(16).padStart(2, '0')).join(''));
  }
  let cached = null;
  function draw(c, box, bg, sky, at, { reducedMotion = false, center = 180, span = 220 } = {}) {
    const width = box.width, height = box.height, ratio = box.ratio;
    const key = [width, height, ratio, bg.sky, bg.light, center, span].join('|');
    if (!cached || cached.sky !== sky || cached.key !== key) cached = { sky, key, plan: Layout.plan(sky, bg, { width: width / ratio, height: height / ratio, center, span }) };
    const plan = cached.plan;
    const view = Layout.frame({ center, span });
    const place = p => { const q = view.project(p); return { x: q.x * width, y: q.y * height }; };
    const hidden = (p, radius = 0) => plan.zones.some(z => Layout.overlap(
      { x: p.x / width - radius / width, y: p.y / height - radius / height, w: Math.max(0.0001, 2 * radius / width), h: Math.max(0.0001, 2 * radius / height) }, z));
    c.save(); c.globalAlpha = 1;
    c.strokeStyle = 'rgba(160,200,225,0.45)'; c.lineWidth = ratio;
    c.beginPath(); c.moveTo(0, height * 0.84); c.lineTo(width, height * 0.84); c.stroke();
    const stars = (sky.stars || []).filter(p => view.visible(p) && bg.light !== 'day' && (bg.sky === 'full' || p.mag <= 0.6));
    const byName = new Map(stars.map(p => [p.name, place(p)]));
    if (bg.sky === 'full') {
      c.strokeStyle = 'rgba(150,190,230,0.24)';
      for (const figure of sky.figures || []) for (const [a, b] of figure.lines) {
        const p = byName.get(a), q = byName.get(b);
        if (!p || !q || hidden(p) || hidden(q)) continue;
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke();
      }
    }
    c.fillStyle = '#e9f0ff';
    stars.forEach((star, i) => {
      const p = place(star); if (hidden(p, 3 * ratio)) return;
      const twinkle = reducedMotion ? 1 : 0.9 + 0.1 * Math.sin(at / 1000 * (1.1 + i % 7 * 0.23) + i * 1.7);
      c.globalAlpha = Math.max(0.3, Math.min(1, 1.05 - 0.22 * star.mag)) * twinkle * (star.altDeg < 12 ? 0.45 + star.altDeg * 0.045 : 1);
      c.beginPath(); c.arc(p.x, p.y, Math.max(0.7, 2.6 - 0.75 * star.mag) * ratio, 0, Math.PI * 2); c.fill();
    });
    c.globalAlpha = 1;
    for (const item of plan.objects.filter(o => o.rendered)) {
      const x = item.screen.x * width, y = item.screen.y * height, r = item.radiusPx * ratio;
      c.save(); c.translate(x, y);
      if (item.type === 'moon') {
        const k = Math.max(0, Math.min(1, sky.moon.illumination));
        // Bright-limb orientation is a local tangent vector, not a line between
        // two distant points in an equirectangular panorama.
        const m = sky.moon, s = sky.sun;
        if (s) {
          const rad = Math.PI / 180, delta = (s.azDeg - m.azDeg) * rad;
          const east = Math.cos(s.altDeg * rad) * Math.sin(delta);
          const up = Math.cos(m.altDeg * rad) * Math.sin(s.altDeg * rad)
            - Math.sin(m.altDeg * rad) * Math.cos(s.altDeg * rad) * Math.cos(delta);
          c.rotate(Math.atan2(-up * height * 0.74 / 90, east / Math.max(0.001, Math.cos(m.altDeg * rad)) * width / span));
        }
        c.fillStyle = '#354355'; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#f3efe2'; c.beginPath(); c.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
        const a = r * Math.abs(1 - 2 * k);
        if (k < 0.5) c.ellipse(0, 0, a, r, 0, Math.PI / 2, -Math.PI / 2, true);
        else c.ellipse(0, 0, a, r, 0, Math.PI / 2, Math.PI * 1.5, false);
        c.fill();
      } else {
        const color = item.type === 'sun' ? '#ffe6a5' : COLORS[item.id] || '#fff';
        const glow = c.createRadialGradient(0, 0, 0, 0, 0, r * 3);
        glow.addColorStop(0, color); glow.addColorStop(1, 'rgba(255,255,255,0)');
        c.globalAlpha = 0.24; c.fillStyle = glow; c.beginPath(); c.arc(0, 0, r * 3, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1; c.fillStyle = color; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    }
    // Unboxed captions: light sans-serif text with a thin dark halo, which
    // stays readable on the night sky and on a bright day sky alike.
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    c.strokeStyle = 'rgba(2,6,13,0.55)'; c.lineWidth = 3 * ratio;
    for (const label of plan.labels) {
      const style = LABEL_STYLES[label.kind] || LABEL_STYLES.body;
      const x = (label.x + label.w / 2) * width, y = (label.y + label.h / 2) * height, w = label.w * width;
      c.font = `${style.font} ${label.fontPx * ratio}px ${LABEL_FONT}`; c.fillStyle = style.color;
      c.strokeText(label.text, x, y, w); c.fillText(label.text, x, y, w);
    }
    c.restore(); return plan;
  }
  const api = { draw, palette };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NestorSkyRenderer = api;
})(typeof window !== 'undefined' ? window : globalThis);
