/* An inert photo surface on the existing page; never starts or changes the mic. */
(function (root) {
  'use strict';
  function mount({ host, api, space = 'personal', busy = () => false, standby = () => false, controls = {}, now = () => Date.now() }) {
    let enabled = false, active = false, disposed = false, pending = null, epoch = 0;
    let voiceState = 'idle', history = [], position = -1;
    let idleMs = 120000, intervalMs = 30000, lastActivity = now(), nextImage = 0, focused;
    // The controls stay hidden over the photo until the mouse moves or Tab asks for them.
    let controlsUntil = 0, hovering = false, keyboardControls = false, lastPoint = null;
    const CONTROLS_MS = 3000;
    const region = document.createElement('section');
    region.className = 'nestor-idle-photos'; region.hidden = true;
    region.setAttribute('aria-label', 'Cadre photo');
    const image = document.createElement('img'); image.alt = ''; image.draggable = false;
    const actions = document.createElement('nav'); actions.setAttribute('aria-label', 'Commandes du cadre photo');
    const hint = document.createElement('p'); hint.textContent = '← / → : photos. Micro actif : « recule » / « avance » ; en veille, dites « Hey Nestor » avant la commande.';
    actions.append(hint);
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const button = (label, run) => {
      const element = document.createElement('button'); element.type = 'button'; element.className = 'button';
      element.textContent = label; element.onclick = run; actions.append(element); return element;
    };
    const recognizing = () => ['hearing', 'transcribing'].includes(voiceState);
    const editing = target => target?.matches?.('input, textarea, select, iframe') || target?.isContentEditable;
    const available = () => !disposed && enabled && !document.hidden && !editing(document.activeElement)
      && !busy({ recognizing: active && recognizing() });
    function cancelPending() {
      epoch++; pending = null; region.removeAttribute('aria-busy');
    }
    function revealControls() {
      controlsUntil = now() + CONTROLS_MS; region.setAttribute('data-controls', 'shown');
    }
    function hideControls() {
      controlsUntil = 0; hovering = false; keyboardControls = false; region.removeAttribute('data-controls');
    }
    function hideControlsWhenDue() {
      if (!controlsUntil || now() < controlsUntil) return;
      // A pointer resting on the bar, or keyboard focus inside it, keeps it open.
      if (hovering || (keyboardControls && actions.contains(document.activeElement))) { controlsUntil = now() + CONTROLS_MS; return; }
      hideControls();
    }
    function pointerMove(event) {
      const point = { x: event.screenX, y: event.screenY }, previous = lastPoint;
      lastPoint = point;
      // Ignore touch and the synthetic moves a browser sends when the photo appears under a still cursor.
      if (!active || event.pointerType === 'touch' || !previous) return;
      if (Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) < 2) return;
      hovering = actions.contains(event.target); keyboardControls = false; revealControls();
    }
    function leave({ focus = false } = {}) {
      const wasActive = active;
      active = false; cancelPending(); region.hidden = true; image.removeAttribute('src'); hideControls();
      if (wasActive) root.dispatchEvent(new CustomEvent('nestor-idle-photos-visibility'));
      lastActivity = now(); nextImage = 0; history = []; position = -1; status.textContent = '';
      if (focus && wasActive) focused?.focus?.({ preventScroll: true });
      return wasActive;
    }
    button('Retour à Nestor', () => leave({ focus: true }));
    const back = button('Photo précédente', () => navigate(-1));
    back.setAttribute('aria-keyshortcuts', 'ArrowLeft'); back.disabled = true;
    const forward = button('Photo suivante', () => navigate(1));
    forward.setAttribute('aria-keyshortcuts', 'ArrowRight');
    for (const [label, run] of Object.entries(controls)) button(label, () => { leave(); run(); });
    actions.append(status);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'button';
    toggle.textContent = 'Photos en veille'; toggle.hidden = true; toggle.setAttribute('aria-pressed', 'false');
    toggle.onclick = () => { enabled = !enabled; toggle.setAttribute('aria-pressed', String(enabled)); leave(); };
    host.append(toggle); region.append(image, actions); document.body.append(region);
    function activity(event) {
      if (event?.detail?.space && event.detail.space !== space) return;
      if (active && event?.type === 'keydown' && ['ArrowLeft', 'ArrowRight'].includes(event.key)
        && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && !editing(event.target) && !editing(document.activeElement)) {
        event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1); return;
      }
      // Tab opens the hidden controls instead of leaving the photos.
      if (active && event?.type === 'keydown' && event.key === 'Tab' && !actions.contains(event.target)
        && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); revealControls(); keyboardControls = true;
        actions.querySelector('button').focus({ preventScroll: true }); return;
      }
      // Keep controls focusable/clickable until their own handler performs the action.
      if (active && actions.contains(event?.target) && !(event.type === 'keydown' && event.key === 'Escape')) {
        if (event.type === 'keydown') { keyboardControls = true; revealControls(); }
        return;
      }
      leave({ focus: event?.type === 'keydown' && event.key === 'Escape' });
    }
    function presence(event) {
      if (event.detail?.space && event.detail.space !== space) return;
      voiceState = event.detail?.state;
      // Wait for the existing recognizer's local-control/wake decision before dismissing photos.
      if (active && recognizing()) return;
      if (!['idle', 'paused', 'listening'].includes(voiceState)) leave();
    }
    function show(value) {
      const wasActive = active;
      if (!active) focused = document.activeElement;
      image.src = value.src; active = true; region.hidden = false;
      if (!wasActive) root.dispatchEvent(new CustomEvent('nestor-idle-photos-visibility'));
      back.disabled = position <= 0; status.textContent = 'Photo ' + (position + 1);
      nextImage = now() + intervalMs;
    }
    async function advance() {
      if (pending || !available()) return;
      if (position + 1 < history.length) { show(history[++position]); return; }
      const request = { epoch: ++epoch }; pending = request; region.setAttribute('aria-busy', 'true');
      const current = () => pending === request && epoch === request.epoch && available();
      const previous = history[position]?.id;
      try {
        const value = await api('/api/photos/frame/next' + (previous ? '?exclude=' + encodeURIComponent(previous) : ''));
        if (!current()) return;
        if (!value || value.id === previous) { nextImage = now() + intervalMs; return; }
        if (!/^[0-9a-f-]{36}$/i.test(value.id) || value.src !== '/api/photos/frame/' + value.id + '/image') throw Error('Invalid image');
        const loadingImage = new Image();
        await new Promise((resolve, reject) => { loadingImage.onload = resolve; loadingImage.onerror = reject; loadingImage.src = value.src; });
        if (!current()) return;
        history.push({ id: value.id, src: value.src }); position = history.length - 1; show(value);
      } catch {
        if (pending === request && epoch === request.epoch) {
          if (active) { status.textContent = 'Photo indisponible. Réessayez avec « Photo suivante ».'; nextImage = now() + intervalMs; revealControls(); }
          else { leave(); toggle.title = 'Photos indisponibles. Nestor reste accessible.'; }
        }
      } finally {
        if (pending === request) { pending = null; region.removeAttribute('aria-busy'); }
      }
    }
    function navigate(direction) {
      if (!active || !available()) return false;
      nextImage = now() + intervalMs;
      if (direction < 0) {
        cancelPending();
        if (position > 0) show(history[--position]);
        return true;
      }
      // Coalesce repeats at the end of history; one next-image request at a time.
      void advance(); return true;
    }
    function tick() {
      if (disposed || !enabled) return;
      if (active) hideControlsWhenDue();
      if (!available()) {
        if (active) leave();
        return;
      }
      if (recognizing()) return;
      if ((!active && now() - lastActivity >= idleMs && now() >= nextImage) || (active && now() >= nextImage)) void advance();
    }
    const events = ['pointerdown', 'keydown', 'input', 'focusin'];
    events.forEach(name => document.addEventListener(name, activity, true));
    document.addEventListener('pointermove', pointerMove, true);
    const visibility = () => leave();
    document.addEventListener('visibilitychange', visibility);
    root.addEventListener('persona-presence', presence);
    root.addEventListener('persona-activity', activity);
    const timer = root.setInterval(tick, 1000);
    const observer = new MutationObserver(() => { if (!host.isConnected) dispose(); });
    observer.observe(document.body, { childList: true, subtree: true });
    void api('/api/photos/frame/status').then(value => {
      if (disposed || !value?.enabled) return;
      idleMs = Math.max(30000, Number(value.idleSeconds) * 1000 || 120000);
      intervalMs = Math.max(5000, Number(value.intervalSeconds) * 1000 || 30000);
      enabled = true; toggle.hidden = false; toggle.setAttribute('aria-pressed', 'true');
    }).catch(() => {});
    function dispose() {
      disposed = true; leave(); root.clearInterval(timer); observer.disconnect();
      events.forEach(name => document.removeEventListener(name, activity, true));
      document.removeEventListener('pointermove', pointerMove, true);
      document.removeEventListener('visibilitychange', visibility);
      root.removeEventListener('persona-presence', presence); root.removeEventListener('persona-activity', activity);
      region.remove(); toggle.remove();
    }
    return {
      active: () => active, activity, tick,
      // Existing voice recognition calls this hook with its own wake/address decision.
      localControl(text, options = {}) {
        if (!active) return null;
        const Wake = root.NestorConversation?.WakeWindow;
        const wake = Wake ? new Wake().accept(text, false) : null;
        if (wake?.activated && !wake.text) {
          leave();
          return { action: 'wake', applied: true, addressed: true, message: 'Retour à Nestor.' };
        }
        // These exact aliases belong only to the photo context, not to other content.
        const parser = root.NestorScreenCommands;
        const command = parser?.parse(wake?.activated ? 'Nestor ' + wake.text : text, [
          { phrase: 'recule', action: 'previous' }, { phrase: 'avance', action: 'next' }
        ]);
        if (options.followup === false && !command?.addressed) return null;
        if (command?.custom && ['previous', 'next'].includes(command.action)) {
          return { action: command.action, applied: navigate(command.action === 'previous' ? -1 : 1),
            addressed: command.addressed, message: command.action === 'previous' ? 'Photo précédente.' : 'Photo suivante.' };
        }
        leave();
        return ['close', 'previous', 'shrink'].includes(command?.action)
          ? { action: command.action, applied: true, addressed: command.addressed, message: 'Retour à Nestor.' } : null;
      },
      dispose,
    };
  }
  root.NestorIdlePhotos = { mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = { mount };
}(typeof window !== 'undefined' ? window : globalThis));
