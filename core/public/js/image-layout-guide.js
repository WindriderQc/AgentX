(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageLayoutGuide = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const SCHEMA = 'agentx.image-layout-guide/v1';
  const MAX_JSON_BYTES = 65536, MAX_BOXES = 24, MAX_NAME = 80;
  const MAX_BASE64_BYTES = 3 * 1024 * 1024, MAX_RENDER_EDGE = 1536;
  const PALETTE = ['#c5d9cf', '#d5ddec', '#e4d4c4', '#ded0dd', '#d9dfbd', '#c8dce3'];
  const fail = message => { throw new Error(message); };
  function fields(value, allowed, name) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]' ||
        Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) {
      fail(`${name} contient des champs manquants ou inconnus.`);
    }
  }
  function numeric(value, min, max) { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
  function validate(project) {
    fields(project, ['schema', 'width', 'height', 'boxes'], 'Le projet');
    if (project.schema !== SCHEMA) fail('Cette version de projet d’esquisse est inconnue.');
    if (![project.width, project.height].every(value => Number.isInteger(value) && value >= 256 && value <= 8192) ||
        project.width * project.height > 16000000 || Math.max(project.width, project.height) / Math.min(project.width, project.height) > 8) {
      fail('Le format de l’esquisse dépasse les limites autorisées : 16 MP et un ratio maximal de 8:1.');
    }
    if (!Array.isArray(project.boxes) || project.boxes.length > MAX_BOXES) fail(`L’esquisse accepte ${MAX_BOXES} zones au maximum.`);
    const ids = new Set();
    const boxes = project.boxes.map(box => {
      fields(box, ['id', 'name', 'x', 'y', 'width', 'height', 'color'], 'Une zone');
      if (typeof box.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(box.id) || ids.has(box.id)) fail('Chaque zone exige un identifiant unique.');
      ids.add(box.id);
      if (typeof box.name !== 'string' || !box.name.trim() || Array.from(box.name).length > MAX_NAME ||
          /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(box.name)) fail(`Nomme la zone en ${MAX_NAME} caractères au maximum, sur une ligne.`);
      if (!numeric(box.x, 0, 1) || !numeric(box.y, 0, 1) || !numeric(box.width, .01, 1) || !numeric(box.height, .01, 1) ||
          box.x + box.width > 1 + 1e-10 || box.y + box.height > 1 + 1e-10) fail('Chaque zone doit tenir entièrement dans l’esquisse, avec une taille d’au moins 1 %.');
      if (typeof box.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(box.color)) fail('La couleur de zone est invalide.');
      return { id: box.id, name: box.name, x: box.x, y: box.y, width: box.width, height: box.height, color: box.color };
    });
    return { schema: SCHEMA, width: project.width, height: project.height, boxes };
  }
  function create(width, height) { return validate({ schema: SCHEMA, width, height, boxes: [] }); }
  function jsonBytes(value) {
    if (typeof value !== 'string' || value.length > MAX_JSON_BYTES) fail('Le projet JSON est trop volumineux.');
    let bytes = 0;
    for (const char of value) { const point = char.codePointAt(0); bytes += point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4; }
    if (bytes > MAX_JSON_BYTES) fail('Le projet JSON est trop volumineux.');
  }
  function stringify(project) { const json = JSON.stringify(validate(project), null, 2); jsonBytes(json); return json; }
  function parse(json) {
    jsonBytes(json);
    let project; try { project = JSON.parse(json); } catch { fail('Le fichier ne contient pas un projet JSON valide.'); }
    return validate(project);
  }
  function renderSize(project) {
    const scale = Math.min(1, MAX_RENDER_EDGE / Math.max(project.width, project.height));
    return { width: Math.round(project.width * scale), height: Math.round(project.height * scale) };
  }
  function draw(canvas, project, selected = null) {
    project = validate(project);
    const size = renderSize(project);
    canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) fail('L’esquisse ne peut pas être affichée dans ce navigateur.');
    ctx.fillStyle = '#f6f4ef'; ctx.fillRect(0, 0, size.width, size.height);
    project.boxes.forEach(box => {
      const x = box.x * size.width, y = box.y * size.height, w = box.width * size.width, h = box.height * size.height;
      ctx.fillStyle = box.color; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = selected === box.id ? '#22618d' : '#4d5860'; ctx.lineWidth = selected === box.id ? 3 : 1;
      ctx.strokeRect(x + .5, y + .5, Math.max(0, w - 1), Math.max(0, h - 1));
      const padding = Math.min(10, w / 5, h / 5), fontSize = Math.max(8, Math.min(22, h * .2, size.width / 36));
      ctx.save(); ctx.beginPath(); ctx.rect(x + padding, y + padding, Math.max(1, w - padding * 2), Math.max(1, h - padding * 2)); ctx.clip();
      ctx.font = `${fontSize}px Arial, Helvetica, sans-serif`; ctx.textBaseline = 'top'; ctx.fillStyle = '#26313a';
      ctx.fillText(box.name, x + padding, y + padding, Math.max(1, w - padding * 2)); ctx.restore();
    });
    return size;
  }

  function init({ getContext, onReference, onRemoveReference }) {
    const document = root.document, panel = document?.getElementById('image-layout-guide');
    if (!panel) return { refresh() {}, destroy() {} };
    const $ = name => document.getElementById(`image-layout-${name}`);
    const listeners = [], urls = new Set();
    let project = null, selected = null, dirty = false, invalid = false, busy = false;
    let epoch = 0, contextKey = '', attached = false, attachedSignature = '', destroyed = false;
    const context = () => getContext() || {};
    const key = () => { const c = context(); return JSON.stringify([Boolean(c.locked), c.width, c.height]); };
    const blocked = () => destroyed || busy || Boolean(context().locked);
    const box = () => project?.boxes.find(item => item.id === selected);
    const sameFormat = () => project && project.width === context().width && project.height === context().height;
    const signature = () => project ? stringify(project) : '';
    function hasReference() { return typeof context().guideAttached === 'boolean' ? context().guideAttached : attached; }
    function available() { const count = Number(context().referenceCount || 0); return Number.isInteger(count) && count >= 0 && count - (hasReference() ? 1 : 0) < 2; }
    function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
    function listen(element, event, handler) { element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler)); }
    function controls() {
      const block = blocked();
      for (const name of ['format', 'new', 'file']) $(name).disabled = block;
      $('add').disabled = block || !project || project.boxes.length >= MAX_BOXES || invalid;
      $('zone').disabled = block || !project?.boxes.length;
      $('fields').disabled = block || !box();
      $('delete').disabled = block || !box();
      for (const name of ['png', 'json']) $(name).disabled = block || !project || invalid;
      $('attach').disabled = block || !project?.boxes.length || invalid || !sameFormat() || !available() || typeof onReference !== 'function';
      $('remove-reference').hidden = !hasReference(); $('remove-reference').disabled = block || typeof onRemoveReference !== 'function';
      $('workspace').hidden = !project;
      $('format-label').textContent = project ? `Esquisse : ${project.width} × ${project.height} · aperçu ${renderSize(project).width} × ${renderSize(project).height} pixels` : 'Utilise le format courant pour commencer.';
      if (!busy) {
        $('status').textContent = context().locked ? 'L’esquisse attend la fin de l’opération en cours.' : invalid ? 'Corrige les champs avant d’exporter ou de joindre l’esquisse.' : hasReference() ?
          attachedSignature && signature() !== attachedSignature ? 'L’esquisse jointe est une version précédente. Joins cette version pour la mettre à jour.' : 'Une esquisse est jointe aux références. La génération démarre avec le bouton de création.' :
          project && !sameFormat() ? 'Le format demandé a changé. Utilise le format courant avant de joindre cette esquisse.' : 'Guide visuel de composition : le modèle peut modifier les zones et leurs noms.';
      }
    }
    function paint() { if (project) draw($('canvas'), project, selected); }
    function list() {
      $('zone').replaceChildren();
      project?.boxes.forEach((item, index) => { const option = document.createElement('option'); option.value = item.id; option.textContent = `${index + 1} · ${item.name}`; $('zone').append(option); });
      if (selected) $('zone').value = selected;
    }
    function renderFields() {
      const item = box(); invalid = false;
      $('name').value = item?.name || ''; $('color').value = item?.color || PALETTE[0];
      for (const name of ['x', 'y', 'width', 'height']) $(name).value = item ? Math.round(item[name] * 10000) / 100 : '';
      controls();
    }
    function applyFields() {
      if (blocked() || !box()) return;
      try {
        const next = { ...box(), name: $('name').value, color: $('color').value };
        for (const name of ['x', 'y', 'width', 'height']) {
          if (!$(name).value || !$(name).checkValidity()) fail('Le placement et les dimensions doivent respecter les limites indiquées.');
          next[name] = Number($(name).value) / 100;
        }
        project = validate({ ...project, boxes: project.boxes.map(item => item.id === selected ? next : item) });
        invalid = false; dirty = true; error(); list(); paint();
      } catch (err) { invalid = true; dirty = true; error(err.message); }
      controls();
    }
    function replaceAllowed() { return !dirty || root.confirm('Remplacer cette esquisse ? Enregistre le projet JSON pour conserver les modifications.'); }
    function useFormat(clear = false) {
      if (blocked() || (clear && !replaceAllowed())) return;
      if (!clear && invalid && !root.confirm('Abandonner la saisie invalide de cette zone et utiliser le format courant ?')) return;
      try {
        const c = context(), next = create(c.width, c.height);
        if (!clear && project) next.boxes = project.boxes;
        project = validate(next); selected = project.boxes[0]?.id || null; dirty = true; error();
        panel.open = true; list(); renderFields(); paint();
      } catch (err) { error(err.message); }
    }
    function add() {
      if (blocked() || invalid || !project || project.boxes.length >= MAX_BOXES) return;
      let n = 1; while (project.boxes.some(item => item.id === `zone-${n}`)) n++;
      const item = { id: `zone-${n}`, name: `Zone ${n}`, x: .1, y: .1, width: .3, height: .25, color: PALETTE[(n - 1) % PALETTE.length] };
      project = validate({ ...project, boxes: [...project.boxes, item] }); selected = item.id; dirty = true; error(); list(); renderFields(); paint(); $('name').focus();
    }
    function remove() {
      if (blocked() || !box()) return;
      project = validate({ ...project, boxes: project.boxes.filter(item => item.id !== selected) }); selected = project.boxes[0]?.id || null;
      dirty = true; error(); list(); renderFields(); paint();
    }
    function start(message) { busy = true; const token = ++epoch, initialKey = key(); error(); controls(); $('status').textContent = message; return { token, initialKey }; }
    function stale(run) { return destroyed || run.token !== epoch || run.initialKey !== key(); }
    function finish(run) { if (!stale(run)) { busy = false; controls(); } }
    async function importFile() {
      const file = $('file').files?.[0]; $('file').value = '';
      if (blocked() || !file || !replaceAllowed()) return;
      const run = start('Lecture du projet d’esquisse…');
      try {
        if (file.size > MAX_JSON_BYTES) fail('Le projet JSON est trop volumineux.');
        const next = parse(await file.text()); if (stale(run)) return;
        project = next; selected = next.boxes[0]?.id || null; dirty = false; invalid = false;
        panel.open = true; list(); renderFields(); paint();
      } catch (err) { if (!stale(run)) error(err.message); } finally { finish(run); }
    }
    function download(blob, extension) {
      const url = root.URL.createObjectURL(blob); urls.add(url);
      const link = document.createElement('a'); link.href = url; link.download = `agentx-esquisse.${extension}`;
      document.body.append(link); link.click(); link.remove();
      root.setTimeout(() => { root.URL.revokeObjectURL(url); urls.delete(url); }, 1000);
    }
    async function png() {
      const canvas = document.createElement('canvas'); draw(canvas, project);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob || blob.type !== 'image/png' || blob.size > MAX_BASE64_BYTES * 3 / 4) fail('L’esquisse PNG est trop volumineuse pour une référence.');
      return blob;
    }
    async function exportFile(format) {
      if (blocked() || !project || invalid) return;
      const run = start('Préparation du téléchargement…');
      try {
        if (format === 'json') { download(new Blob([stringify(project)], { type: 'application/json' }), 'json'); dirty = false; }
        else { const blob = await png(); if (!stale(run)) download(blob, 'png'); }
      } catch (err) { if (!stale(run)) error(err.message); } finally { finish(run); }
    }
    function dataUrl(blob) {
      return new Promise((resolve, reject) => { const reader = new root.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('L’esquisse ne peut pas être lue.')); reader.readAsDataURL(blob); });
    }
    async function attach() {
      if (blocked() || invalid || !project?.boxes.length || !sameFormat() || !available() || typeof onReference !== 'function') return;
      const run = start('Préparation de l’esquisse de référence…'), saved = signature();
      try {
        const encoded = await dataUrl(await png()); if (stale(run)) return;
        const prefix = 'data:image/png;base64,', base64 = encoded.startsWith(prefix) ? encoded.slice(prefix.length) : '';
        if (!base64 || base64.length > MAX_BASE64_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail('L’esquisse PNG dépasse la limite de référence.');
        if (context().locked || !sameFormat() || !available()) fail('Les références ou le format ont changé. Vérifie la demande avant de joindre l’esquisse.');
        const accepted = await onReference({ base64, mimeType: 'image/png', label: `Esquisse de composition · ${project.width} × ${project.height}` });
        if (accepted === false) fail('L’esquisse ne peut pas être jointe : deux références au maximum, parent compris.');
        if (!stale(run)) { attached = true; attachedSignature = saved; }
      } catch (err) { if (!stale(run)) error(err.message); } finally { finish(run); }
    }
    async function removeReference() {
      if (blocked() || !hasReference() || typeof onRemoveReference !== 'function') return;
      const run = start('Retrait de l’esquisse jointe…');
      try { await onRemoveReference(); if (!stale(run)) { attached = false; attachedSignature = ''; } }
      catch (err) { if (!stale(run)) error(err.message); } finally { finish(run); }
    }
    function refresh() {
      const next = key(); if (next !== contextKey) { contextKey = next; epoch++; busy = false; }
      if (context().guideAttached === false) { attached = false; attachedSignature = ''; }
      controls();
    }
    listen($('format'), 'click', () => useFormat()); listen($('new'), 'click', () => useFormat(true));
    listen($('add'), 'click', add); listen($('delete'), 'click', remove); listen($('file'), 'change', importFile);
    listen($('zone'), 'change', () => {
      if (blocked()) return;
      if (invalid && !root.confirm('Abandonner la saisie invalide de cette zone ?')) { $('zone').value = selected; return; }
      selected = $('zone').value; error(); renderFields(); paint();
    });
    for (const name of ['name', 'color', 'x', 'y', 'width', 'height']) listen($(name), 'input', applyFields);
    listen($('canvas'), 'click', event => {
      if (blocked() || !box()) return;
      const bounds = $('canvas').getBoundingClientRect(), item = box();
      $('x').value = Math.round(Math.max(0, Math.min(1 - item.width, (event.clientX - bounds.left) / bounds.width)) * 10000) / 100;
      $('y').value = Math.round(Math.max(0, Math.min(1 - item.height, (event.clientY - bounds.top) / bounds.height)) * 10000) / 100;
      applyFields();
    });
    listen($('canvas'), 'keydown', event => {
      if (blocked() || !box()) return;
      const deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, delta = deltas[event.key];
      if (!delta) return; event.preventDefault(); const item = box(), step = event.shiftKey ? .01 : .001;
      $('x').value = Math.round(Math.max(0, Math.min(1 - item.width, item.x + delta[0] * step)) * 10000) / 100;
      $('y').value = Math.round(Math.max(0, Math.min(1 - item.height, item.y + delta[1] * step)) * 10000) / 100;
      applyFields();
    });
    listen($('png'), 'click', () => exportFile('png')); listen($('json'), 'click', () => exportFile('json'));
    listen($('attach'), 'click', attach); listen($('remove-reference'), 'click', removeReference);
    listen(root, 'beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
    refresh();
    return { refresh, destroy() { destroyed = true; epoch++; listeners.forEach(removeListener => removeListener()); urls.forEach(url => root.URL.revokeObjectURL(url)); urls.clear(); } };
  }
  return { SCHEMA, MAX_JSON_BYTES, MAX_BOXES, MAX_NAME, MAX_BASE64_BYTES, MAX_RENDER_EDGE, PALETTE, create, validate, stringify, parse, renderSize, draw, init };
});
