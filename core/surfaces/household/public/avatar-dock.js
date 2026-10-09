/* Nestor's docked avatar: the GraphysX <llmx-face> beside Super Dad and Famille.
   The dock observes the conversation (persona-presence / persona-activity) and
   pushes agentx.presence.v1 to the face. The face module is relayed by Household
   itself; without it (unconfigured, offline, no WebGL) a 2D orb reacts instead.
   A math picture is paced here (it starts on Nestor's first word) but drawn in
   the page's Images zone: the dock publishes it as persona-scene and records the
   zone's persona-scene-receipt for the family turn (#131, #168).
   In the interactive scene Nestor fills the screen, steps into the top right corner
   when he shows something, and a tap on him brings the page and its menus. */
(function (root) {
  'use strict';
  const MODES = ['scene', 'bulle', 'quart', 'moitie'];
  const DEFAULT_MODE = 'scene';
  const MODULE_URL = '/api/household/avatar/llmx-face.js';
  // A math picture waits for Nestor's first word so the cubes move while he explains them;
  // a silent or text-only turn still shows it after this long.
  const SCENE_HOLD_MS = 2500;
  const storageKey = space => 'household.avatar.' + space + '.layout';

  // Conversation states (browser-conversation.js) → the face's observable phases.
  // Nestor rests with his eyes closed until he is activated (idle, starting,
  // resuming) and while he waits for "Hey Nestor"; he opens them on the first
  // word of his greeting, or when the wake word is heard.
  function phaseFor(state, { generating = false, hostBusy = false, asleep = false } = {}) {
    if (state === 'speaking') return 'speaking';
    if (asleep || ['idle', 'starting', 'resuming'].includes(state)) return 'sleeping';
    if (state === 'listening' || state === 'hearing') return 'listening';
    if (state === 'error') return 'error';
    if (['transcribing', 'waiting', 'thinking', 'preparing'].includes(state)) {
      if (hostBusy) return 'sleeping';
      return generating ? 'generating' : 'waiting';
    }
    return 'idle';
  }

  // Streamed characters over the last second, as approximate tokens per second.
  function createTokenMeter(now = () => Date.now(), windowMs = 1000) {
    const samples = [];
    const prune = at => { while (samples.length && at - samples[0].at > windowMs) samples.shift(); };
    return {
      add(chars) { const at = now(); samples.push({ at, chars: Math.max(0, chars | 0) }); prune(at); },
      rate() { const at = now(); prune(at); return samples.reduce((sum, s) => sum + s.chars, 0) / 4 / (windowMs / 1000); },
      active() { prune(now()); return samples.length > 0; },
      reset() { samples.length = 0; }
    };
  }

  // What the picture says, for its caption and when the 3D picture is unavailable.
  function sceneCaption(scene) {
    if (!scene) return '';
    if (scene.kind === 'add') return `${scene.a} + ${scene.b} = ${scene.a + scene.b}`;
    return scene.kind === 'count' ? `On compte jusqu’à ${scene.to}` : '';
  }

  // The scene's three views: plein (Nestor fills the screen), montre (he stands in the corner
  // beside what he shows) and menu (the page, its menus and the transcript). Something shown
  // while the page is open stays there; closing the page returns to it. When Nestor goes back
  // to waiting for "Hey Nestor", he takes the screen again.
  function nextView(view, event, shown = false) {
    if (event === 'tap') return view === 'menu' ? (shown ? 'montre' : 'plein') : 'menu';
    if (view === 'menu') return view;
    if (event === 'show') return 'montre';
    return ['close', 'clear', 'sleep'].includes(event) ? 'plein' : view;
  }

  function readMode(space) {
    try {
      const saved = root.localStorage?.getItem(storageKey(space));
      if (MODES.includes(saved) || saved === 'cache') return saved;
    } catch { /* storage blocked: session default */ }
    return DEFAULT_MODE;
  }

  function saveMode(space, mode) {
    try { root.localStorage?.setItem(storageKey(space), mode); } catch { /* per-viewer convenience only */ }
  }

  let facePromise = null;
  function loadFace() {
    if (root.customElements?.get('llmx-face')) return Promise.resolve(true);
    if (!facePromise) {
      facePromise = import(MODULE_URL).then(() => true).catch(() => { facePromise = null; return false; });
    }
    return facePromise;
  }

  function mount({ space = 'personal', documentRef = root.document, status = null, onTap = null } = {}) {
    const doc = documentRef;
    root.AvatarDock.current?.dispose();
    const family = space === 'family';
    const dock = doc.createElement('aside');
    dock.className = 'avatar-dock';
    dock.setAttribute('aria-label', family ? 'Nestor, visage' : 'Ton agent, visage');
    dock.innerHTML = `<div class="avatar-dock-stage"><div class="avatar-dock-orb" aria-hidden="true"></div></div>
      <div class="avatar-dock-bar" role="toolbar" aria-label="Taille du visage">
        <button type="button" data-mode="scene" title="Plein écran interactif">⛶</button>
        <button type="button" data-mode="bulle" title="Bulle">●</button>
        <button type="button" data-mode="quart" title="Quart d’écran">◱</button>
        <button type="button" data-mode="moitie" title="Moitié d’écran">◧</button>
        <button type="button" data-mode="cache" title="Masquer le visage">×</button>
      </div>
      <button type="button" class="avatar-dock-reopen" title="Afficher le visage">${family ? 'Nestor' : 'Visage'}</button>`;
    // The scene's own controls stay reachable on a touchscreen, where nothing hovers.
    const sceneBar = doc.createElement('div');
    sceneBar.className = 'avatar-scene-bar';
    sceneBar.setAttribute('role', 'toolbar');
    sceneBar.setAttribute('aria-label', family ? 'Nestor' : 'Ton agent');
    sceneBar.innerHTML = `<p class="avatar-scene-status" aria-hidden="true"></p>
      <div class="avatar-scene-actions"><button type="button" data-scene="close" hidden>Fermer l’affichage</button><button type="button" data-scene="menu">Menu</button></div>`;
    doc.body.append(dock, sceneBar);
    const sceneStatus = sceneBar.querySelector('.avatar-scene-status');
    const stage = dock.querySelector('.avatar-dock-stage');
    const orb = dock.querySelector('.avatar-dock-orb');
    // The mask's receipt for the current picture and the recorded turn it belongs to (#131);
    // sent once both are known, in whichever order they arrive.
    let pendingReceipt = null, recordedTurn = null, heldScene = null, sceneTimer = null;
    let face = null, mode = readMode(space), disposed = false, view = 'plein', shown = false;
    let state = 'idle', wasAsleep = false, hostBusy = false, toolPulses = 0, tint = '#52cfc5', sample = null;
    const meter = createTokenMeter();
    let resolveReady, readySettled = false;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const finishReady = renderer => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      if (renderer !== 'face') { face?.remove(); face = null; }
      dock.dataset.renderer = renderer;
      resolveReady(renderer);
    };
    // A slow or broken 3D module keeps the visible orb as Nestor's avatar.
    const readyTimer = setTimeout(() => finishReady('orb'), 7000);

    function setMode(next, remember = true) {
      mode = next;
      dock.dataset.mode = next;
      doc.body.classList.toggle('avatar-docked', next !== 'cache');
      doc.body.dataset.avatarMode = next;
      dock.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === next)));
      if (remember) saveMode(space, next);
      applyView();
    }
    function applyView() {
      const scene = mode === 'scene';
      if (scene) { dock.dataset.view = view; doc.body.dataset.avatarView = view; }
      else { delete dock.dataset.view; delete doc.body.dataset.avatarView; }
      sceneBar.hidden = !scene || view === 'menu';
      sceneBar.querySelector('[data-scene=close]').hidden = view !== 'montre';
    }
    function sceneEvent(event) {
      if (event === 'show') shown = true;
      if (['close', 'clear', 'sleep'].includes(event)) shown = false;
      view = nextView(view, event, shown);
      applyView();
    }
    sceneBar.addEventListener('click', event => {
      const button = event.target.closest('[data-scene]');
      if (button) sceneEvent(button.dataset.scene === 'close' ? 'close' : 'tap');
    });
    dock.querySelector('.avatar-dock-bar').addEventListener('click', event => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      // Choosing the scene again from the open page returns to it.
      if (button.dataset.mode === 'scene') view = shown ? 'montre' : 'plein';
      setMode(button.dataset.mode);
    });
    dock.querySelector('.avatar-dock-reopen').addEventListener('click', () => setMode(DEFAULT_MODE));
    stage.addEventListener('click', () => {
      if (mode === 'bulle') setMode('quart');
      // A tap on the full-screen face first wakes or resumes Nestor when he waits for it.
      else if (mode === 'scene' && !(view === 'plein' && onTap?.())) sceneEvent('tap');
    });
    const mirrorStatus = () => { sceneStatus.textContent = status?.textContent || ''; };
    const statusObserver = status && root.MutationObserver ? new root.MutationObserver(mirrorStatus) : null;
    statusObserver?.observe(status, { childList: true, characterData: true, subtree: true });
    mirrorStatus();
    setMode(mode, false);

    function presence() {
      const speech = sample?.speech?.() || null;
      const phase = phaseFor(state, { generating: meter.active(), hostBusy, asleep: !!sample?.asleep?.() });
      const level = phase === 'speaking' ? speech?.amplitude || 0 : phase === 'listening' ? sample?.input?.() || 0 : 0;
      return { phase, level, brightness: speech?.brightness || 0, tokenRate: meter.rate(), toolPulses };
    }
    const tick = setInterval(() => {
      const value = presence();
      const asleep = ['listening', 'hearing'].includes(state) && !!sample?.asleep?.();
      if (asleep && !wasAsleep) sceneEvent('sleep');
      wasAsleep = asleep;
      if (face) face.presence = value;
      orb.dataset.phase = value.phase;
      orb.style.setProperty('--avatar-level', Math.min(1, value.level * (value.phase === 'speaking' ? 8 : 10)).toFixed(3));
    }, 50);

    const onPresence = event => {
      const detail = event.detail || {};
      if (detail.state && detail.state !== state) {
        state = detail.state;
        if (!['transcribing', 'waiting', 'thinking', 'preparing'].includes(state)) { hostBusy = false; meter.reset(); }
        if (state === 'speaking') releaseScene();
      }
      if (typeof detail.sample === 'object' && detail.sample) sample = detail.sample;
      const color = detail.visual && /^#[0-9a-f]{6}$/i.test(detail.visual.color || '') ? detail.visual.color : null;
      if (color && color !== tint) { tint = color; face?.setAttribute('tint', tint); dock.style.setProperty('--avatar-tint', tint); }
    };
    const onActivity = event => {
      const detail = event.detail || {};
      if (detail.space && detail.space !== space) return;
      if (detail.kind === 'delta') { hostBusy = false; meter.add(detail.size || 0); }
      if (detail.kind === 'tools') toolPulses += Math.max(1, Math.min(3, detail.count || 1));
      if (detail.kind === 'host-busy') hostBusy = true;
      // A counting or addition picture (#131) stays until the next turn starts.
      if (detail.kind === 'turn') { pendingReceipt = null; recordedTurn = null; holdScene(null); }
      if (detail.kind === 'scene') holdScene(detail.scene || null);
      if (detail.kind === 'done') { recordedTurn = detail; sendReceipt(); }
      if (detail.kind === 'show' || detail.kind === 'clear') sceneEvent(detail.kind);
    };
    function holdScene(next) {
      clearTimeout(sceneTimer);
      heldScene = next;
      if (!next) return showScene(null);
      sceneTimer = setTimeout(releaseScene, SCENE_HOLD_MS);
    }
    function releaseScene() {
      clearTimeout(sceneTimer);
      if (!heldScene) return;
      const next = heldScene;
      heldScene = null;
      showScene(next);
    }
    function showScene(next) {
      root.dispatchEvent(new CustomEvent('persona-scene', { detail: { space, scene: next, caption: sceneCaption(next) } }));
    }
    const onSceneReceipt = event => {
      const detail = event.detail || {};
      if (detail.space !== space || !detail.receipt) return;
      pendingReceipt = detail.receipt;
      sendReceipt();
    };
    function sendReceipt() {
      const receipt = pendingReceipt, { sessionId, traceId } = recordedTurn || {};
      if (!receipt || !sessionId || !traceId) return;
      pendingReceipt = null;
      recordedTurn = null;
      if (!family) return;
      root.fetch?.('/api/family/math-receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, traceId, ...receipt }) }).catch(() => { /* a lost receipt never blocks the conversation */ });
    }
    root.addEventListener('persona-presence', onPresence);
    root.addEventListener('persona-activity', onActivity);
    root.addEventListener('persona-scene-receipt', onSceneReceipt);
    dock.style.setProperty('--avatar-tint', tint);

    loadFace().then(ok => {
      if (disposed || readySettled) return;
      if (!ok) { finishReady('orb'); return; }
      const element = doc.createElement('llmx-face');
      element.setAttribute('tint', tint);
      // Density follows the device, not the window: a narrow desktop window at load must not
      // pin the dense mask to its coarsest level for the whole visit. Weak hardware is capped
      // by the element itself.
      if (root.matchMedia?.('(pointer: coarse)').matches) element.setAttribute('level', 'balanced');
      element.addEventListener('llmx-face-ready', () => finishReady('face'), { once: true });
      element.addEventListener('llmx-face-error', () => {
        if (!readySettled) finishReady('orb');
        else { element.remove(); face = null; dock.dataset.renderer = 'orb'; }
      }, { once: true });
      face = element;
      stage.append(element);
    }).catch(() => finishReady('orb'));

    const handle = {
      get mode() { return mode; },
      get view() { return mode === 'scene' ? view : null; },
      ready,
      setMode,
      dispose() {
        if (disposed) return;
        disposed = true;
        finishReady('orb');
        clearInterval(tick);
        clearTimeout(sceneTimer);
        root.removeEventListener('persona-presence', onPresence);
        root.removeEventListener('persona-activity', onActivity);
        root.removeEventListener('persona-scene-receipt', onSceneReceipt);
        statusObserver?.disconnect();
        doc.body.classList.remove('avatar-docked');
        delete doc.body.dataset.avatarMode;
        delete doc.body.dataset.avatarView;
        dock.remove();
        sceneBar.remove();
        if (root.AvatarDock.current === handle) root.AvatarDock.current = null;
      }
    };
    root.AvatarDock.current = handle;
    return handle;
  }

  const api = { phaseFor, createTokenMeter, nextView, sceneCaption, DEFAULT_MODE, mount, MODES, MODULE_URL, current: null };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AvatarDock = api;
})(typeof window === 'undefined' ? globalThis : window);
