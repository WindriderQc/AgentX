(function (root) {
  'use strict';
  function init({ getContext, fetchImpl = root.fetch.bind(root) }) {
    const panel = document.getElementById('image-protected-composition');
    if (!panel) return { refresh() {}, destroy() {} };
    const $ = name => document.getElementById(`image-protected-${name}`);
    const events = [], urls = new Set(), cache = new Map();
    let epoch = 0, contextKey = '', active = null, parentImage = null, regions = [], drag = null, busy = false, request = null, destroyed = false;
    function listen(el, event, handler) { el.addEventListener(event, handler); events.push(() => el.removeEventListener(event, handler)); }
    function pair() {
      if (destroyed) return null;
      const { operation: op, details, locked } = getContext() || {}, parent = details?.lineage?.parent;
      const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i, sha = /^[0-9a-f]{64}$/;
      if (locked || op?.state !== 'completed' || op.runtimeRestored !== true || details?.id !== op.id || details.lineage?.version !== 1 || !uuid.test(op.id || '')
        || !sha.test(op.artifact?.sha256 || '') || !uuid.test(parent?.operationId || '') || !sha.test(parent?.sha256 || '')
        || op.id === parent.operationId || ![op.artifact.width, op.artifact.height, parent.width, parent.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)
        || parent.width * parent.height > 4300800 || op.artifact.width * op.artifact.height > 4300800) return null;
      return { operation: op, parent, key: JSON.stringify([op.id, op.artifact.sha256, op.artifact.width, op.artifact.height,
        parent.operationId, parent.sha256, parent.width, parent.height]) };
    }
    const status = text => { $('status').textContent = text; };
    function readable(error) {
      const message = error?.message || '';
      if (message.includes('SHA-256')) return 'L’empreinte de l’image reçue ne correspond pas à l’archive.';
      return /^(Le |Les |La |L’|Un |Une |Choisis |Deux |Cette )/.test(message) ? message : 'L’image ou la composition reçue ne peut pas être vérifiée.';
    }
    function clearDownloads() {
      $('downloads').hidden = true; $('output').removeAttribute('src');
      for (const url of urls) URL.revokeObjectURL(url); urls.clear();
      $('png').removeAttribute('href'); $('receipt').removeAttribute('href');
    }
    function controls() {
      const current = pair(), dimensionsMatch = current && current.operation.artifact.width === current.parent.width && current.operation.artifact.height === current.parent.height;
      $('prepare').disabled = busy || !dimensionsMatch;
      $('fields').disabled = busy || !active || active.key !== current?.key || regions.length >= 20;
      $('build').disabled = busy || !active || active.key !== current?.key || !regions.length;
      for (const button of $('regions').querySelectorAll('button')) button.disabled = busy;
    }
    function paint() {
      if (!parentImage || !active) return;
      const canvas = $('canvas'), ctx = canvas.getContext('2d');
      canvas.width = active.parent.width; canvas.height = active.parent.height;
      ctx.drawImage(parentImage, 0, 0);
      for (const region of [...regions, ...(drag ? [rectangle(drag.start, drag.end)] : [])]) {
        ctx.fillStyle = 'rgba(42,159,255,.25)'; ctx.strokeStyle = '#279fff'; ctx.lineWidth = Math.max(2, canvas.width / 600);
        ctx.fillRect(region.x, region.y, region.width, region.height); ctx.strokeRect(region.x, region.y, region.width, region.height);
      }
    }
    function list() {
      $('regions').replaceChildren();
      regions.forEach((region, index) => {
        const li = document.createElement('li'), button = document.createElement('button');
        li.append(document.createTextNode(`${index + 1} · (${region.x}, ${region.y}) · ${region.width} × ${region.height} px`));
        button.type = 'button'; button.className = 'quiet-button'; button.textContent = 'Retirer';
        button.addEventListener('click', () => { if (busy || !active || active.key !== pair()?.key) return; regions.splice(index, 1); changed(); }); li.append(button); $('regions').append(li);
      });
      controls();
    }
    function changed() { cache.set(active.key, regions.map(r => ({ ...r }))); clearDownloads(); list(); paint(); status('Zones modifiées. Compose pour vérifier et télécharger le résultat.'); }
    function add(region) {
      if (busy || !active || active.key !== pair()?.key) return;
      if (regions.length >= 20 || !Object.values(region).every(Number.isSafeInteger) || region.x < 0 || region.y < 0
        || region.width < 1 || region.height < 1 || region.x + region.width > active.parent.width || region.y + region.height > active.parent.height) {
        status('Choisis une zone entière dans les dimensions du parent ; 20 zones au maximum.'); return;
      }
      regions.push(region); changed();
    }
    function point(event) {
      const rect = $('canvas').getBoundingClientRect();
      return { x: Math.max(0, Math.min(active.parent.width, Math.round((event.clientX - rect.left) / rect.width * active.parent.width))),
        y: Math.max(0, Math.min(active.parent.height, Math.round((event.clientY - rect.top) / rect.height * active.parent.height))) };
    }
    function rectangle(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }; }
    async function verifiedImage(descriptor, operationId, signal) {
      const response = await fetchImpl(`/api/images/operations/${encodeURIComponent(operationId)}/image`, { signal });
      if (!response.ok) throw new Error('Le parent archivé ne peut pas être chargé.');
      const blob = await response.blob();
      if (blob.size > 50 * 1024 * 1024) throw new Error('Le parent dépasse la limite de lecture.');
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      const project = root.ImageTextProject.create({ operationId, sha256: descriptor.sha256, width: descriptor.width, height: descriptor.height, dataUrl });
      await root.ImageTextProject.verifySource(project);
      const image = new Image(); image.src = dataUrl; await image.decode();
      if (image.naturalWidth !== descriptor.width || image.naturalHeight !== descriptor.height) throw new Error('Les dimensions décodées du parent sont incohérentes.');
      return image;
    }
    async function prepare() {
      const selected = pair(); if (!selected || busy || selected.parent.width !== selected.operation.artifact.width
        || selected.parent.height !== selected.operation.artifact.height) return;
      const token = ++epoch; busy = true; request = new AbortController(); controls(); status('Vérification du parent archivé…');
      try {
        const image = await verifiedImage(selected.parent, selected.parent.operationId, request.signal);
        if (token !== epoch || selected.key !== pair()?.key) return;
        active = selected; parentImage = image; regions = (cache.get(selected.key) || []).map(r => ({ ...r }));
        $('workspace').hidden = false; list(); paint(); status('Parent vérifié. Choisis les zones à remplacer.');
      } catch (error) { if (token === epoch) status(readable(error)); }
      finally { if (token === epoch) { busy = false; request = null; controls(); } }
    }
    async function build() {
      if (busy || !active || active.key !== pair()?.key || !regions.length) return;
      const selected = active, token = ++epoch, chosen = regions.map(r => ({ ...r }));
      busy = true; request = new AbortController(); clearDownloads(); controls(); status('Composition et vérification des pixels hors des zones…');
      try {
        const response = await fetchImpl(`/api/images/operations/${encodeURIComponent(selected.operation.id)}/protected-composition`, {
          method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentSha256: selected.parent.sha256, resultSha256: selected.operation.artifact.sha256, regions: chosen })
        });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.message || 'La composition n’est pas disponible.');
        if (token !== epoch || selected.key !== pair()?.key) return;
        const receipt = body.receipt;
        if (receipt?.schema !== 'agentx.protected-image-composition/v1' || receipt.parent?.operationId !== selected.parent.operationId
          || receipt.parent?.sha256 !== selected.parent.sha256 || receipt.result?.operationId !== selected.operation.id
          || receipt.result?.sha256 !== selected.operation.artifact.sha256 || receipt.proof?.verified !== true
          || receipt.width !== selected.parent.width || receipt.height !== selected.parent.height
          || receipt.proof.contract !== 'decoded-rgba-row-major-outside-rectangle-union/v1'
          || !/^[0-9a-f]{64}$/.test(receipt.proof.outsideRgbaSha256 || '')
          || ![receipt.proof.protectedPixels, receipt.proof.selectedPixels].every(n => Number.isInteger(n) && n >= 0)
          || receipt.proof.protectedPixels + receipt.proof.selectedPixels !== receipt.width * receipt.height
          || JSON.stringify(receipt.regions) !== JSON.stringify(chosen) || typeof body.png !== 'string') throw new Error('Le reçu ne correspond pas aux zones sélectionnées.');
        const project = root.ImageTextProject.create({ operationId: selected.operation.id, sha256: receipt.proof.outputSha256,
          width: selected.parent.width, height: selected.parent.height, dataUrl: `data:image/png;base64,${body.png}` });
        await root.ImageTextProject.verifySource(project);
        if (token !== epoch || selected.key !== pair()?.key) return;
        const bytes = Uint8Array.from(atob(body.png), character => character.charCodeAt(0));
        const pngUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })); urls.add(pngUrl);
        const receiptUrl = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2) + '\n'], { type: 'application/json' })); urls.add(receiptUrl);
        $('png').href = pngUrl; $('receipt').href = receiptUrl; $('output').src = pngUrl; $('downloads').hidden = false;
        status(`${new Intl.NumberFormat('fr-CA').format(receipt.proof.protectedPixels)} pixels hors des zones conservés et vérifiés. Télécharge la composition et son reçu.`);
      } catch (error) { if (token === epoch) status(readable(error)); }
      finally { if (token === epoch) { busy = false; request = null; controls(); } }
    }
    function refresh() {
      if (destroyed) return;
      const selected = pair(), key = selected?.key || '';
      panel.hidden = !selected;
      if (key !== contextKey) {
        contextKey = key; ++epoch; request?.abort(); request = null; busy = false; active = null; parentImage = null; regions = []; drag = null;
        clearDownloads(); $('workspace').hidden = true;
        status(selected && (selected.parent.width !== selected.operation.artifact.width || selected.parent.height !== selected.operation.artifact.height)
          ? 'Dimensions différentes : cette composition ne peut pas être préparée sans modifier le format. Choisis un résultat au format du parent.' : 'Prépare le parent pour choisir les zones.');
      }
      controls();
    }
    listen($('prepare'), 'click', () => { void prepare(); });
    listen($('build'), 'click', () => { void build(); });
    listen($('add'), 'click', () => add(Object.fromEntries(['x', 'y', 'width', 'height'].map(name => [name, $(name).value === '' ? NaN : Number($(name).value)]))));
    listen($('canvas'), 'pointerdown', event => {
      if (busy || !active || active.key !== pair()?.key || regions.length >= 20 || event.button !== 0) return;
      drag = { start: point(event), end: point(event) }; $('canvas').setPointerCapture(event.pointerId); paint();
    });
    listen($('canvas'), 'pointermove', event => { if (drag) { drag.end = point(event); paint(); } });
    listen($('canvas'), 'pointerup', event => { if (!drag) return; const region = rectangle(drag.start, point(event)); drag = null; add(region); paint(); });
    listen($('canvas'), 'pointercancel', () => { drag = null; paint(); });
    refresh();
    return { refresh, destroy() { destroyed = true; ++epoch; request?.abort(); events.forEach(remove => remove()); clearDownloads(); panel.hidden = true; } };
  }
  root.ImageProtectedComposition = { init };
})(typeof globalThis !== 'undefined' ? globalThis : this);
