/* An inert photo surface on the existing page; never starts or changes the mic. */
(function (root) {
  'use strict';
  function mount({ host, api, space = 'personal', busy = () => false, standby = () => false, controls = {}, now = () => Date.now() }) {
    let enabled = false, active = false, disposed = false, loading = false, epoch = 0, voiceReturn = false;
    let voiceState = 'idle';
    let idleMs = 120000, intervalMs = 30000, lastActivity = now(), nextImage = 0, previous = null, focused;
    const region = document.createElement('section');
    region.className = 'nestor-idle-photos'; region.hidden = true;
    region.setAttribute('aria-label', 'Cadre photo');
    const image = document.createElement('img'); image.alt = ''; image.draggable = false;
    const actions = document.createElement('nav'); actions.setAttribute('aria-label', 'Commandes du cadre photo');
    const hint = document.createElement('p'); hint.textContent = 'Micro actif : dites « Hey Nestor ». Sinon, touchez l’écran.';
    actions.append(hint);
    const button = (label, run) => {
      const element = document.createElement('button'); element.type = 'button'; element.className = 'button';
      element.textContent = label; element.onclick = run; actions.append(element); return element;
    };
    function leave({ focus = false } = {}) {
      const wasActive = active;
      active = false; epoch++; region.hidden = true; image.removeAttribute('src');
      lastActivity = now(); previous = null;
      if (focus && wasActive) focused?.focus?.({ preventScroll: true });
      return wasActive;
    }
    button('Retour à Nestor', () => leave({ focus: true }));
    for (const [label, run] of Object.entries(controls)) button(label, () => { leave(); run(); });
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'button';
    toggle.textContent = 'Photos en veille'; toggle.hidden = true; toggle.setAttribute('aria-pressed', 'false');
    toggle.onclick = () => { enabled = !enabled; toggle.setAttribute('aria-pressed', String(enabled)); leave(); };
    host.append(toggle); region.append(image, actions); document.body.append(region);
    function activity(event) {
      if (event?.detail?.space && event.detail.space !== space) return;
      // Keep controls focusable/clickable until their own handler performs the action.
      if (active && actions.contains(event?.target) && !(event.type === 'keydown' && event.key === 'Escape')) return;
      voiceReturn = false;
      leave({ focus: event?.type === 'keydown' && event.key === 'Escape' });
    }
    function presence(event) {
      if (event.detail?.space && event.detail.space !== space) return;
      voiceState = event.detail?.state;
      // Energy/ambient recognition is not an activation while the existing wake gate is armed.
      if (active && standby() && ['hearing', 'transcribing'].includes(voiceState)) return;
      if (!['idle', 'paused', 'listening'].includes(event.detail?.state)) {
        if (active && ['hearing', 'transcribing'].includes(voiceState)) voiceReturn = true;
        leave();
      }
    }
    async function advance() {
      if (loading || disposed) return;
      loading = true; const token = epoch;
      try {
        const value = await api('/api/photos/frame/next' + (previous ? '?exclude=' + encodeURIComponent(previous) : ''));
        if (disposed || token !== epoch || !enabled || document.hidden || busy()) return;
        if (!value) { nextImage = now() + intervalMs; return; }
        if (!/^[0-9a-f-]{36}$/i.test(value.id) || value.src !== '/api/photos/frame/' + value.id + '/image') throw Error('Invalid image');
        const pending = new Image();
        await new Promise((resolve, reject) => { pending.onload = resolve; pending.onerror = reject; pending.src = value.src; });
        if (disposed || token !== epoch || !enabled || document.hidden || busy()) return;
        if (!active) focused = document.activeElement;
        image.src = value.src; previous = value.id; active = true; region.hidden = false;
        if (!actions.contains(document.activeElement)) actions.querySelector('button').focus({ preventScroll: true });
        nextImage = now() + intervalMs;
      } catch {
        if (!disposed && token === epoch) { leave(); toggle.title = 'Photos indisponibles. Nestor reste accessible.'; }
      } finally { loading = false; }
    }
    function tick() {
      if (disposed || !enabled) return;
      const editing = !region.contains(document.activeElement)
        && (document.activeElement?.matches('input, textarea, select, iframe') || document.activeElement?.isContentEditable);
      if (document.hidden || busy() || editing) {
        const awaitingWake = standby() && ['hearing', 'transcribing'].includes(voiceState);
        if (active && (document.hidden || editing || !awaitingWake)) leave();
        return;
      }
      if ((!active && now() - lastActivity >= idleMs && now() >= nextImage) || (active && now() >= nextImage)) void advance();
    }
    const events = ['pointerdown', 'keydown', 'input', 'focusin'];
    events.forEach(name => document.addEventListener(name, activity, true));
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
      document.removeEventListener('visibilitychange', visibility);
      root.removeEventListener('persona-presence', presence); root.removeEventListener('persona-activity', activity);
      region.remove(); toggle.remove();
    }
    return {
      active: () => active, activity, tick,
      // Existing voice recognition calls this hook with its own wake/address decision.
      localControl(text, options = {}) {
        if (!active && !voiceReturn) return null;
        const hadFrame = active || voiceReturn; voiceReturn = false;
        // Reuse the existing recognizer's grammar, including Hey/Eille variants.
        // This hook receives already-transcribed text; it opens no audio input.
        const Wake = root.NestorConversation?.WakeWindow;
        const wake = Wake ? new Wake().accept(text, false) : null;
        if (wake?.activated && !wake.text) {
          leave();
          return { action: 'wake', applied: true, addressed: true, message: 'Retour à Nestor.' };
        }
        const command = root.NestorScreenCommands?.parse(text);
        if (options.followup === false && !command?.addressed) return null;
        leave();
        return hadFrame && ['close', 'previous', 'shrink'].includes(command?.action)
          ? { action: command.action, applied: true, addressed: command.addressed, message: 'Retour à Nestor.' } : null;
      },
      dispose,
    };
  }
  root.NestorIdlePhotos = { mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = { mount };
}(typeof window !== 'undefined' ? window : globalThis));
