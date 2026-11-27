/* Core owns the deadline and claims; this view only counts down its projection. */
(function () {
  'use strict';
  const ROOT = '/api/family/kitchen-timer';
  function mount({ host, api, getLanguage }) {
    const panel = document.createElement('aside');
    panel.className = 'family-kitchen-timer';
    panel.hidden = true;
    const label = document.createElement('span'), digits = document.createElement('strong'), status = document.createElement('span');
    label.className = 'family-kitchen-timer-label';
    status.setAttribute('role', 'status');
    panel.append(label, digits, status);
    host.append(panel);

    let timer, observedAt, missed = false, pending = false, audio, alerting = false, lastAlertAttempt;
    const estimatedNow = () => timer.serverNow + Math.max(0, performance.now() - observedAt);
    const ready = () => audio?.state === 'running';
    const english = () => getLanguage() === 'en';
    async function unlock() {
      try {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (Context && !audio) audio = new Context();
        if (audio?.state === 'suspended') await audio.resume();
      } catch { /* Keep the visible expiry if audio is unavailable. */ }
    }
    const alive = () => panel.isConnected;
    const events = new AbortController();
    document.addEventListener('pointerdown', unlock, { capture: true, signal: events.signal });
    document.addEventListener('keydown', unlock, { capture: true, signal: events.signal });
    // An audio-enabled kiosk can play without a gesture. Ordinary browser tabs
    // may need the first pointer/key gesture instead; do not claim until ready.
    void unlock();

    function beep() {
      const oscillator = audio.createOscillator(), gain = audio.createGain(), at = audio.currentTime;
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(.16, at + .02);
      gain.gain.exponentialRampToValueAtTime(.001, at + .52);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(at);
      oscillator.stop(at + .53);
    }
    async function alertOnce() {
      if (alerting || !ready() || document.hidden || timer.alertClaimed
        || timer.serverNow - timer.endsAt > 60_000 || lastAlertAttempt === timer.id) return;
      alerting = true;
      const id = timer.id;
      try {
        const { claimed } = await api(ROOT + '/alert', { method: 'POST', body: JSON.stringify({ id }) });
        lastAlertAttempt = id;
        if (claimed && alive() && timer.id === id && ready()) beep();
      } catch { /* Never ring unless Core confirmed the one-time claim. */ }
      finally { alerting = false; }
    }
    function draw() {
      if (!timer || timer.state === 'idle') { panel.hidden = true; return; }
      const finished = timer.state === 'finished', expired = estimatedNow() >= timer.endsAt;
      const en = english();
      panel.hidden = false;
      label.textContent = en ? 'Kitchen timer' : 'Minuterie';
      const left = Math.max(0, Math.ceil((timer.endsAt - estimatedNow()) / 1000));
      const two = n => String(n).padStart(2, '0');
      const hours = Math.floor(left / 3600), rest = two(Math.floor(left % 3600 / 60)) + ':' + two(left % 60);
      digits.textContent = hours ? hours + ':' + rest : rest;
      const state = missed ? (en ? 'Connection lost' : 'Connexion perdue')
        : expired && !finished ? (en ? 'Confirming with Core…' : 'Confirmation en cours…')
        : finished ? (en ? 'Finished' : 'Terminée') : '';
      if (status.textContent !== state) status.textContent = state;
      panel.dataset.state = missed ? 'offline' : finished ? 'finished' : 'running';
    }
    function apply(value) {
      if (!alive() || !value || !Number.isFinite(value.serverNow) || (timer && value.serverNow < timer.serverNow)) return;
      timer = value; observedAt = performance.now(); missed = false;
      draw();
      if (timer.state === 'finished') void alertOnce();
    }
    async function refresh() {
      if (pending || !alive()) return;
      pending = true;
      try { apply(await api(ROOT, { cache: 'no-store' })); }
      catch { missed = true; draw(); }
      finally { pending = false; }
    }
    let lastPoll = 0;
    const interval = setInterval(() => {
      if (!alive()) {
        events.abort();
        clearInterval(interval);
        if (audio && audio.state !== 'closed') void audio.close().catch(() => {});
        return;
      }
      draw();
      const due = timer?.state === 'running' && estimatedNow() >= timer.endsAt;
      if (performance.now() - lastPoll >= (due ? 600 : 5000)) { lastPoll = performance.now(); void refresh(); }
    }, 250);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); }, { signal: events.signal });
    void refresh();
    return { apply };
  }
  window.FamilyKitchenTimer = { mount };
})();
