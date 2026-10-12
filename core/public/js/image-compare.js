(function (root) {
  'use strict';
  const SCHEMA = 'agentx.image-review.v1', MAX_JSON_BYTES = 200000, MAX_ITEMS = 30;
  const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const SHA = /^[0-9a-f]{64}$/, TOKEN = /^[a-zA-Z0-9_.:-]{1,128}$/;
  const STATES = ['unverified', 'confirmed', 'difference'];
  const stateLabels = ['To check', 'Matches on my review', 'Difference observed'];
  // Errors raised here already speak to the person; engine errors get a generic explanation.
  const notice = message => Object.assign(new Error(message), { notice: true });
  const fail = message => { throw notice(message); };
  function fields(value, keys) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]' ||
        Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
      fail('The review file has an invalid structure.');
    }
  }
  function text(value, limit, allowEmpty = false) {
    if (typeof value !== 'string' || Array.from(value).length > limit || (!allowEmpty && !value.trim())) {
      fail(`An item’s text is required and limited to ${limit} characters.`);
    }
    return value;
  }
  function archive(value) {
    fields(value, ['operationId', 'sha256', 'width', 'height']);
    if (typeof value.operationId !== 'string' || !UUID.test(value.operationId) ||
        typeof value.sha256 !== 'string' || !SHA.test(value.sha256) ||
        ![value.width, value.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192) ||
        value.width * value.height > 16000000) fail('An archive’s identity or dimensions are invalid.');
    return { operationId: value.operationId, sha256: value.sha256, width: value.width, height: value.height };
  }
  function pair(value) {
    fields(value, ['parent', 'result']);
    const result = { parent: archive(value.parent), result: archive(value.result) };
    if (result.parent.operationId === result.result.operationId) fail('The edit and its parent must be two distinct operations.');
    return result;
  }
  const identity = value => JSON.stringify(pair(value));
  function validate(value) {
    fields(value, ['schema', 'mode', 'pair', 'items']);
    if (value.schema !== SCHEMA || value.mode !== 'manual' || !Array.isArray(value.items) ||
        value.items.length > MAX_ITEMS) fail('This file is not a compatible manual review.');
    const ids = new Set(), sources = new Set();
    const items = value.items.map(item => {
      fields(item, ['id', 'kind', 'text', 'status', 'note', 'sourceItemId']);
      if (typeof item.id !== 'string' || !TOKEN.test(item.id) || ids.has(item.id) || !['change', 'preserve'].includes(item.kind) ||
          !STATES.includes(item.status) || (item.sourceItemId !== null && (typeof item.sourceItemId !== 'string' || !TOKEN.test(item.sourceItemId))) ||
          (item.sourceItemId !== null && sources.has(item.sourceItemId))) fail('A review item is invalid or duplicated.');
      ids.add(item.id); if (item.sourceItemId) sources.add(item.sourceItemId);
      return { id: item.id, kind: item.kind, text: text(item.text, 300), status: item.status,
        note: text(item.note, 1000, true), sourceItemId: item.sourceItemId };
    });
    return { schema: SCHEMA, mode: 'manual', pair: pair(value.pair), items };
  }

  function init({ getContext, fetchImpl = root.fetch.bind(root) }) {
    const panel = document.getElementById('image-compare');
    if (!panel) return { refresh() {}, destroy() {} };
    const $ = name => document.getElementById(`image-compare-${name}`), engine = root.ImageTextProject;
    const events = [], urls = new Set(), reviews = new Map();
    let epoch = 0, stamp = '', request = null, busy = false, loaded = false;
    let currentPair = null, active = null, destroyed = false, syncing = false;
    const listen = (element, name, handler) => {
      element.addEventListener(name, handler); events.push(() => element.removeEventListener(name, handler));
    };
    const context = () => getContext() || {};
    const error = (message = '') => { $('error').textContent = message; $('error').hidden = !message; };
    function expected() {
      const { operation: op, details, locked } = context();
      if (locked || op?.state !== 'completed' || op.runtimeRestored !== true || !op.artifact ||
          details?.id !== op.id || details.lineage?.version !== 1 || !details.lineage.parent) return null;
      try {
        return pair({ parent: details.lineage.parent, result: { operationId: op.id,
          sha256: op.artifact.sha256, width: op.artifact.width, height: op.artifact.height } });
      } catch { return null; }
    }
    function constraints() {
      const manifest = context().details?.request?.constraints;
      if (manifest?.version !== 1 || !Array.isArray(manifest.items) || manifest.items.length > 20) return [];
      const ids = new Set();
      return manifest.items.filter(item => {
        if (!item || !TOKEN.test(item.id) || ids.has(item.id) || typeof item.text !== 'string' ||
            !item.text.trim() || Array.from(item.text).length > 300) return false;
        ids.add(item.id); return true;
      });
    }
    function initialReview() {
      return { schema: SCHEMA, mode: 'manual', pair: currentPair,
        items: constraints().map((item, i) => ({ id: `constraint-${i + 1}`, kind: 'preserve',
          text: item.text, status: 'unverified', note: '', sourceItemId: item.id })) };
    }
    function verifyConstraintLinks(review) {
      const originals = new Map(constraints().map(item => [item.id, item.text]));
      if (review.items.some(item => item.sourceItemId !== null && originals.get(item.sourceItemId) !== item.text)) {
        fail('A review item does not match the constraint recorded in this brief.');
      }
    }
    function reviewValid() { try { validate(active?.review); return true; } catch { return false; } }
    function controls() {
      panel.hidden = !currentPair;
      $('load').disabled = busy || !currentPair || !engine;
      $('workspace').hidden = !loaded;
      $('add').disabled = busy || !loaded || active.review.items.length >= MAX_ITEMS;
      $('export').disabled = busy || !loaded || !reviewValid(); $('file').disabled = busy || !loaded;
      for (const element of $('items').querySelectorAll('input,select,textarea,button')) element.disabled = busy;
      if (!busy) $('status').textContent = loaded ? 'Both archives are verified. Compare them and note your observations.' :
        currentPair ? 'Both archives can be loaded for your review.' :
          context().operation && !context().details ? 'Reading this image’s provenance…' :
            'This selection has no archived parent available for comparison.';
      if (active && loaded) {
        const count = STATES.map(state => active.review.items.filter(item => item.status === state).length);
        $('review-status').textContent = `${count[0]} to check · ${count[1]} matching on your review · ${count[2]} difference${count[2] === 1 ? '' : 's'} observed.${active.dirty ? ' Review to save as JSON.' : ''}`;
      }
    }
    function revoke(url) { URL.revokeObjectURL(url); urls.delete(url); }
    function clearImages() {
      for (const name of ['parent-image', 'result-image', 'slider-parent', 'slider-result']) $(name).removeAttribute('src');
      urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); loaded = false;
    }
    function stale(token) { return destroyed || token !== epoch; }
    function start(message) {
      request?.abort(); request = new AbortController(); busy = true; const token = ++epoch;
      error(); controls(); $('status').textContent = message;
      return { token, signal: request.signal };
    }
    function finish(token) { if (!stale(token)) { busy = false; request = null; controls(); } }
    function failure(err, token) {
      if (stale(token) || err.name === 'AbortError') return;
      const message = err.message || '';
      error(err.notice ? message :
        'The image or the review does not match the expected archives. Check the file and the provenance.');
    }
    function dataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(notice('The image cannot be read.')); reader.readAsDataURL(blob);
      });
    }
    async function readImage(source, signal, token, acquired) {
      const response = await fetchImpl(`/api/images/operations/${source.operationId}/image`, { signal, credentials: 'same-origin' });
      if (!response.ok) fail('One of the archives cannot be loaded.');
      const limit = engine.MAX_BASE64_BYTES * .75;
      if (Number(response.headers.get('content-length')) > limit) fail('The image is too large for the comparison.');
      const blob = await response.blob();
      if (stale(token)) return null;
      if (blob.size > limit) fail('The image is too large for the comparison.');
      const embedded = await dataUrl(blob);
      if (stale(token)) return null;
      await engine.verifySource(engine.create({ ...source, dataUrl: embedded }));
      if (stale(token)) return null;
      const url = URL.createObjectURL(blob); urls.add(url); acquired.push(url);
      await new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => {
          if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) reject(notice('The archive dimensions are inconsistent.'));
          else resolve();
        }; image.onerror = () => reject(notice('The archived image cannot be decoded.')); image.src = url;
      });
      return url;
    }
    async function loadPair() {
      if (busy || !currentPair || !engine) return;
      const target = currentPair, acquired = [], { token, signal } = start('Checking the archived parent and result…');
      let committed = false;
      try {
        const response = await fetchImpl(`/api/images/operations/${target.parent.operationId}`, { signal, credentials: 'same-origin' });
        const value = await response.json();
        if (stale(token)) return;
        const parent = value.operation;
        if (!response.ok || !value.ok || parent?.id !== target.parent.operationId || parent.state !== 'completed' ||
            parent.runtimeRestored !== true || parent.artifact?.sha256 !== target.parent.sha256 ||
            parent.artifact.width !== target.parent.width || parent.artifact.height !== target.parent.height) {
          fail('The parent’s provenance does not match this edit.');
        }
        const images = await Promise.allSettled([readImage(target.parent, signal, token, acquired), readImage(target.result, signal, token, acquired)]);
        if (stale(token)) return;
        const rejected = images.find(item => item.status === 'rejected'); if (rejected) throw rejected.reason;
        const [parentUrl, resultUrl] = images.map(item => item.value);
        if (!parentUrl || !resultUrl) return;
        acquired.forEach(url => urls.delete(url)); clearImages(); acquired.forEach(url => urls.add(url));
        $('parent-image').src = $('slider-parent').src = parentUrl;
        $('result-image').src = $('slider-result').src = resultUrl;
        const id = identity(target);
        if (!reviews.has(id)) reviews.set(id, { review: initialReview(), dirty: false });
        active = reviews.get(id); loaded = true; committed = true;
        renderProvenance(); renderItems(); presentation(); panel.open = true;
      } catch (err) { failure(err, token); }
      finally { if (!committed) acquired.forEach(revoke); finish(token); }
    }
    function renderProvenance() {
      $('provenance').replaceChildren();
      for (const [kind, title] of [['parent', 'Parent original'], ['result', 'Result']]) {
        const source = currentPair[kind], row = document.createElement('div');
        const term = document.createElement('dt'), value = document.createElement('dd');
        term.textContent = title;
        value.textContent = `${source.operationId} · ${source.width} × ${source.height} px · SHA-256 ${source.sha256}`;
        row.append(term, value); $('provenance').append(row);
      }
    }
    function presentation() {
      if (!loaded) return;
      const same = currentPair.parent.width === currentPair.result.width && currentPair.parent.height === currentPair.result.height;
      $('mode').options[1].disabled = !same;
      if (!same) $('mode').value = 'side';
      const slider = $('mode').value === 'slider', native = $('zoom').value === 'native';
      $('side').hidden = slider; $('slider').hidden = !slider;
      $('sync').disabled = slider || !native;
      panel.classList.toggle('compare-native', native);
      $('stage').style.width = native ? `${currentPair.result.width}px` : '100%';
      $('dimensions').textContent = `Parent: ${currentPair.parent.width} × ${currentPair.parent.height} px · Result: ${currentPair.result.width} × ${currentPair.result.height} px.${same ? '' : ' Different dimensions: the sliding divider is unavailable; each image keeps its proportions.'}`;
      for (const name of ['parent-scroll', 'result-scroll', 'slider-scroll']) { $(name).scrollLeft = 0; $(name).scrollTop = 0; }
      slide();
    }
    function slide() {
      const position = Math.max(0, Math.min(100, Number($('position').value)));
      $('slider-result').style.clipPath = `inset(0 ${100 - position}% 0 0)`;
      $('seam').style.left = `${position}%`; $('percent').textContent = `${position}%`;
    }
    function sync(from, to) {
      if (syncing || !loaded || $('zoom').value !== 'native' || !$('sync').checked) return;
      syncing = true;
      for (const [scroll, total, visible] of [['scrollLeft', 'scrollWidth', 'clientWidth'], ['scrollTop', 'scrollHeight', 'clientHeight']]) {
        const max = Math.max(0, from[total] - from[visible]), targetMax = Math.max(0, to[total] - to[visible]);
        const value = max ? from[scroll] / max * targetMax : 0;
        if (Math.abs(to[scroll] - value) > 1) to[scroll] = value;
      }
      syncing = false;
    }
    function node(tag, content) { const element = document.createElement(tag); if (content !== undefined) element.textContent = content; return element; }
    function renderItems() {
      $('items').replaceChildren();
      active.review.items.forEach((item, index) => {
        const group = node('fieldset'); group.className = 'compare-item'; group.dataset.item = item.id;
        group.append(node('legend', `Item ${index + 1}${item.sourceItemId ? ' · brief constraint' : ''}`));
        const selects = node('div'); selects.className = 'compare-item-selects';
        const addField = (target, title, field, element) => {
          const label = node('label', title); element.dataset.field = field;
          label.append(element); target.append(label); return element;
        };
        const kind = node('select'); [['preserve', 'To keep'], ['change', 'To change']].forEach(([value, title]) => {
          const option = node('option', title); option.value = value; kind.append(option);
        }); kind.value = item.kind; addField(selects, 'Intention', 'kind', kind);
        const state = node('select'); STATES.forEach((value, i) => { const option = node('option', stateLabels[i]); option.value = value; state.append(option); });
        state.value = item.status; addField(selects, 'My observation', 'status', state); group.append(selects);
        const content = node('textarea'); content.rows = 2; content.maxLength = 600;
        content.value = item.text; content.readOnly = item.sourceItemId !== null;
        addField(group, item.sourceItemId ? 'Recorded constraint (text kept)' : 'Item to review (300 characters maximum)', 'text', content);
        const note = node('textarea'); note.rows = 2; note.maxLength = 2000; note.value = item.note;
        addField(group, 'My comment (1,000 characters maximum)', 'note', note);
        const remove = node('button', 'Remove this item'); remove.type = 'button'; remove.className = 'quiet-button'; remove.dataset.action = 'remove'; group.append(remove);
        $('items').append(group);
      });
      controls();
    }
    function updateItem(event) {
      if (busy || !loaded) return;
      const field = event.target.dataset.field, group = event.target.closest('[data-item]');
      const item = active.review.items.find(value => value.id === group?.dataset.item);
      if (!item || !['text', 'note', 'kind', 'status'].includes(field) || (field === 'text' && item.sourceItemId)) return;
      item[field] = event.target.value; active.dirty = true;
      try { validate(active.review); error(); } catch (err) { error(err.message); }
      controls();
    }
    function addItem() {
      if (busy || !loaded || active.review.items.length >= MAX_ITEMS) return;
      let n = 1; while (active.review.items.some(item => item.id === `manual-${n}`)) n++;
      active.review.items.push({ id: `manual-${n}`, kind: 'change', text: 'Item to review', status: 'unverified', note: '', sourceItemId: null });
      active.dirty = true; error(); renderItems();
    }
    function removeItem(event) {
      if (busy || !loaded || event.target.dataset.action !== 'remove') return;
      const group = event.target.closest('[data-item]');
      active.review.items = active.review.items.filter(item => item.id !== group?.dataset.item);
      active.dirty = true; error(); renderItems();
    }
    function exportReview() {
      if (busy || !loaded) return;
      try {
        const review = validate(active.review); verifyConstraintLinks(review);
        const json = JSON.stringify(review, null, 2), blob = new Blob([json], { type: 'application/json' });
        if (blob.size > MAX_JSON_BYTES) fail('The JSON review exceeds the allowed size.');
        const url = URL.createObjectURL(blob); urls.add(url); const link = node('a');
        link.href = url; link.download = `agentx-review-${currentPair.result.operationId}.json`;
        document.body.append(link); link.click(); link.remove();
        root.setTimeout(() => revoke(url), 1000); active.dirty = false; error(); controls();
      } catch (err) { error(err.message || 'The review cannot be exported.'); }
    }
    async function importReview() {
      const file = $('file').files?.[0]; $('file').value = '';
      if (busy || !loaded || !file) return;
      if (active.dirty && !root.confirm('Replace this review? Observations not saved as JSON will be lost.')) return;
      const { token } = start('Reading the manual review…');
      try {
        if (file.size > MAX_JSON_BYTES) fail('The JSON review exceeds the allowed size.');
        const content = await file.text(); if (stale(token)) return;
        if (new Blob([content]).size > MAX_JSON_BYTES) fail('The JSON review exceeds the allowed size.');
        let value; try { value = JSON.parse(content); } catch { fail('The JSON review file cannot be read.'); }
        const review = validate(value);
        if (identity(review.pair) !== identity(currentPair)) fail('Choose the two archives recorded in this review before reopening it.');
        verifyConstraintLinks(review); active.review = review; active.dirty = false; error(); renderItems();
      } catch (err) { failure(err, token); } finally { finish(token); }
    }
    function refresh() {
      const { operation: op, details, locked } = context();
      const next = JSON.stringify([op?.id, op?.state, op?.runtimeRestored, op?.artifact, details?.id,
        details?.lineage?.parent, details?.request?.constraints, Boolean(locked)]);
      if (next !== stamp) {
        stamp = next; epoch++; request?.abort(); request = null; busy = false;
        clearImages(); currentPair = expected(); active = currentPair ? reviews.get(identity(currentPair)) || null : null; error();
      }
      controls();
    }
    listen($('load'), 'click', loadPair); listen($('mode'), 'change', presentation); listen($('zoom'), 'change', presentation);
    listen($('position'), 'input', slide);
    listen($('parent-scroll'), 'scroll', () => sync($('parent-scroll'), $('result-scroll')));
    listen($('result-scroll'), 'scroll', () => sync($('result-scroll'), $('parent-scroll')));
    listen($('items'), 'input', updateItem); listen($('items'), 'change', updateItem); listen($('items'), 'click', removeItem);
    listen($('add'), 'click', addItem); listen($('export'), 'click', exportReview); listen($('file'), 'change', importReview);
    listen(root, 'beforeunload', event => { if ([...reviews.values()].some(value => value.dirty)) { event.preventDefault(); event.returnValue = ''; } });
    refresh();
    return { refresh, destroy() {
      destroyed = true; epoch++; request?.abort(); clearImages(); events.forEach(remove => remove()); reviews.clear();
    } };
  }
  root.ImageCompare = { init };
})(window);
