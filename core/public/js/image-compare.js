(function (root) {
  'use strict';
  const SCHEMA = 'agentx.image-review.v1', MAX_JSON_BYTES = 200000, MAX_ITEMS = 30;
  const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const SHA = /^[0-9a-f]{64}$/, TOKEN = /^[a-zA-Z0-9_.:-]{1,128}$/;
  const STATES = ['unverified', 'confirmed', 'difference'];
  const stateLabels = ['À vérifier', 'Conforme selon mon examen', 'Écart observé'];
  const fail = message => { throw new Error(message); };
  function fields(value, keys) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]' ||
        Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
      fail('Le fichier de revue contient une structure invalide.');
    }
  }
  function text(value, limit, allowEmpty = false) {
    if (typeof value !== 'string' || Array.from(value).length > limit || (!allowEmpty && !value.trim())) {
      fail(`Le texte d’un point est requis et limité à ${limit} caractères.`);
    }
    return value;
  }
  function archive(value) {
    fields(value, ['operationId', 'sha256', 'width', 'height']);
    if (typeof value.operationId !== 'string' || !UUID.test(value.operationId) ||
        typeof value.sha256 !== 'string' || !SHA.test(value.sha256) ||
        ![value.width, value.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192) ||
        value.width * value.height > 16000000) fail('L’identité ou les dimensions d’une archive sont invalides.');
    return { operationId: value.operationId, sha256: value.sha256, width: value.width, height: value.height };
  }
  function pair(value) {
    fields(value, ['parent', 'result']);
    const result = { parent: archive(value.parent), result: archive(value.result) };
    if (result.parent.operationId === result.result.operationId) fail('La retouche et son parent doivent être deux opérations distinctes.');
    return result;
  }
  const identity = value => JSON.stringify(pair(value));
  function validate(value) {
    fields(value, ['schema', 'mode', 'pair', 'items']);
    if (value.schema !== SCHEMA || value.mode !== 'manual' || !Array.isArray(value.items) ||
        value.items.length > MAX_ITEMS) fail('Ce fichier n’est pas une revue manuelle compatible.');
    const ids = new Set(), sources = new Set();
    const items = value.items.map(item => {
      fields(item, ['id', 'kind', 'text', 'status', 'note', 'sourceItemId']);
      if (typeof item.id !== 'string' || !TOKEN.test(item.id) || ids.has(item.id) || !['change', 'preserve'].includes(item.kind) ||
          !STATES.includes(item.status) || (item.sourceItemId !== null && (typeof item.sourceItemId !== 'string' || !TOKEN.test(item.sourceItemId))) ||
          (item.sourceItemId !== null && sources.has(item.sourceItemId))) fail('Un point de la revue est invalide ou dupliqué.');
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
        fail('Un point de la revue ne correspond pas à la contrainte enregistrée dans ce brief.');
      }
    }
    function reviewValid() { try { validate(active?.review); return true; } catch { return false; } }
    function controls() {
      $('load').disabled = busy || !currentPair || !engine;
      $('workspace').hidden = !loaded;
      $('add').disabled = busy || !loaded || active.review.items.length >= MAX_ITEMS;
      $('export').disabled = busy || !loaded || !reviewValid(); $('file').disabled = busy || !loaded;
      for (const element of $('items').querySelectorAll('input,select,textarea,button')) element.disabled = busy;
      if (!busy) $('status').textContent = loaded ? 'Les deux archives sont vérifiées. Compare-les et note tes observations.' :
        currentPair ? 'Les deux archives peuvent être chargées pour ton examen.' :
          context().operation && !context().details ? 'Lecture de la provenance de cette image…' :
            'Cette sélection ne possède pas de parent archivé disponible pour la comparaison.';
      if (active && loaded) {
        const count = STATES.map(state => active.review.items.filter(item => item.status === state).length);
        $('review-status').textContent = `${count[0]} à vérifier · ${count[1]} conformes selon ton examen · ${count[2]} écarts observés.${active.dirty ? ' Revue à enregistrer en JSON.' : ''}`;
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
      error(/^(L’|Le |Les |La |Ce |Un |Choisis)/.test(message) ? message :
        'L’image ou la revue ne correspond pas aux archives attendues. Vérifie le fichier et la provenance.');
    }
    function dataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('L’image ne peut pas être lue.')); reader.readAsDataURL(blob);
      });
    }
    async function readImage(source, signal, token, acquired) {
      const response = await fetchImpl(`/api/images/operations/${source.operationId}/image`, { signal, credentials: 'same-origin' });
      if (!response.ok) fail('L’une des archives ne peut pas être chargée.');
      const limit = engine.MAX_BASE64_BYTES * .75;
      if (Number(response.headers.get('content-length')) > limit) fail('L’image est trop volumineuse pour la comparaison.');
      const blob = await response.blob();
      if (stale(token)) return null;
      if (blob.size > limit) fail('L’image est trop volumineuse pour la comparaison.');
      const embedded = await dataUrl(blob);
      if (stale(token)) return null;
      await engine.verifySource(engine.create({ ...source, dataUrl: embedded }));
      if (stale(token)) return null;
      const url = URL.createObjectURL(blob); urls.add(url); acquired.push(url);
      await new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => {
          if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) reject(new Error('Les dimensions de l’archive sont incohérentes.'));
          else resolve();
        }; image.onerror = () => reject(new Error('L’image archivée ne peut pas être décodée.')); image.src = url;
      });
      return url;
    }
    async function loadPair() {
      if (busy || !currentPair || !engine) return;
      const target = currentPair, acquired = [], { token, signal } = start('Vérification du parent et du résultat archivés…');
      let committed = false;
      try {
        const response = await fetchImpl(`/api/images/operations/${target.parent.operationId}`, { signal, credentials: 'same-origin' });
        const value = await response.json();
        if (stale(token)) return;
        const parent = value.operation;
        if (!response.ok || !value.ok || parent?.id !== target.parent.operationId || parent.state !== 'completed' ||
            parent.runtimeRestored !== true || parent.artifact?.sha256 !== target.parent.sha256 ||
            parent.artifact.width !== target.parent.width || parent.artifact.height !== target.parent.height) {
          fail('La provenance du parent ne correspond pas à cette retouche.');
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
      for (const [kind, title] of [['parent', 'Original parent'], ['result', 'Résultat']]) {
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
      $('dimensions').textContent = `Parent : ${currentPair.parent.width} × ${currentPair.parent.height} px · Résultat : ${currentPair.result.width} × ${currentPair.result.height} px.${same ? '' : ' Dimensions différentes : le volet coulissant est indisponible ; chaque image conserve ses proportions.'}`;
      for (const name of ['parent-scroll', 'result-scroll', 'slider-scroll']) { $(name).scrollLeft = 0; $(name).scrollTop = 0; }
      slide();
    }
    function slide() {
      const position = Math.max(0, Math.min(100, Number($('position').value)));
      $('slider-result').style.clipPath = `inset(0 ${100 - position}% 0 0)`;
      $('seam').style.left = `${position}%`; $('percent').textContent = `${position} %`;
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
        group.append(node('legend', `Point ${index + 1}${item.sourceItemId ? ' · contrainte du brief' : ''}`));
        const selects = node('div'); selects.className = 'compare-item-selects';
        const addField = (target, title, field, element) => {
          const label = node('label', title); element.dataset.field = field;
          label.append(element); target.append(label); return element;
        };
        const kind = node('select'); [['preserve', 'À conserver'], ['change', 'À modifier']].forEach(([value, title]) => {
          const option = node('option', title); option.value = value; kind.append(option);
        }); kind.value = item.kind; addField(selects, 'Intention', 'kind', kind);
        const state = node('select'); STATES.forEach((value, i) => { const option = node('option', stateLabels[i]); option.value = value; state.append(option); });
        state.value = item.status; addField(selects, 'Mon observation', 'status', state); group.append(selects);
        const content = node('textarea'); content.rows = 2; content.maxLength = 600;
        content.value = item.text; content.readOnly = item.sourceItemId !== null;
        addField(group, item.sourceItemId ? 'Contrainte enregistrée (texte conservé)' : 'Point à examiner (300 caractères maximum)', 'text', content);
        const note = node('textarea'); note.rows = 2; note.maxLength = 2000; note.value = item.note;
        addField(group, 'Mon commentaire (1 000 caractères maximum)', 'note', note);
        const remove = node('button', 'Retirer ce point'); remove.type = 'button'; remove.className = 'quiet-button'; remove.dataset.action = 'remove'; group.append(remove);
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
      active.review.items.push({ id: `manual-${n}`, kind: 'change', text: 'Point à examiner', status: 'unverified', note: '', sourceItemId: null });
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
        if (blob.size > MAX_JSON_BYTES) fail('La revue JSON dépasse la taille autorisée.');
        const url = URL.createObjectURL(blob); urls.add(url); const link = node('a');
        link.href = url; link.download = `agentx-revue-${currentPair.result.operationId}.json`;
        document.body.append(link); link.click(); link.remove();
        root.setTimeout(() => revoke(url), 1000); active.dirty = false; error(); controls();
      } catch (err) { error(err.message || 'La revue ne peut pas être exportée.'); }
    }
    async function importReview() {
      const file = $('file').files?.[0]; $('file').value = '';
      if (busy || !loaded || !file) return;
      if (active.dirty && !root.confirm('Remplacer cette revue ? Les observations non enregistrées en JSON seront perdues.')) return;
      const { token } = start('Lecture de la revue manuelle…');
      try {
        if (file.size > MAX_JSON_BYTES) fail('La revue JSON dépasse la taille autorisée.');
        const content = await file.text(); if (stale(token)) return;
        if (new Blob([content]).size > MAX_JSON_BYTES) fail('La revue JSON dépasse la taille autorisée.');
        let value; try { value = JSON.parse(content); } catch { fail('Le fichier de revue JSON ne peut pas être lu.'); }
        const review = validate(value);
        if (identity(review.pair) !== identity(currentPair)) fail('Choisis les deux archives enregistrées dans cette revue avant de la rouvrir.');
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
