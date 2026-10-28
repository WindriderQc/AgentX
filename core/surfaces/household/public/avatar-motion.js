/* Local movement only. No identity, face/eye detection, recording, storage or transport. */
(function (root) {
  'use strict';
  const WIDTH = 80, HEIGHT = 60, INTERVAL = 200;
  const clamp = value => Math.max(-0.65, Math.min(0.65, value));

  // Two tiny luminance planes. Remove a uniform exposure change before measuring movement.
  function createDetector(width = WIDTH, height = HEIGHT) {
    let previous = null, lastMotion = -Infinity, x = 0, y = 0;
    return {
      reset() { previous = null; lastMotion = -Infinity; x = y = 0; },
      sample(rgba, now) {
        const count = width * height, gray = new Uint8Array(count);
        let shift = 0;
        for (let i = 0; i < count; i++) {
          const p = i * 4;
          gray[i] = (rgba[p] * 3 + rgba[p + 1] * 6 + rgba[p + 2]) / 10;
          if (previous) shift += gray[i] - previous[i];
        }
        let weight = 0, sumX = 0, sumY = 0, changed = 0;
        if (previous) {
          shift /= count;
          for (let i = 0; i < count; i++) {
            const delta = Math.abs(gray[i] - previous[i] - shift);
            if (delta < 22) continue;
            changed++; weight += delta;
            sumX += (i % width) * delta; sumY += Math.floor(i / width) * delta;
          }
        }
        previous = gray;
        // Broad scene/camera changes are not a person to follow. Ignore isolated noise too.
        const moving = changed >= Math.max(8, count * 0.002) && changed < count * 0.45;
        let goalX = x, goalY = y;
        if (moving) {
          // A front camera is unmirrored. Mirror horizontally to look toward the viewer.
          goalX = clamp(1 - 2 * sumX / weight / (width - 1));
          goalY = clamp(2 * sumY / weight / (height - 1) - 1);
          lastMotion = now;
        } else if (now - lastMotion > 900) goalX = goalY = 0;
        // Bounded steps avoid jumping between people; the face also eases its own rig.
        x += Math.max(-0.12, Math.min(0.12, (goalX - x) * 0.3));
        y += Math.max(-0.12, Math.min(0.12, (goalY - y) * 0.3));
        return { x, y, moving };
      }
    };
  }

  // The existing GraphysX embed consumes window pointermove, relative to its own bounds.
  // This non-bubbling synthetic event moves neither the OS pointer nor DOM focus and never
  // emits a click/activity/wake event. Math-scene attention retains the embed's precedence.
  function pointFace(face, point) {
    if (!face || !root.PointerEvent) return;
    const rect = face.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    root.dispatchEvent(new root.PointerEvent('pointermove', {
      clientX: rect.left + rect.width * (1 + point.x) / 2,
      clientY: rect.top + rect.height * (1 + point.y) / 2,
      bubbles: false, pointerType: 'mouse'
    }));
  }

  function mount({ documentRef = root.document, face = () => null, available = () => true } = {}) {
    const doc = documentRef;
    const panel = doc.createElement('section'); panel.className = 'avatar-camera';
    panel.setAttribute('aria-label', 'Regard de Nestor avec la caméra');
    const status = doc.createElement('p'); status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const button = doc.createElement('button'); button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    const help = doc.createElement('p'); help.className = 'avatar-camera-help';
    help.textContent = 'Mouvements seulement, traités sur cet écran. Aucune vidéo enregistrée ou envoyée.';
    panel.append(status, button, help); doc.body.append(panel);
    const video = doc.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    const canvas = doc.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
    let context = null, stream = null, timer = null, epoch = 0, disposed = false, wanted = false;
    const detector = createDetector();
    const message = value => { status.textContent = value; };
    function idleControls() {
      panel.dataset.active = 'false'; button.textContent = 'Activer le regard caméra';
      button.setAttribute('aria-pressed', 'false');
    }
    function stop(text = 'Caméra arrêtée.') {
      wanted = false; epoch++; root.clearTimeout(timer); timer = null;
      const old = stream; stream = null;
      old?.getTracks().forEach(track => track.stop());
      video.pause(); video.srcObject = null;
      context?.clearRect(0, 0, WIDTH, HEIGHT); detector.reset();
      pointFace(face(), { x: 0, y: 0 });
      idleControls(); message(text);
    }
    function tick(token) {
      if (disposed || token !== epoch || !stream) return;
      if (doc.hidden || !available()) { stop('Caméra arrêtée : Nestor n’est plus visible.'); return; }
      const before = root.performance.now();
      try {
        if (video.readyState >= 2) {
          context.drawImage(video, 0, 0, WIDTH, HEIGHT);
          const point = detector.sample(context.getImageData(0, 0, WIDTH, HEIGHT).data, before);
          pointFace(face(), point);
        }
      } catch { stop('Caméra indisponible. Nestor continue normalement.'); return; }
      // No overlapping work or animation loop. Back off further on a slow thin client.
      const cost = root.performance.now() - before;
      timer = root.setTimeout(() => tick(token), cost > 50 ? 500 : INTERVAL);
    }
    async function start() {
      if (disposed || wanted) return;
      if (doc.hidden || !available() || !face()) {
        message('Le regard caméra demande le visage de Nestor visible.'); return;
      }
      if (!root.navigator?.mediaDevices?.getUserMedia) {
        message('Caméra absente ou indisponible. Nestor continue normalement.'); return;
      }
      wanted = true; const token = ++epoch;
      button.textContent = 'Arrêter la caméra'; button.setAttribute('aria-pressed', 'true');
      panel.dataset.active = 'pending'; message('Autorisation caméra en attente.');
      try {
        context ||= canvas.getContext('2d', { willReadFrequently: true, alpha: false });
        if (!context) throw Error('canvas unavailable');
        const acquired = await root.navigator.mediaDevices.getUserMedia({ audio: false,
          video: { width: { ideal: 160, max: 320 }, height: { ideal: 120, max: 240 },
            frameRate: { ideal: 5, max: 5 }, facingMode: { ideal: 'user' } } });
        // Stop was pressed, navigation occurred, or the page hid while the prompt was open.
        if (disposed || token !== epoch || doc.hidden || !available()) {
          acquired.getTracks().forEach(track => track.stop());
          if (token === epoch) stop();
          return;
        }
        stream = acquired; video.srcObject = acquired;
        acquired.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
          if (token === epoch) stop('Caméra déconnectée. Nestor continue normalement.');
        }, { once: true }));
        await video.play();
        if (token !== epoch || disposed) return;
        panel.dataset.active = 'true'; message('Caméra active · regard local'); tick(token);
      } catch {
        if (token === epoch && !disposed) stop('Caméra refusée ou indisponible. Nestor continue normalement.');
      }
    }
    const click = () => { if (wanted) stop(); else void start(); };
    const visibility = () => { if (doc.hidden && wanted) stop(); };
    const pagehide = () => { if (wanted) stop(); };
    button.addEventListener('click', click);
    doc.addEventListener('visibilitychange', visibility); root.addEventListener('pagehide', pagehide);
    idleControls(); message('Caméra éteinte.');
    return { start, stop, get active() { return wanted; }, dispose() {
      if (disposed) return;
      stop(); disposed = true;
      button.removeEventListener('click', click); doc.removeEventListener('visibilitychange', visibility);
      root.removeEventListener('pagehide', pagehide); panel.remove();
      canvas.width = canvas.height = 0;
    } };
  }
  const api = { createDetector, pointFace, mount, WIDTH, HEIGHT, INTERVAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AvatarMotion = api;
})(typeof window === 'undefined' ? globalThis : window);
