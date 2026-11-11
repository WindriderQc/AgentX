'use strict';

// One lightweight Family frame: two image elements, opacity fading and bounded
// reads. Core owns temporary bytes, keep receipts and epoch closure.
(function exposeIllustratedFrame(root) {
  const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const ID = new RegExp('^' + UUID + '$', 'i');
  const ROUTE = new RegExp('^(/api/voice-personas/family/sessions/([a-zA-Z0-9_-]{1,80})/images)/(' + UUID + ')$', 'i');
  const END_ROUTE = /^\/api\/voice-personas\/family\/sessions\/[a-zA-Z0-9_-]{1,80}\/images\/retention\/end$/;
  const ACTIVE = new Set(['queued', 'accepted', 'reserving', 'generating', 'archiving', 'restoring']);
  const KEY = 'agentx.illustrated.retention.v1';
  let frame = null, layers = [], front = 0, timer = null, epoch = 0, current = null, owned = null;
  let caption, keepButton, status, verify, retry, expiryTimer, recoveryTimer, reading = false, storageBlocked = false;
  let familySession = null, bindingSet = false, allowed = true, suspended = false, fetcher = root.fetch?.bind(root), delay = 4000;
  let ledger = [], loaded = false, cursor = 0, notice = '';
  const requests = new Set(), closed = new Set(), fades = new Set();
  const text = (tag, content) => { const node = document.createElement(tag); if (content) node.textContent = content; return node; };
  const validEntry = entry => entry && ID.test(entry.requestId || '') && ID.test(entry.epoch || '')
    && Object.keys(entry).every(key => ['kind', 'statusUrl', 'requestId', 'epoch'].includes(key))
    && (entry.kind === 'keep' ? ROUTE.test(entry.statusUrl || '') : entry.kind === 'end' && END_ROUTE.test(entry.statusUrl || ''));
  const metadata = entry => ({ kind: entry.kind, statusUrl: entry.statusUrl, requestId: entry.requestId, epoch: entry.epoch });
  const identity = entry => JSON.stringify(metadata(entry));
  function stored() {
    const value = JSON.parse(root.sessionStorage.getItem(KEY) || '[]');
    if (!Array.isArray(value) || value.length > 8 || !value.every(validEntry)) throw Error('Invalid retained request identity');
    return value;
  }
  function load() {
    if (loaded) return; loaded = true;
    try { ledger = stored().map(entry => ({ ...entry, phase: 'unknown' })); }
    catch { storageBlocked = true; }
  }
  function reserve(entry) {
    load();
    try {
      if (storageBlocked) return false;
      const saved = stored(), existing = saved.find(row => row.requestId === entry.requestId);
      if (existing && identity(existing) !== identity(entry) || !existing && saved.length >= 8) throw Error('Identity unavailable');
      if (!existing) saved.push(metadata(entry));
      root.sessionStorage.setItem(KEY, JSON.stringify(saved));
      if (!stored().some(row => identity(row) === identity(entry))) throw Error('Identity not retained');
      if (!ledger.includes(entry)) ledger.push(entry); return true;
    } catch { storageBlocked = true; return false; }
  }
  function forget(entry) {
    try {
      const saved = stored().filter(row => identity(row) !== identity(entry));
      root.sessionStorage.setItem(KEY, JSON.stringify(saved));
    } catch { storageBlocked = true; }
    ledger = ledger.filter(row => row !== entry);
  }
  function fresh(operation) {
    const retention = operation?.retention;
    return !retention || !retention.expired && (retention.kept || Date.parse(retention.expiresAt || '') > Date.now());
  }
  function ensure() {
    if (frame) return frame;
    frame = document.createElement('figure'); frame.className = 'illustrated-frame'; frame.hidden = true;
    frame.setAttribute('aria-label', 'Picture of the conversation');
    layers = [document.createElement('img'), document.createElement('img')];
    for (const layer of layers) { layer.decoding = 'async'; layer.draggable = false; frame.append(layer); }
    caption = text('figcaption'); caption.className = 'illustrated-frame-caption';
    keepButton = text('button', 'Garder cette image'); keepButton.type = 'button'; keepButton.className = 'button';
    status = text('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    verify = text('button', 'Vérifier'); verify.type = 'button'; verify.className = 'button';
    retry = text('button', 'Reprendre la même demande'); retry.type = 'button'; retry.className = 'button';
    caption.append(keepButton, status, verify, retry); frame.append(caption);
    frame.addEventListener('click', event => { if (!event?.target?.closest?.('button')) frame.classList.toggle('is-large'); });
    keepButton.addEventListener('click', event => { event?.stopPropagation?.(); keep(); });
    verify.addEventListener('click', event => { event?.stopPropagation?.(); for (const entry of ledger) entry.failures = 0; void recover(); });
    retry.addEventListener('click', event => {
      event?.stopPropagation?.(); const entry = ledger.find(row => row.absent && row.phase !== 'sending');
      if (entry) void reconcile(entry).then(() => { if (ledger.includes(entry) && entry.absent) void post(entry); });
    });
    document.body.append(frame); render(); return frame;
  }
  function render() {
    if (!frame) return;
    const pending = ledger.length > 0, retention = current?.operation.retention;
    caption.hidden = !retention && !pending && !storageBlocked;
    keepButton.hidden = !retention;
    keepButton.disabled = !current || !fresh(current.operation) || !retention?.temporary || retention.kept || pending || storageBlocked;
    keepButton.textContent = retention?.kept ? 'Image gardée' : 'Garder cette image';
    verify.hidden = !pending; verify.disabled = reading;
    retry.hidden = !ledger.some(entry => entry.absent && entry.phase !== 'sending') || storageBlocked;
    const message = storageBlocked ? 'La demande ne peut pas être conservée pour reprise dans ce navigateur.'
      : pending ? 'Vérification de la demande d’origine…' : notice;
    if (status.textContent !== message) status.textContent = message;
    if (allowed && familySession && !current && pending) { frame.classList.add('is-recovery'); frame.hidden = false; }
    else { frame.classList.remove('is-recovery'); if (!current) frame.hidden = true; }
  }
  function ready(operation, statusUrl) {
    return operation?.state === 'completed' && operation.runtimeRestored === true && fresh(operation)
      && /^[a-f0-9]{64}$/.test(operation.artifact?.sha256 || '') && operation.artifact.url === statusUrl + '/image';
  }
  function clearPicture() {
    clearTimeout(expiryTimer); for (const fade of fades) clearTimeout(fade); fades.clear(); current = null;
    if (!frame) return;
    frame.hidden = true; frame.classList.remove('is-large');
    for (const layer of layers) { layer.onload = null; layer.onerror = null; layer.removeAttribute('src'); layer.classList.remove('is-front'); }
  }
  function expirePicture(record) {
    clearTimeout(expiryTimer);
    const retention = record.operation.retention;
    if (!retention || retention.kept) return;
    expiryTimer = setTimeout(async () => {
      if (current !== record || record.operation.retention?.kept) return;
      try {
        // Human activity can renew this asset without a new scene event. One
        // bounded read at the old deadline observes that native extension.
        const value = await json(record.statusUrl), operation = value.operation;
        if (current !== record || record.operation.retention?.kept) return;
        if (operation?.id !== record.operation.id || operation.retention?.epoch !== retention.epoch
          || operation.artifact?.sha256 !== record.operation.artifact.sha256 || !ready(operation, record.statusUrl)) throw Error('Expired asset');
        record.operation = operation; expirePicture(record); render();
      } catch {
        if (current === record && !record.operation.retention?.kept) { clearPicture(); notice = 'Cette illustration a expiré ou n’est plus vérifiable.'; render(); }
      }
    }, Math.max(0, Math.min(2147483647, Date.parse(retention.expiresAt || '') - Date.now())));
  }
  function reveal(operation, statusUrl, alt, mine) {
    ensure(); const next = layers[1 - front];
    next.onload = () => {
      if (mine !== epoch || !fresh(operation)) { next.removeAttribute('src'); return; }
      const previous = layers[front], previousSrc = previous.src; next.classList.add('is-front'); next.removeAttribute('aria-hidden');
      previous.classList.remove('is-front'); previous.setAttribute('aria-hidden', 'true');
      front = 1 - front; current = { operation, statusUrl }; frame.hidden = false; allowed = true;
      expirePicture(current); render();
      // The old layer may fade, but never retain older temporary bytes forever.
      const fade = setTimeout(() => { fades.delete(fade); if (layers[front] !== previous && previous.src === previousSrc) previous.removeAttribute('src'); }, 1300);
      fades.add(fade);
    };
    next.onerror = () => { next.removeAttribute('src'); };
    next.alt = alt; next.src = operation.artifact.url;
  }
  async function json(url, options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000); requests.add(controller);
    try {
      const response = await fetcher(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options, signal: controller.signal });
      const value = await response.json();
      if (!response.ok || value.ok !== true) throw Error('Native result unavailable');
      return value;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  function receiptMatches(entry, receipt) {
    return receipt?.requestId === entry.requestId && (entry.kind === 'keep'
      ? receipt.imageId === ROUTE.exec(entry.statusUrl)[3] : receipt.epoch === entry.epoch);
  }
  function receive(entry, value) {
    if (!ledger.includes(entry)) return;
    if (entry.kind === 'end' && value.alreadyEnded === true && value.epoch === entry.epoch && ID.test(value.originalRequestId || '')) {
      forget(entry); notice = 'La conversation précédente était déjà terminée.'; render(); return;
    }
    const receipt = value.receipt;
    if (receipt === null) { entry.absent = true; entry.phase = 'unknown'; render(); return; }
    if (!receiptMatches(entry, receipt) || !['accepted', 'completed', 'refused'].includes(receipt.state)) throw Error('Original receipt unverified');
    entry.absent = false;
    if (receipt.state === 'completed' || receipt.state === 'refused') {
      forget(entry);
      if (entry.kind === 'keep') {
        const same = current?.statusUrl === entry.statusUrl && current.operation.retention?.epoch === entry.epoch;
        if (same && receipt.state === 'completed') {
          current.operation = { ...current.operation, retention: { ...current.operation.retention, kept: true, temporary: false } };
          expirePicture(current);
        }
        notice = same ? receipt.state === 'completed' ? 'Image gardée.' : 'L’image n’a pas été gardée.'
          : receipt.state === 'completed' ? 'La demande précédente est confirmée.' : 'La demande précédente a été refusée.';
      }
    } else entry.phase = 'unknown';
    render();
  }
  async function reconcile(entry) {
    try { receive(entry, await json(entry.statusUrl + (entry.kind === 'keep' ? '/keep' : '') + '?requestId=' + encodeURIComponent(entry.requestId))); entry.failures = 0; }
    catch { entry.failures = (entry.failures || 0) + 1; entry.phase = 'unknown'; entry.absent = false; }
  }
  function scheduleRecovery() {
    clearTimeout(recoveryTimer);
    if (!suspended && familySession && ledger.some(entry => entry.phase !== 'sending' && (entry.failures || 0) < 3) && !document.hidden) recoveryTimer = setTimeout(recover, delay);
  }
  async function recover() {
    if (reading || !familySession || suspended || document.hidden || !fetcher) return;
    load(); const candidates = ledger.filter(entry => entry.phase !== 'sending' && (entry.failures || 0) < 3);
    if (!candidates.length) return;
    reading = true; ensure(); render();
    try { await reconcile(candidates[cursor++ % candidates.length]); }
    finally { reading = false; render(); scheduleRecovery(); }
  }
  async function post(entry) {
    if (!reserve(entry)) { render(); return; }
    entry.phase = 'sending'; entry.absent = false; ensure(); render();
    try {
      receive(entry, await json(entry.statusUrl + (entry.kind === 'keep' ? '/keep' : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: entry.requestId, ...(entry.kind === 'end' && { epoch: entry.epoch }) }) }));
    } catch { entry.phase = 'unknown'; entry.absent = false; }
    finally { render(); if (familySession) void recover(); }
  }
  function keep() {
    load();
    if (ledger.length) { void recover(); return true; }
    if (!current || !fresh(current.operation) || !current.operation.retention?.temporary || current.operation.retention.kept) return false;
    const entry = { kind: 'keep', statusUrl: current.statusUrl, requestId: root.crypto.randomUUID(), epoch: current.operation.retention.epoch };
    if (!validEntry(metadata(entry)) || !reserve(entry)) { render(); return true; }
    void post(entry); return true;
  }
  function show(block, options = {}) {
    const operation = block?.operation, match = ROUTE.exec(operation?.statusUrl || '');
    if (suspended || block?.presentation !== 'illustration' || !match || match[3] !== operation.id) return false;
    if (bindingSet && match[2] !== familySession || closed.has(operation.retention?.epoch)) return false;
    fetcher = options.fetcher || fetcher; delay = Math.max(1, Math.min(10000, options.delay || 4000));
    if (!fetcher) return false; load();
    const statusUrl = operation.statusUrl, alt = String(block.body || '').slice(0, 200), mine = ++epoch;
    clearTimeout(timer); allowed = true;
    if (ID.test(operation.retention?.epoch || '')) owned = { sessionId: match[2], base: match[1], epoch: operation.retention.epoch };
    const poll = async () => {
      if (mine !== epoch) return;
      if (document.hidden) { timer = setTimeout(poll, delay); return; }
      try {
        const value = await json(statusUrl);
        if (mine !== epoch || value.operation?.id !== operation.id) return;
        if (operation.retention?.epoch && value.operation.retention?.epoch !== operation.retention.epoch) return;
        if (ready(value.operation, statusUrl)) reveal(value.operation, statusUrl, alt, mine);
        else if (ACTIVE.has(value.operation.state)) timer = setTimeout(poll, delay);
        else if (current?.statusUrl === statusUrl && !fresh(value.operation)) { clearPicture(); render(); }
      } catch { if (mine === epoch) timer = setTimeout(poll, delay * 2); }
    };
    if (ready(operation, statusUrl)) reveal(operation, statusUrl, alt, mine);
    else timer = setTimeout(poll, delay);
    scheduleRecovery(); return true;
  }
  function clear() {
    epoch++; clearTimeout(timer); clearTimeout(recoveryTimer); allowed = false; clearPicture();
  }
  function end() {
    const previous = owned; owned = null; familySession = null; bindingSet = true;
    clear();
    if (!previous || closed.has(previous.epoch)) return false;
    closed.add(previous.epoch); if (closed.size > 16) closed.delete(closed.values().next().value);
    load();
    const existing = ledger.find(entry => entry.kind === 'end' && entry.epoch === previous.epoch && entry.statusUrl === previous.base + '/retention/end');
    if (existing) { scheduleRecovery(); return true; }
    const entry = { kind: 'end', statusUrl: previous.base + '/retention/end', epoch: previous.epoch, requestId: root.crypto.randomUUID() };
    if (!reserve(entry)) return false;
    void post(entry); return true;
  }
  function follow(session, options = {}) {
    const next = /^[a-zA-Z0-9_-]{1,80}$/.test(session?.sessionId || '') ? session.sessionId : null;
    if (bindingSet && familySession !== next && owned) end();
    familySession = next; bindingSet = true; allowed = true; fetcher = options.fetcher || fetcher;
    load(); if (familySession) void recover();
  }
  function localControl(value, options = {}) {
    if (!familySession || !current && !ledger.length) return null;
    let words = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const addressed = /^(?:hey\s+)?nestor\b/.test(words);
    if (!addressed && options.followup === false) return null;
    words = words.replace(/^(?:hey\s+)?nestor\b[\s,:-]*/, '').replace(/[.!?]+$/, '').trim();
    if (!/^(?:garde cette image|keep this (?:image|picture))$/.test(words)) return null;
    keep(); return { action: 'keep', addressed, applied: false, message: 'Vérification de la conservation de l’image.' };
  }
  root.addEventListener?.('pagehide', () => { suspended = true; clear(); for (const controller of requests) controller.abort(); });
  root.addEventListener?.('pageshow', () => { suspended = false; if (familySession) void recover(); });
  document.addEventListener?.('visibilitychange', () => {
    if (document.hidden) clearTimeout(recoveryTimer);
    else { if (current && !fresh(current.operation)) clearPicture(); if (familySession) void recover(); }
  });
  root.IllustratedFrame = Object.freeze({ show, clear, keep, follow, end, localControl });
}(typeof window !== 'undefined' ? window : globalThis));
