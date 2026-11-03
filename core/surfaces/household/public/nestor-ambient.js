/* Nestor's living full screen on Famille: a sky that follows the real weather behind him,
   a few short notes under the clock, the ISS drawn across the sky when it passes, and, now
   and then, a silent guided visit of the connected house to the machine an alert names.
   The rules live in nestor-ambient-choice.js. Nothing here speaks, listens or sends a turn:
   talking to Nestor (or typing) removes everything but the background, and Escape closes
   what he shows. Only the full-screen "plein" view is decorated. */
(function (root) {
  'use strict';
  const POLL_MS = 2 * 60 * 1000;
  const DECIDE_MS = 5000;
  const FRAME_MS = 1000 / 30;
  const VISITS_KEY = 'household.nestor.ambient.visits';
  // Awake listening is part of a conversation; listening or hearing while asleep (waiting
  // for "Hey Nestor") is standby.
  const ACTIVE_STATES = ['listening', 'hearing', 'transcribing', 'waiting', 'thinking', 'preparing', 'speaking', 'error'];

  function readVisits() {
    try { return JSON.parse(root.localStorage?.getItem(VISITS_KEY) || '{}') || {}; } catch { return {}; }
  }
  function saveVisits(visits) {
    try { root.localStorage?.setItem(VISITS_KEY, JSON.stringify(visits)); } catch { /* per-device convenience only */ }
  }

  function mount({ space = 'family', documentRef = root.document, now = () => Date.now(), fetchImpl = root.fetch?.bind(root) } = {}) {
    const Choice = root.NestorAmbientChoice;
    const doc = documentRef;
    if (!Choice || !doc?.body) return null;
    const reducedMotion = !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
    doc.body.append(chips, visit);

    let snapshot = null, state = 'idle', sample = null, scene = null, disposed = false;
    let frame = 0, lastFrame = 0, particles = [], particleKind = '', flash = 0;
    let visitKey = null, visitMoment = null, visitTimer = null, dismissed = new Set(), visits = readVisits();
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
    const momentId = moment => (moment?.kind === 'iss' ? 'iss:' + moment.pass.start : moment?.kind === 'visit' ? 'visit:' + moment.key : null);

    async function poll() {
      if (disposed || doc.hidden || !fetchImpl) return;
      try {
        const response = await fetchImpl('/api/family/ambient', { credentials: 'same-origin', cache: 'no-store' });
        const body = await response.json();
        if (response.ok && body?.data) snapshot = body.data;
      } catch { /* keep the last snapshot; the sky stays calm without one */ }
      decide();
    }

    function decide() {
      if (disposed) return;
      const at = now();
      const next = Choice.chooseScreen(snapshot, { at, standby: standby(), visits });
      if (next.moment && dismissed.has(momentId(next.moment))) next.moment = null;
      // An open visit is already recorded (cooldown) but keeps the screen until its tour ends.
      if (!next.moment && visitMoment && standby()) next.moment = visitMoment;
      scene = next;
      const host = dock();
      if (host && canvas.parentElement !== host) host.prepend(canvas);
      const shown = plein() && !photosShown();
      renderChips(shown ? next.chips : []);
      if (next.moment?.kind === 'visit' && shown) openVisit(next.moment, at); else if (next.moment?.kind !== 'visit') closeVisit();
      if (next.moment?.kind !== 'iss' && next.background.kind !== particleKind) { particleKind = next.background.kind; particles = []; }
      if (shown && !frame) frame = root.requestAnimationFrame?.(draw) || 0;
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
      iframe.src = src;
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
        else { if (particleKind === 'iss-stars') { particleKind = bg.kind; particles = []; } drawWeather(ctx, boxCache, bg, dt); }
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
      dismissed.add(momentId(scene.moment));
      closeVisit(); decide();
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
      root.clearInterval(pollTimer); root.clearInterval(decideTimer); closeVisit();
      if (frame) root.cancelAnimationFrame?.(frame);
      root.removeEventListener('persona-presence', onPresence);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('visibilitychange', onVisibility);
      canvas.remove(); chips.remove(); visit.remove();
    }
    // Photos wait while Nestor shows a moment of his own.
    return { busy: () => !!scene?.moment && standby() && plein(), scene: () => scene, decide, dispose };
  }

  root.NestorAmbient = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
