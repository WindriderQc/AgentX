/* What Nestor's full screen shows on its own, from /api/family/ambient (family-ambient.js).
   Pure: no DOM, no clock of its own, so the same rules are tested under Node.
   Importance, highest first: the conversation, a critical alert, the ISS passing
   or about to pass, other alerts, Nestor painting a picture, then the weather.
   A conversation in progress keeps only the background; nothing here ever speaks. */
(function (root) {
  'use strict';
  const MINUTE = 60000;
  const ISS_NOTICE_MS = 20 * MINUTE;   // countdown chip before a naked-eye pass
  const ISS_MOMENT_MS = 3 * MINUTE;    // the sky scene opens this long before the pass
  const ISS_LINGER_MS = MINUTE;        // and stays a moment after it
  const VISIT_COOLDOWN_MS = 6 * 60 * MINUTE; // one guided visit per alert set and machine
  const QUIET_FROM = 22, QUIET_TO = 7; // no guided visit at night in the kitchen
  const MAX_CHIPS = 3;
  const PAINT_IDLE_MS = 2 * MINUTE;     // Nestor paints only after a quiet moment
  const PAINT_EVERY_MS = 15 * MINUTE;   // and at most one picture per quarter hour
  const PAINT_MS = 80 * 1000;           // painting, a look at the result, then it fades

  // Weather → the background's particles. Unknown weather keeps a calm, empty sky.
  function background(snapshot, { hour = 12 } = {}) {
    const weather = snapshot?.weather || null;
    const sun = typeof snapshot?.sun?.elevationDeg === 'number' ? snapshot.sun.elevationDeg : null;
    const light = sun === null ? (hour >= 7 && hour < 18 ? 'day' : 'night') : sun > 6 ? 'day' : sun > -6 ? 'twilight' : 'night';
    const kind = weather?.kind || 'unknown';
    const base = { snow: 0.6, rain: 0.6, storm: 0.9, fog: 0.5, cloud: 0.4, clear: 0.3, unknown: 0 }[kind] ?? 0;
    const strength = weather?.strength === 'light' ? 0.55 : weather?.strength === 'heavy' ? 1.4 : 1;
    const windKmh = Math.max(weather?.windKmh || 0, (weather?.gustKmh || 0) * 0.7);
    return {
      kind, light,
      intensity: Math.round(Math.min(1, base * strength) * 100) / 100,
      wind: Math.round(Math.min(1, windKmh / 60) * 100) / 100,
      calm: hour >= QUIET_FROM || hour < QUIET_TO
    };
  }

  function minutesText(ms) {
    const minutes = Math.max(1, Math.round(ms / MINUTE));
    return minutes === 1 ? '1 min' : `${minutes} min`;
  }

  function weatherChip(weather) {
    if (!weather) return null;
    const parts = [];
    if (typeof weather.temperatureC === 'number') parts.push(`${Math.round(weather.temperatureC)} °C`);
    if (weather.condition) parts.push(weather.condition);
    return parts.length ? { id: 'weather', tone: 'calm', text: parts.join(' · ') } : null;
  }

  // The ISS: a chip before the pass, then the sky scene around it.
  function issState(snapshot, at) {
    const next = snapshot?.iss?.next;
    if (!next) return null;
    const start = Date.parse(next.start), end = Date.parse(next.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || at > end + ISS_LINGER_MS) return null;
    const cloudy = ['cloud', 'rain', 'snow', 'storm', 'fog'].includes(snapshot?.weather?.kind);
    const sky = cloudy ? 'ciel couvert : peut-être caché' : 'visible si le ciel est dégagé';
    const path = next.from && next.to ? `${next.from} → ${next.to}` : '';
    if (at < start - ISS_NOTICE_MS) return null;
    const phase = at < start ? 'approach' : at <= end ? 'passing' : 'after';
    const text = phase === 'approach' ? `ISS dans ${minutesText(start - at)}${path ? ' · ' + path : ''}`
      : phase === 'passing' ? `ISS au-dessus de nous${path ? ' · ' + path : ''}` : 'L’ISS vient de passer';
    return {
      chip: { id: 'iss', tone: 'sky', text: `${text} · ${sky}` },
      moment: at >= start - ISS_MOMENT_MS ? { kind: 'iss', phase, pass: next, cloudy } : null
    };
  }

  function alertChip(alerts) {
    if (!alerts?.count) return null;
    const critical = alerts.critical > 0;
    const text = critical ? (alerts.critical === 1 ? 'Système : un problème important' : `Système : ${alerts.critical} problèmes importants`)
      : alerts.count === 1 ? 'Système : un point à surveiller' : `Système : ${alerts.count} points à surveiller`;
    return { id: 'alert', tone: critical ? 'critical' : 'attention', text };
  }

  function visitKey(alerts) { return `${alerts.fingerprint || alerts.count}:${(alerts.nodes || []).join(',')}`; }

  // A guided visit to the machine an alert names: rare, by day, only in standby.
  function alertVisit(alerts, { at, hour, visits = {} }) {
    if (!alerts?.count || !alerts.nodes?.length) return null;
    if (hour >= QUIET_FROM || hour < QUIET_TO) return null;
    const key = visitKey(alerts);
    if (visits[key] && at - visits[key] < VISIT_COOLDOWN_MS) return null;
    return { kind: 'visit', key, play: ['overview', ...alerts.nodes.map(node => `node-${node}`)].join(','),
      label: alerts.nodes.length === 1 ? 'Nestor montre la machine concernée' : 'Nestor montre les machines concernées' };
  }

  // Nestor the painter: by day, after a quiet moment, the picture painted longest ago (never
  // painted first; the family's drawings before the Atelier's on a tie, as listed by Core).
  const PAINT_LABEL = { family: 'Nestor peint un de vos dessins', atelier: 'Nestor peint une création de l’atelier' };
  function paintMoment(paintings, { at, hour, idleMs = 0, painted = {}, lastPaint = 0 }) {
    const pool = Array.isArray(paintings) ? paintings.filter(item => item?.id && PAINT_LABEL[item.source]) : [];
    if (!pool.length || hour >= QUIET_FROM || hour < QUIET_TO) return null;
    if (idleMs < PAINT_IDLE_MS || at - lastPaint < PAINT_EVERY_MS) return null;
    const pick = pool.map((item, index) => ({ item, index }))
      .sort((a, b) => (painted[a.item.id] || 0) - (painted[b.item.id] || 0) || a.index - b.index)[0].item;
    return { kind: 'paint', id: pick.id, source: pick.source, label: PAINT_LABEL[pick.source] };
  }

  // The whole decision. `standby` is false while someone talks with Nestor.
  function chooseScreen(snapshot, { at = Date.now(), hour = new Date(at).getHours(), standby = true, visits = {},
    idleMs = 0, painted = {}, lastPaint = 0, painting = null } = {}) {
    const scene = { background: background(snapshot, { hour }), chips: [], moment: null };
    if (!standby || !snapshot) return scene;
    const iss = issState(snapshot, at);
    const alerts = snapshot.alerts;
    const critical = alerts?.critical > 0;
    scene.moment = iss?.moment || alertVisit(alerts, { at, hour, visits })
      // A picture already being painted continues until it ends; only the moments above stop it.
      || (painting?.kind === 'paint' ? painting : paintMoment(snapshot.paintings, { at, hour, idleMs, painted, lastPaint }));
    const paintChip = scene.moment?.kind === 'paint' ? { id: 'paint', tone: 'calm', text: scene.moment.label } : null;
    const ranked = [critical && alertChip(alerts), iss?.chip, !critical && alertChip(alerts), paintChip, weatherChip(snapshot.weather)];
    scene.chips = ranked.filter(Boolean).slice(0, MAX_CHIPS);
    return scene;
  }

  // Where the pass is drawn: azimuth (0 = north, clockwise) and elevation in degrees,
  // from rise to set through the highest point. Missing azimuths use the compass words.
  const COMPASS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180,
    SSO: 202.5, SO: 225, OSO: 247.5, O: 270, ONO: 292.5, NO: 315, NNO: 337.5, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
  function passArc(pass, steps = 48) {
    const from = typeof pass?.fromAzDeg === 'number' ? pass.fromAzDeg : COMPASS[String(pass?.from || '').toUpperCase()];
    const to = typeof pass?.toAzDeg === 'number' ? pass.toAzDeg : COMPASS[String(pass?.to || '').toUpperCase()];
    if (typeof from !== 'number' || typeof to !== 'number') return [];
    let sweep = ((to - from) % 360 + 540) % 360 - 180; // shortest way round
    if (typeof pass.maxAzDeg === 'number') {
      const toMax = ((pass.maxAzDeg - from) % 360 + 540) % 360 - 180;
      if (Math.sign(toMax) && Math.sign(toMax) !== Math.sign(sweep)) sweep += sweep > 0 ? -360 : 360;
    }
    const peak = Math.max(5, Math.min(90, pass.maxElDeg || 30));
    const low = [pass.fromElDeg, pass.toElDeg].map(value => (typeof value === 'number' ? value : 10));
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const edge = low[0] + (low[1] - low[0]) * t;
      points.push({ t, azDeg: ((from + sweep * t) % 360 + 360) % 360, elDeg: edge + (peak - edge) * Math.sin(Math.PI * t) });
    }
    return points;
  }

  // How far the station is along its visible path, 0..1, or null outside the pass.
  function passProgress(pass, at) {
    const start = Date.parse(pass?.start), end = Date.parse(pass?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || at < start || at > end) return null;
    return (at - start) / (end - start);
  }

  // The painting's timeline, from its start: brush strokes, the finished picture, then a fade.
  function paintPhase(elapsedMs) {
    const t = elapsedMs / PAINT_MS;
    if (!(t >= 0) || t >= 1) return null;
    if (t < 0.5) return { phase: 'painting', progress: t / 0.5 };
    if (t < 0.58) return { phase: 'revealing', progress: (t - 0.5) / 0.08 };
    if (t < 0.9) return { phase: 'showing', progress: (t - 0.58) / 0.32 };
    return { phase: 'fading', progress: (t - 0.9) / 0.1 };
  }

  const api = { background, chooseScreen, paintMoment, paintPhase, passArc, passProgress, visitKey, minutesText,
    ISS_NOTICE_MS, ISS_MOMENT_MS, VISIT_COOLDOWN_MS, MAX_CHIPS, PAINT_IDLE_MS, PAINT_EVERY_MS, PAINT_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NestorAmbientChoice = api;
})(typeof window !== 'undefined' ? window : globalThis);
