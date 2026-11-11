'use strict';

// Family's illustrated mode (#1304): one small picture beside the conversation
// that follows its subject. Kept light for kitchen screens and tablets: two
// image elements and a CSS fade, a slow status read only while a picture is
// being prepared (paused while the page is hidden), and nothing kept once the
// conversation changes. A failed or refused picture leaves the previous one.
(function exposeIllustratedFrame(root) {
  const ROUTE = /^\/api\/voice-personas\/family\/sessions\/[a-zA-Z0-9_-]{1,80}\/images\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
  const ACTIVE = new Set(['queued', 'accepted', 'reserving', 'generating', 'archiving', 'restoring']);
  let frame = null, layers = [], front = 0, timer = null, epoch = 0;

  function ensure() {
    if (frame) return frame;
    frame = document.createElement('figure');
    frame.className = 'illustrated-frame';
    frame.hidden = true;
    frame.setAttribute('aria-label', 'Picture of the conversation');
    layers = [document.createElement('img'), document.createElement('img')];
    for (const layer of layers) { layer.decoding = 'async'; layer.draggable = false; frame.append(layer); }
    // A tap enlarges the picture; another tap puts it back in its corner.
    frame.addEventListener('click', () => frame.classList.toggle('is-large'));
    document.body.append(frame);
    return frame;
  }

  function ready(operation, statusUrl) {
    return operation?.state === 'completed' && operation.runtimeRestored === true
      && /^[a-f0-9]{64}$/.test(operation.artifact?.sha256 || '') && operation.artifact.url === statusUrl + '/image';
  }

  function reveal(url, alt, mine) {
    ensure();
    const next = layers[1 - front];
    next.onload = () => {
      if (mine !== epoch) return;
      next.classList.add('is-front');
      layers[front].classList.remove('is-front');
      front = 1 - front;
      frame.hidden = false;
    };
    next.onerror = () => { next.removeAttribute('src'); };
    next.alt = alt;
    next.src = url;
  }

  // Follow one illustration until it is ready or ends. A newer one replaces it.
  function show(block, { fetcher = root.fetch?.bind(root), delay = 4000 } = {}) {
    const operation = block?.operation, match = ROUTE.exec(operation?.statusUrl || '');
    if (block?.presentation !== 'illustration' || !match || match[1] !== operation.id || !fetcher) return false;
    const statusUrl = operation.statusUrl, alt = String(block.body || '').slice(0, 200), mine = ++epoch;
    clearTimeout(timer);
    const poll = async () => {
      if (mine !== epoch) return;
      if (root.document?.hidden) { timer = setTimeout(poll, delay); return; }
      try {
        const response = await fetcher(statusUrl, { cache: 'no-store', redirect: 'error' });
        const data = await response.json();
        if (mine !== epoch || !response.ok || !data.ok || data.operation?.id !== operation.id) return;
        if (ready(data.operation, statusUrl)) reveal(data.operation.artifact.url, alt, mine);
        else if (ACTIVE.has(data.operation.state)) timer = setTimeout(poll, delay);
      } catch { if (mine === epoch) timer = setTimeout(poll, delay * 2); }
    };
    if (ready(operation, statusUrl)) reveal(operation.artifact.url, alt, mine);
    else timer = setTimeout(poll, delay);
    return true;
  }

  function clear() {
    epoch++;
    clearTimeout(timer);
    if (!frame) return;
    frame.hidden = true;
    frame.classList.remove('is-large');
    for (const layer of layers) { layer.onload = null; layer.removeAttribute('src'); layer.classList.remove('is-front'); }
  }

  root.IllustratedFrame = Object.freeze({ show, clear });
}(typeof window !== 'undefined' ? window : globalThis));
