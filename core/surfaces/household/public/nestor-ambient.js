/* Nestor's living full screen on Famille: a sky that follows the real weather behind him
   (after sunset, the real Moon, planets and stars above the house),
   the weather beside the date, a few short notes under the clock, the ISS drawn across the sky when it passes, now and
   then a silent guided visit of the connected house to the machine an alert names, and,
   when the kitchen is quiet, Nestor painting one of the family's pictures with particles.
   The rules live in nestor-ambient-choice.js. Nothing here speaks, listens or sends a turn:
   talking to Nestor (or typing) removes everything but the background, and Escape closes
   what he shows. Only the full-screen "plein" view is decorated. */
(function (root) {
  'use strict';
  const POLL_MS = 2 * 60 * 1000;
  const DECIDE_MS = 5000;
  const FRAME_MS = 1000 / 30;
  const VISITS_KEY = 'household.nestor.ambient.visits';
  const PAINT_KEY = 'household.nestor.ambient.paintings';
  const PAINT_LOAD_MS = 20000;
  // Awake listening is part of a conversation; listening or hearing while asleep (waiting
  // for "Hey Nestor") is standby.
  const ACTIVE_STATES = ['listening', 'hearing', 'transcribing', 'waiting', 'thinking', 'preparing', 'speaking', 'error'];
  // Small line icons for the weather beside the date (24 x 24, drawn with currentColor).
  const CLOUD = 'M7 15h10a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 6.6 8.6 3.2 3.2 0 0 0 7 15z';
  const WEATHER_PATHS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
    night: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.3 6.3 0 0 0 10 10z"/>',
    cloud: '<path d="M7 19h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 12 3.5 3.5 0 0 0 7 19z"/>',
    rain: `<path d="${CLOUD}"/><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3"/>`,
    snow: `<path d="${CLOUD}"/><path d="M8.5 19h.01M12.5 21h.01M16.5 19h.01" stroke-width="2.6"/>`,
    storm: `<path d="${CLOUD}"/><path d="M13 16.5l-2.2 3.5h3l-1.8 3"/>`,
    fog: '<path d="M4 8h16M6 12h13M4 16h16M8 20h9"/>'
  };

  function readVisits() {
    try { return JSON.parse(root.localStorage?.getItem(VISITS_KEY) || '{}') || {}; } catch { return {}; }
  }
  function saveVisits(visits) {
    try { root.localStorage?.setItem(VISITS_KEY, JSON.stringify(visits)); } catch { /* per-device convenience only */ }
  }
  // Which pictures this screen painted, and when it last painted: a per-device convenience.
  function readPaintLog() {
    try {
      const value = JSON.parse(root.localStorage?.getItem(PAINT_KEY) || '{}') || {};
      return { painted: value.painted && typeof value.painted === 'object' ? value.painted : {}, last: Number(value.last) || 0 };
    } catch { return { painted: {}, last: 0 }; }
  }
  function savePaintLog(log) {
    try { root.localStorage?.setItem(PAINT_KEY, JSON.stringify(log)); } catch { /* per-device convenience only */ }
  }

  function mount({ space = 'family', documentRef = root.document, now = () => Date.now(), fetchImpl = root.fetch?.bind(root) } = {}) {
    const Choice = root.NestorAmbientChoice;
    const doc = documentRef;
    if (!Choice || !doc?.body) return null;
    const reducedMotion = !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const artx = root.NestorArtx?.create({ now, fetchImpl });
    const canvas = doc.createElement('canvas');
    canvas.className = 'nestor-ambient-sky';
    canvas.setAttribute('aria-hidden', 'true');
    const chips = doc.createElement('ul');
    chips.className = 'nestor-ambient-chips';
    chips.setAttribute('aria-label', 'Nestor · en ce moment');
    chips.setAttribute('aria-live', 'polite');
    const visit = doc.createElement('section');
    visit.className = 'nestor-ambient-visit';
    visit.hidden = true;
    visit.setAttribute('aria-label', 'Visite guidée de la maison');
    visit.innerHTML = '<p class="nestor-ambient-visit-label"></p>';
    const weather = doc.createElement('span');
    weather.className = 'nestor-ambient-weather';
    weather.hidden = true;
    doc.body.append(chips, visit);

    let snapshot = null, state = 'idle', sample = null, scene = null, disposed = false;
    let frame = 0, lastFrame = 0, particles = [], particleKind = '', flash = 0;
    let visitKey = null, visitMoment = null, visitTimer = null, dismissed = new Set(), visits = readVisits();
    let paintLog = readPaintLog(), standbySince = null, painting = null, paintedTaskId = null;
    const ctx = canvas.getContext?.('2d') || null;

    const dock = () => doc.querySelector('.avatar-dock');
    const photosShown = () => !!doc.querySelector('.nestor-idle-photos:not([hidden])');
    const plein = () => dock()?.dataset.view === 'plein';
    const typing = () => {
      const active = doc.activeElement;
      return !!(active?.matches?.('input, textarea') && active.value?.trim());
    };
    const asleep = () => ['listening', 'hearing'].includes(state) && !!sample?.asleep?.();
    const standby = () => !(ACTIVE_STATES.includes(state) && !asleep()) && !typing();
    const momentId = moment => (moment?.kind === 'iss' ? 'iss:' + moment.pass.start : moment?.kind === 'visit' ? 'visit:' + moment.key
      : moment?.kind === 'paint' ? 'paint:' + moment.id : null);

    async function poll() {
      if (disposed || doc.hidden || !fetchImpl) return;
      try {
        const response = await fetchImpl('/api/family/ambient' + (artx ? '?displayId=' + encodeURIComponent(artx.displayId) : ''), { credentials: 'same-origin', cache: 'no-store' });
        const body = await response.json();
        if (response.ok && body?.data) snapshot = body.data;
      } catch { /* keep the last snapshot; the sky stays calm without one */ }
      decide();
    }

    function decide() {
      if (disposed) return;
      const at = now();
      const quiet = standby();
      if (!quiet) standbySince = null; else if (standbySince === null) standbySince = at;
      const next = Choice.artxScene(Choice.chooseScreen(snapshot, { at, standby: quiet, visits, painted: paintLog.painted, lastPaint: paintLog.last,
        idleMs: standbySince === null || photosShown() ? 0 : at - standbySince, painting: painting?.moment || null }), snapshot, snapshot?.artx?.task, quiet);
      if (next.moment && dismissed.has(momentId(next.moment))) next.moment = null;
      if (next.moment?.kind === 'paint' && next.artxTaskId === paintedTaskId) next.moment = null;
      // An open visit is already recorded (cooldown) but keeps the screen until its tour ends.
      if (!next.moment && visitMoment && standby()) next.moment = visitMoment;
      scene = next;
      renderWeather(at);
      const host = dock();
      if (host && canvas.parentElement !== host) host.prepend(canvas);
      const shown = plein() && !photosShown();
      artx?.tick({ snapshot, quiet, visible: shown && !doc.hidden && !!ctx });
      renderChips(shown ? next.chips : []);
      if (next.moment?.kind === 'visit' && shown) openVisit(next.moment, at); else if (next.moment?.kind !== 'visit') closeVisit();
      if (next.moment?.kind === 'paint' && shown) startPaint(next.moment); else if (painting) endPaint();
      if (next.moment?.kind !== 'iss' && next.background.kind !== particleKind) { particleKind = next.background.kind; particles = []; }
      if (shown && !frame) frame = root.requestAnimationFrame?.(draw) || 0;
    }

    // Beside the date whenever the clock shows, standby or not; hidden when there is no recent reading.
    function renderWeather(at) {
      const line = doc.querySelector('.avatar-scene-line');
      if (line && weather.parentElement !== line) line.append(weather);
      const reading = Choice.weatherLine(snapshot, { at });
      const key = reading ? reading.icon + '|' + reading.text : '';
      if (weather.dataset.key === key) return;
      weather.dataset.key = key;
      weather.hidden = !reading;
      weather.replaceChildren();
      if (!reading) return;
      if (WEATHER_PATHS[reading.icon]) {
        weather.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 24 24" aria-hidden="true">${WEATHER_PATHS[reading.icon]}</svg>`);
      }
      const text = doc.createElement('span');
      text.textContent = reading.text;
      weather.append(text);
    }

    function renderChips(list) {
      const text = list.map(chip => chip.id + chip.tone + chip.text).join('|');
      if (chips.dataset.text === text) return;
      chips.dataset.text = text;
      chips.replaceChildren(...list.map(chip => {
        const item = doc.createElement('li');
        item.className = 'nestor-ambient-chip';
        item.dataset.tone = chip.tone;
        item.textContent = chip.text;
        return item;
      }));
      chips.hidden = !list.length;
    }

    function openVisit(moment, at) {
      if (visitKey === moment.key) return;
      const pages = root.AgentXScreenPages;
      const target = pages?.parse('ecosystem play=' + moment.play);
      const src = target && pages.url(target);
      if (!src) return;
      closeVisit();
      visitKey = moment.key; visitMoment = moment;
      visits = { ...Object.fromEntries(Object.entries(visits).filter(([, time]) => at - time < Choice.VISIT_COOLDOWN_MS)), [moment.key]: at };
      saveVisits(visits);
      const iframe = doc.createElement('iframe');
      iframe.className = 'nestor-ambient-visit-frame';
      const silent = new URL(src, root.location.origin);
      silent.searchParams.set('voice', 'off');
      iframe.src = silent.href;
      iframe.title = 'Visite guidée de la maison connectée';
      iframe.tabIndex = -1;
      iframe.referrerPolicy = 'no-referrer';
      visit.querySelector('.nestor-ambient-visit-label').textContent = moment.label;
      visit.append(iframe);
      visit.hidden = false;
      // The tour holds about 7 s on the overview and 9 s per machine.
      const steps = moment.play.split(',').length;
      visitTimer = root.setTimeout(() => { dismissed.add('visit:' + moment.key); closeVisit(); }, (7 + 9 * (steps - 1) + 6) * 1000);
    }

    function closeVisit() {
      if (visitKey === null) return;
      root.clearTimeout(visitTimer);
      visitKey = null; visitMoment = null;
      visit.hidden = true;
      visit.querySelector('iframe')?.remove();
    }

    // ---- the painter ---------------------------------------------------------------------
    // The picture is cut into colour dabs. A first, coarse layer flies out from Nestor in a
    // burst, then finer dabs follow in serpentine brush strokes, band after band. Landed dabs
    // stay on an offscreen layer, so each frame only draws the dabs in flight. The finished
    // picture then replaces the dabs, stays a while and fades into the sky.
    function startPaint(moment) {
      if (painting?.moment.id === moment.id) return;
      endPaint();
      const image = new root.Image();
      const run = painting = { moment, taskId: scene?.artxTaskId, image, startedAt: null, requestedAt: now() };
      image.decoding = 'async';
      image.onload = () => { if (painting === run) { run.startedAt = now(); run.box = null; } };
      image.onerror = () => { if (painting === run) { endPaint(); decide(); } };
      image.src = '/api/family/ambient/paintings/' + encodeURIComponent(moment.id);
    }

    function endPaint() {
      if (!painting) return;
      const at = now(), pool = new Set((snapshot?.paintings || []).map(item => item.id));
      const painted = Object.fromEntries(Object.entries(paintLog.painted).filter(([id]) => pool.has(id)));
      paintLog = { painted: { ...painted, [painting.moment.id]: at }, last: at };
      savePaintLog(paintLog);
      paintedTaskId = painting.taskId;
      painting.image.onload = painting.image.onerror = null;
      painting = null;
    }

    function preparePaint(run, b) {
      const { width, height, ratio } = b, image = run.image;
      // On a wide screen the canvas is an easel to Nestor's right, so he never hides the subject;
      // on a narrow one it stands behind him. Either way it stays between the clock with its
      // notes and the bar at the bottom.
      const wide = width >= height * 1.2, short = Math.min(width, height);
      const area = wide ? { x: width * 0.58, y: height * 0.19, w: width * 0.38, h: height * 0.6 }
        : { x: width * 0.05, y: height * 0.19, w: width * 0.9, h: height * 0.6 };
      const scale = Math.min(area.w / image.naturalWidth, area.h / image.naturalHeight);
      const dw = Math.round(image.naturalWidth * scale), dh = Math.round(image.naturalHeight * scale);
      const dx = Math.round(area.x + (area.w - dw) / 2), dy = Math.round(area.y + (area.h - dh) / 2);
      const hand = wide ? { x: width / 2 + short * 0.13, y: height * 0.55, reach: short * 0.04 }
        : { x: width / 2, y: height * 0.5, reach: short * 0.08 };
      const sample = (cols, rows) => {
        const grid = doc.createElement('canvas');
        grid.width = cols; grid.height = rows;
        const g = grid.getContext('2d', { willReadFrequently: true });
        g.drawImage(image, 0, 0, cols, rows);
        return g.getImageData(0, 0, cols, rows).data;
      };
      const dabs = [];
      const layerOf = (cell, start, span, order) => {
        const cols = Math.max(4, Math.round(dw / cell)), rows = Math.max(4, Math.round(dh / cell));
        const data = sample(cols, rows), cw = dw / cols, ch = dh / rows;
        for (let r = 0; r < rows; r += 1) {
          for (let c = 0; c < cols; c += 1) {
            const i = (r * cols + c) * 4;
            dabs.push({ x: dx + (c + 0.5) * cw, y: dy + (r + 0.5) * ch, w: cw * 1.35, h: ch * 1.35,
              color: `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`, tilt: (Math.random() - 0.5) * 0.8,
              t0: start + span * Math.min(1, Math.max(0, order(c, r, cols, rows))), bend: (Math.random() - 0.5) * 0.5 });
          }
        }
      };
      const fine = Math.max(6 * ratio, Math.sqrt(dw * dh / 5000));
      // Coarse underpainting: a burst from the centre outwards.
      layerOf(fine * 4, 0, 0.24, (c, r, cols, rows) => Math.hypot((c + 0.5) / cols - 0.5, (r + 0.5) / rows - 0.5) / 0.71 + Math.random() * 0.08);
      // Fine strokes: seven bands, each swept left-right then right-left.
      layerOf(fine, 0.2, 0.72, (c, r, cols, rows) => {
        const bands = 7, band = Math.min(bands - 1, Math.floor(r / rows * bands));
        const along = band % 2 ? 1 - c / cols : c / cols;
        return (band + along * 0.92 + Math.random() * 0.12) / bands;
      });
      dabs.sort((a, b) => a.t0 - b.t0);
      const layer = doc.createElement('canvas');
      layer.width = width; layer.height = height;
      run.box = { width, height };
      run.frame = { dx, dy, dw, dh };
      run.hand = hand;
      run.dabs = dabs; run.next = 0; run.flying = [];
      run.layer = layer; run.layerCtx = layer.getContext('2d');
    }

    const FLIGHT = 0.06; // of the painting phase, about 2.4 s
    function drawPaint(c, b, at) {
      const run = painting;
      if (!run) return;
      if (run.startedAt === null) {
        if (at - run.requestedAt > PAINT_LOAD_MS) { endPaint(); decide(); }
        return;
      }
      const step = Choice.paintPhase(at - run.startedAt);
      if (!step) { endPaint(); decide(); return; }
      if (!run.box || run.box.width !== b.width || run.box.height !== b.height) preparePaint(run, b);
      const { dx, dy, dw, dh } = run.frame;
      if (reducedMotion) {
        c.globalAlpha = step.phase === 'painting' ? step.progress : step.phase === 'fading' ? 1 - step.progress : 1;
        c.drawImage(run.image, dx, dy, dw, dh); c.globalAlpha = 1;
        return;
      }
      const progress = step.phase === 'painting' ? step.progress : 1.2;
      // Launch the dabs whose time has come, land those that arrived.
      while (run.next < run.dabs.length && run.dabs[run.next].t0 <= progress) run.flying.push(run.dabs[run.next++]);
      const l = run.layerCtx, still = [];
      for (const dab of run.flying) {
        if ((progress - dab.t0) / FLIGHT >= 1) {
          // A short, slightly tilted brush mark rather than a square tile.
          l.fillStyle = dab.color; l.beginPath();
          l.ellipse(dab.x, dab.y, dab.w * 0.62, dab.h * 0.42, dab.tilt, 0, Math.PI * 2); l.fill();
        }
        else still.push(dab);
      }
      run.flying = still;
      const layerAlpha = step.phase === 'painting' ? 1 : step.phase === 'revealing' ? 1 - step.progress : 0;
      const imageAlpha = step.phase === 'revealing' ? step.progress : step.phase === 'showing' ? 1 : step.phase === 'fading' ? 1 - step.progress : 0;
      if (layerAlpha > 0) { c.globalAlpha = layerAlpha; c.drawImage(run.layer, 0, 0); }
      if (imageAlpha > 0) {
        const grow = step.phase === 'showing' ? 1 + 0.025 * step.progress : step.phase === 'fading' ? 1.025 : 1;
        const w = dw * grow, h = dh * grow;
        c.globalAlpha = imageAlpha;
        c.drawImage(run.image, dx - (w - dw) / 2, dy - (h - dh) / 2, w, h);
      }
      c.globalAlpha = 1;
      // Dabs in flight: bright points on a curve from Nestor's moving hand to their place.
      if (run.flying.length) {
        c.globalCompositeOperation = 'lighter';
        for (const dab of run.flying) {
          const u = (progress - dab.t0) / FLIGHT, ease = 1 - (1 - u) * (1 - u);
          const hx = run.hand.x + Math.cos(dab.t0 * 37) * run.hand.reach, hy = run.hand.y + Math.sin(dab.t0 * 23) * run.hand.reach * 0.6;
          const mx = (hx + dab.x) / 2 - (dab.y - hy) * dab.bend, my = (hy + dab.y) / 2 + (dab.x - hx) * dab.bend;
          const x = (1 - ease) * (1 - ease) * hx + 2 * (1 - ease) * ease * mx + ease * ease * dab.x;
          const y = (1 - ease) * (1 - ease) * hy + 2 * (1 - ease) * ease * my + ease * ease * dab.y;
          c.globalAlpha = 0.35 + 0.65 * (1 - u);
          c.fillStyle = dab.color;
          c.beginPath(); c.arc(x, y, Math.max(1.5 * b.ratio, Math.min(dab.w, dab.h) * (0.25 + 0.35 * (1 - u))), 0, Math.PI * 2); c.fill();
        }
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
      }
      c.strokeStyle = 'rgba(217,238,245,0.18)'; c.lineWidth = b.ratio;
      if (imageAlpha > 0.05) c.strokeRect(dx - 0.5, dy - 0.5, dw + 1, dh + 1);
    }

    // ---- the real night sky ----------------------------------------------------------------
    const PLANET_COLORS = { venus: '#fffbe8', mars: '#ffb08a', jupiter: '#fff0d0', saturn: '#f3dca0' };
    const COMPASS_MARKS = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SO', 225], ['O', 270], ['NO', 315]];
    function drawRealSky(c, b, bg, sky, at) {
      const { width, height, ratio } = b, full = bg.sky === 'full', dusk = bg.light === 'twilight';
      const frame = Choice.skyFrame(sky);
      const place = point => { const q = frame.project(point); return { x: q.x * width, y: q.y * height }; };
      const horizon = 0.84 * height, seconds = at / 1000;
      // The horizon and the compass, faint.
      c.globalAlpha = 1; c.strokeStyle = 'rgba(120,170,200,0.22)'; c.lineWidth = ratio;
      c.beginPath(); c.moveTo(0, horizon); c.lineTo(width, horizon); c.stroke();
      c.fillStyle = 'rgba(160,200,225,0.45)'; c.font = `${Math.round(13 * ratio)}px system-ui, sans-serif`; c.textAlign = 'center';
      for (const [label, azDeg] of COMPASS_MARKS) {
        if (!frame.visible({ azDeg, altDeg: 0 })) continue;
        const p = place({ azDeg, altDeg: 0 });
        if (p.x > 24 * ratio && p.x < width - 24 * ratio) c.fillText(label, p.x, horizon + 20 * ratio);
      }
      const stars = (sky.stars || []).filter(star => frame.visible(star) && (full || star.mag <= 0.6));
      // A few well-known figures, barely drawn, with their names.
      if (full) {
        const byName = new Map(stars.map(star => [star.name, place(star)]));
        c.strokeStyle = 'rgba(150,190,230,0.13)'; c.lineWidth = ratio;
        c.fillStyle = 'rgba(170,200,230,0.3)'; c.font = `${Math.round(12 * ratio)}px system-ui, sans-serif`;
        for (const figure of sky.figures || []) {
          const points = figure.lines.map(([a, z]) => [byName.get(a), byName.get(z)]);
          if (points.some(([a, z]) => !a || !z)) continue;
          c.beginPath();
          for (const [a, z] of points) { c.moveTo(a.x, a.y); c.lineTo(z.x, z.y); }
          c.stroke();
          const all = points.flat();
          c.fillText(figure.name, all.reduce((sum, p) => sum + p.x, 0) / all.length, Math.max(...all.map(p => p.y)) + 18 * ratio);
        }
      }
      // Stars: size and light by magnitude, a gentle twinkle, dimmer near the horizon.
      c.fillStyle = '#e9f0ff';
      stars.forEach((star, index) => {
        const p = place(star);
        const twinkle = reducedMotion ? 1 : 0.82 + 0.18 * Math.sin(seconds * (1.1 + (index % 7) * 0.23) + index * 1.7);
        const low = star.altDeg < 12 ? 0.45 + star.altDeg * 0.045 : 1;
        c.globalAlpha = Math.max(0.3, Math.min(1, 1.05 - 0.22 * star.mag)) * twinkle * low * (dusk ? 0.6 : 1);
        c.beginPath(); c.arc(p.x, p.y, Math.max(0.7, 2.6 - 0.75 * star.mag) * ratio, 0, Math.PI * 2); c.fill();
      });
      // Planets: steady, a touch of colour, named.
      c.font = `${Math.round(12 * ratio)}px system-ui, sans-serif`;
      const bodies = Choice.skyBodies(sky, bg);
      for (const planet of bodies.planets) {
        const p = place(planet), r = Math.max(1.8, 3.4 - 0.5 * planet.mag) * ratio, color = PLANET_COLORS[planet.id] || '#fff';
        const glow = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
        glow.addColorStop(0, color); glow.addColorStop(1, 'rgba(255,255,255,0)');
        c.globalAlpha = 0.35; c.fillStyle = glow; c.beginPath(); c.arc(p.x, p.y, r * 4, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1; c.fillStyle = color; c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 0.55; c.fillStyle = '#d9eef5'; c.fillText(planet.name, p.x, p.y + r + 15 * ratio);
      }
      c.globalAlpha = 1;
      if (bodies.moon) drawMoon(c, b, sky, place);
    }

    // The Moon, larger than life so its phase reads from across the kitchen. Its lit side faces
    // the Sun, wherever the Sun is below the horizon.
    function drawMoon(c, b, sky, place) {
      const moon = sky.moon, p = place(moon), sun = place(sky.sun || { azDeg: 180, altDeg: -30 });
      const R = Math.min(b.width, b.height) * 0.035, k = Math.max(0, Math.min(1, moon.illumination));
      const halo = c.createRadialGradient(p.x, p.y, R, p.x, p.y, R * 4);
      halo.addColorStop(0, `rgba(235,240,255,${0.08 + 0.18 * k})`); halo.addColorStop(1, 'rgba(235,240,255,0)');
      c.globalAlpha = 1; c.fillStyle = halo; c.beginPath(); c.arc(p.x, p.y, R * 4, 0, Math.PI * 2); c.fill();
      c.save();
      c.translate(p.x, p.y); c.rotate(Math.atan2(sun.y - p.y, sun.x - p.x));
      c.fillStyle = 'rgba(70,82,100,0.55)'; // earthshine on the dark side
      c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();
      // Lit limb on the Sun's side (+x), closed by the terminator: a half ellipse bulging toward
      // the light for a crescent, away from it for a gibbous moon.
      const a = R * Math.abs(1 - 2 * k);
      c.fillStyle = '#f3efe2';
      c.beginPath(); c.arc(0, 0, R, -Math.PI / 2, Math.PI / 2);
      if (k < 0.5) c.ellipse(0, 0, a, R, 0, Math.PI / 2, -Math.PI / 2, true);
      else c.ellipse(0, 0, a, R, 0, Math.PI / 2, Math.PI * 1.5, false);
      c.fill();
      c.restore();
    }

    // ---- drawing -------------------------------------------------------------------------
    function size() {
      const ratio = Math.min(1.5, root.devicePixelRatio || 1);
      const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientHeight * ratio);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; particles = []; }
      return { width, height, ratio };
    }

    function skyColors(light, iss) {
      if (iss || light === 'night') return ['#02060d', '#08172a'];
      if (light === 'twilight') return ['#0c1630', '#3a2a4a'];
      return ['#0d2638', '#1d4a63'];
    }

    function spawn(kind, box, bg) {
      const area = box.width * box.height / (box.ratio * box.ratio);
      const density = { snow: 1 / 2600, rain: 1 / 2200, storm: 1 / 1700, fog: 1 / 90000, cloud: 1 / 120000, clear: 1 / 30000, unknown: 0 }[kind] || 0;
      const count = Math.round(Math.min(420, area * density * bg.intensity * (bg.calm ? 0.6 : 1) * (kind === 'clear' && bg.light === 'night' ? 6 : 1)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * box.width, y: Math.random() * box.height,
        r: Math.random(), s: 0.5 + Math.random(), p: Math.random() * Math.PI * 2
      }));
    }

    function drawWeather(c, box, bg, dt) {
      if (!particles.length) spawn(bg.kind, box, bg);
      const { width, height, ratio } = box;
      const wind = bg.wind * (bg.calm ? 0.6 : 1);
      if (bg.kind === 'snow') {
        c.fillStyle = 'rgba(235,245,255,0.85)';
        for (const f of particles) {
          f.y += (18 + 30 * f.s) * ratio * dt; f.p += dt * (0.8 + f.r);
          f.x += (Math.sin(f.p) * 12 + wind * 90 * f.s) * ratio * dt;
          if (f.y > height) { f.y = -4; f.x = Math.random() * width; }
          f.x = (f.x + width) % width;
          c.globalAlpha = 0.45 + 0.5 * f.r;
          c.beginPath(); c.arc(f.x, f.y, (1.2 + 3 * f.r) * ratio, 0, Math.PI * 2); c.fill();
        }
      } else if (bg.kind === 'rain' || bg.kind === 'storm') {
        c.strokeStyle = 'rgba(170,205,235,0.55)'; c.lineWidth = ratio;
        const slant = 0.15 + wind * 0.6;
        c.beginPath();
        for (const d of particles) {
          const speed = (420 + 300 * d.s) * ratio * dt;
          d.y += speed; d.x += speed * slant;
          if (d.y > height) { d.y = -20 * ratio; d.x = Math.random() * width * 1.2 - width * 0.2; }
          const len = (10 + 14 * d.s) * ratio;
          c.globalAlpha = 0.25 + 0.4 * d.r;
          c.moveTo(d.x, d.y); c.lineTo(d.x - len * slant, d.y - len);
        }
        c.stroke();
        if (bg.kind === 'storm' && !bg.calm && !reducedMotion) {
          if (flash <= 0 && Math.random() < dt / 9) flash = 0.35;
          if (flash > 0) { c.globalAlpha = flash * 0.5; c.fillStyle = '#cfe4ff'; c.fillRect(0, 0, width, height); flash -= dt * 1.4; }
        }
      } else if (bg.kind === 'fog' || bg.kind === 'cloud') {
        for (const b of particles) {
          b.x += (6 + wind * 40) * b.s * ratio * dt;
          const radius = (bg.kind === 'fog' ? 260 : 180) * (0.6 + b.r) * ratio;
          if (b.x - radius > width) b.x = -radius;
          const y = bg.kind === 'cloud' ? b.y * 0.45 : b.y;
          const glow = c.createRadialGradient(b.x, y, 0, b.x, y, radius);
          glow.addColorStop(0, bg.kind === 'fog' ? 'rgba(190,205,215,0.16)' : 'rgba(160,180,200,0.12)');
          glow.addColorStop(1, 'rgba(160,180,200,0)');
          c.globalAlpha = 1; c.fillStyle = glow;
          c.fillRect(b.x - radius, y - radius, radius * 2, radius * 2);
        }
      } else if (bg.kind === 'clear') {
        if (bg.light === 'day') {
          const sun = c.createRadialGradient(width * 0.85, height * 0.12, 0, width * 0.85, height * 0.12, height * 0.5);
          sun.addColorStop(0, 'rgba(255,214,140,0.22)'); sun.addColorStop(1, 'rgba(255,214,140,0)');
          c.globalAlpha = 1; c.fillStyle = sun; c.fillRect(0, 0, width, height);
        }
        drawStars(c, dt, bg.light === 'day' ? 'rgba(255,236,190,0.6)' : 'rgba(225,235,255,0.9)', bg.light === 'day' ? 0.25 : 1);
      }
      c.globalAlpha = 1;
    }

    function drawStars(c, dt, color, strength) {
      c.fillStyle = color;
      for (const s of particles) {
        s.p += dt * (0.6 + s.r);
        c.globalAlpha = strength * (0.25 + 0.6 * (0.5 + 0.5 * Math.sin(s.p)) * s.r);
        c.beginPath(); c.arc(s.x, s.y, (0.6 + 1.4 * s.r) * box().ratio, 0, Math.PI * 2); c.fill();
      }
      c.globalAlpha = 1;
    }
    let boxCache = { ratio: 1 };
    const box = () => boxCache;

    // The pass on a panorama of the horizon centred on its path: azimuth across, height up.
    function drawIss(c, b, moment, at) {
      const { width, height, ratio } = b;
      if (!particles.length || particleKind !== 'iss-stars') {
        particleKind = 'iss-stars';
        particles = Array.from({ length: Math.round(Math.min(500, width * height / (ratio * ratio) / 2500)) },
          () => ({ x: Math.random() * width, y: Math.random() * height * 0.82, r: Math.random(), p: Math.random() * 6 }));
      }
      drawStars(c, FRAME_MS / 1000, 'rgba(225,235,255,0.95)', 1);
      const arc = Choice.passArc(moment.pass);
      if (!arc.length) return;
      const horizon = height * 0.84, top = height * 0.14;
      const mid = arc[Math.floor(arc.length / 2)].azDeg;
      const offset = az => ((az - mid) % 360 + 540) % 360 - 180;
      // Frame the pass itself: a short, low pass fills the sky instead of a dot on the horizon.
      const halfSpan = Math.max(20, Math.min(130, Math.max(...arc.map(point => Math.abs(offset(point.azDeg)))) + 25));
      // A low pass stays low, under Nestor's face, as in the real sky; a high one arcs over him.
      const peakEl = Math.max(...arc.map(point => point.elDeg));
      const ceiling = peakEl < 25 ? 90 : Math.max(30, Math.min(90, peakEl * 1.35));
      const project = point => ({ x: width / 2 + offset(point.azDeg) / halfSpan * (width / 2),
        y: horizon - Math.max(0, point.elDeg) / ceiling * (horizon - top) });
      // Horizon and compass.
      c.strokeStyle = 'rgba(120,170,200,0.45)'; c.lineWidth = ratio;
      c.beginPath(); c.moveTo(0, horizon); c.lineTo(width, horizon); c.stroke();
      c.fillStyle = 'rgba(160,200,225,0.8)';
      c.font = `${Math.round(15 * ratio)}px system-ui, sans-serif`; c.textAlign = 'center';
      const marks = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO']
        .map((label, i) => [label, i * 22.5]).filter((_, i) => halfSpan < 60 || i % 2 === 0);
      for (const [label, az] of marks) {
        const p = project({ azDeg: az, elDeg: 0 });
        if (p.x > 20 * ratio && p.x < width - 20 * ratio) c.fillText(label, p.x, horizon + 22 * ratio);
      }
      // Predicted path.
      c.setLineDash([6 * ratio, 8 * ratio]); c.strokeStyle = 'rgba(140,220,255,0.55)'; c.lineWidth = 2 * ratio;
      c.beginPath(); arc.forEach((point, i) => { const p = project(point); if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); }); c.stroke();
      c.setLineDash([]);
      // The station: its real place while it passes, a slow preview loop before.
      const progress = Choice.passProgress(moment.pass, at);
      const t = progress !== null ? progress : moment.phase === 'approach' && !reducedMotion ? (at % 9000) / 9000 : null;
      if (t === null) return;
      const index = Math.min(arc.length - 1, Math.round(t * (arc.length - 1)));
      for (let i = Math.max(0, index - 10); i <= index; i += 1) {
        const p = project(arc[i]);
        c.globalAlpha = (progress !== null ? 0.5 : 0.25) * (1 - (index - i) / 11);
        c.fillStyle = '#bfefff'; c.beginPath(); c.arc(p.x, p.y, 3 * ratio, 0, Math.PI * 2); c.fill();
      }
      const p = project(arc[index]);
      const halo = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26 * ratio);
      halo.addColorStop(0, progress !== null ? 'rgba(255,255,255,0.95)' : 'rgba(200,240,255,0.5)');
      halo.addColorStop(1, 'rgba(200,240,255,0)');
      c.globalAlpha = 1; c.fillStyle = halo; c.beginPath(); c.arc(p.x, p.y, 26 * ratio, 0, Math.PI * 2); c.fill();
      if (moment.cloudy) {
        const veil = c.createLinearGradient(0, top, 0, horizon);
        veil.addColorStop(0, 'rgba(120,135,150,0.10)'); veil.addColorStop(1, 'rgba(120,135,150,0.28)');
        c.fillStyle = veil; c.fillRect(0, 0, width, horizon);
      }
    }

    function draw(time) {
      frame = 0;
      if (disposed || !ctx) return;
      const visible = plein() && !doc.hidden && !photosShown() && scene;
      if (!visible) return;
      if (time - lastFrame >= FRAME_MS || reducedMotion) {
        const dt = Math.min(0.1, (time - lastFrame) / 1000 || FRAME_MS / 1000);
        lastFrame = time;
        boxCache = size();
        const bg = scene.background, iss = scene.moment?.kind === 'iss' ? scene.moment : null;
        const [top, bottom] = skyColors(bg.light, iss);
        const sky = ctx.createLinearGradient(0, 0, 0, boxCache.height);
        sky.addColorStop(0, top); sky.addColorStop(1, bottom);
        ctx.clearRect(0, 0, boxCache.width, boxCache.height);
        ctx.globalAlpha = 0.9; ctx.fillStyle = sky; ctx.fillRect(0, 0, boxCache.width, boxCache.height); ctx.globalAlpha = 1;
        if (iss) drawIss(ctx, boxCache, iss, now());
        else {
          if (particleKind === 'iss-stars') { particleKind = bg.kind; particles = []; }
          if (bg.sky && snapshot?.sky) drawRealSky(ctx, boxCache, bg, snapshot.sky, now());
          // On a clear evening the real stars replace the decorative ones; clouds still drift over.
          if (!(bg.sky && snapshot?.sky && bg.kind !== 'cloud')) drawWeather(ctx, boxCache, bg, dt);
        }
        if (scene.moment?.kind === 'paint') drawPaint(ctx, boxCache, now());
        artx?.rendered(snapshot, { ...scene, moment: scene.moment?.kind === 'paint' && !painting?.startedAt ? null : scene.moment });
      }
      // Reduced motion: one still picture per decision.
      if (!reducedMotion) frame = root.requestAnimationFrame(draw);
    }

    // ---- events --------------------------------------------------------------------------
    const onPresence = event => {
      const detail = event.detail || {};
      if (detail.space && detail.space !== space) return;
      if (typeof detail.sample === 'object' && detail.sample) sample = detail.sample;
      if (detail.state && detail.state !== state) { state = detail.state; decide(); }
    };
    const onKey = event => {
      if (event.key !== 'Escape' || !scene?.moment || !plein()) return;
      // A stopped painting counts as painted; the same picture may come back another time.
      if (scene.moment.kind !== "paint") dismissed.add(momentId(scene.moment));
      closeVisit(); endPaint(); decide();
    };
    const onVisibility = () => { if (!doc.hidden) poll(); };
    root.addEventListener('persona-presence', onPresence);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('visibilitychange', onVisibility);
    const pollTimer = root.setInterval(poll, POLL_MS);
    const decideTimer = root.setInterval(decide, DECIDE_MS);
    poll();

    function dispose() {
      disposed = true;
      artx?.dispose();
      root.clearInterval(pollTimer); root.clearInterval(decideTimer); closeVisit(); painting = null;
      if (frame) root.cancelAnimationFrame?.(frame);
      root.removeEventListener('persona-presence', onPresence);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('visibilitychange', onVisibility);
      canvas.remove(); chips.remove(); visit.remove(); weather.remove();
    }
    // Photos wait while Nestor shows a moment of his own.
    return { busy: () => !!scene?.moment && standby() && plein(), scene: () => scene,
      context: () => artx?.context({ visible: !!ctx && plein() && !doc.hidden && !photosShown() }), decide, dispose };
  }

  root.NestorAmbient = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
