/* global ImageTextProject */
(function (root) {
  'use strict';

  function init({ getContext, fetchImpl = root.fetch.bind(root) }) {
    const panel = document.getElementById('image-text-editor');
    if (!panel) return { refresh() {}, destroy() {} };
    const engine = root.ImageTextProject;
    const $ = name => document.getElementById(`image-text-${name}`);
    const events = [], urls = new Set(), invalidFields = new Set();
    let project = null, image = null, selected = null, dirty = false, imported = false;
    let busy = false, epoch = 0, contextKey = '', request = null, destroyed = false;

    function listen(element, name, handler) {
      element.addEventListener(name, handler);
      events.push(() => element.removeEventListener(name, handler));
    }

    function context() { return getContext() || {}; }
    function key() {
      const { operation: op, locked } = context();
      return JSON.stringify([op?.id, op?.artifact?.sha256, op?.artifact?.width,
        op?.artifact?.height, op?.state, op?.runtimeRestored, Boolean(locked)]);
    }
    function readyOperation() {
      const { operation: op, locked } = context();
      return !locked && op?.state === 'completed' && op.runtimeRestored === true &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(op.id || '') && /^[a-f0-9]{64}$/i.test(op.artifact?.sha256 || '') &&
        Number.isInteger(op.artifact.width) && Number.isInteger(op.artifact.height) ? op : null;
    }
    function currentLabel() { return project?.labels.find(label => label.id === selected); }
    function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
    function frenchError(err) {
      const message = err.message || '';
      if (message.includes('SHA-256')) return 'L’empreinte de l’image originale ne correspond pas au projet.';
      if (/Source (dimensions|width|height|exceeds)/.test(message)) return 'Les dimensions de l’image sont invalides ou dépassent les limites de l’éditeur.';
      if (message.startsWith('Label text exceeds')) return `Le texte est limité à ${engine.MAX_TEXT_LENGTH} caractères.`;
      if (message.startsWith('Label text contains')) return 'Ce texte contient un caractère incompatible avec le SVG.';
      if (/^(L’|Le |Les |Cette |Ce )/.test(message)) return message;
      return 'Le projet ou l’image qu’il contient n’est pas valide. Vérifie le fichier et les libellés.';
    }
    function status(message) { $('status').textContent = message; }
    function describe() {
      if (!project) return 'Choisis une image archivée ou rouvre un projet.';
      const op = context().operation;
      const same = op?.id === project.source.operationId &&
        op.artifact?.sha256?.toLowerCase() === project.source.sha256;
      const origin = imported ? 'Projet rouvert, indépendant de la sélection.' : same ?
        'Projet de l’image sélectionnée.' : 'Projet conservé ; la sélection de la bibliothèque a changé.';
      return `${origin}${dirty ? ' Modifications à enregistrer en JSON.' : ''}`;
    }
    function controls() {
      panel.hidden = !readyOperation() && !project && !panel.open;
      $('prepare').disabled = busy || !readyOperation();
      $('file').disabled = busy;
      $('workspace').hidden = !project;
      $('add').disabled = busy || !project || project.labels.length >= engine.MAX_LABELS;
      $('label').disabled = busy || !project?.labels.length;
      $('fields').disabled = busy || !currentLabel();
      $('background').disabled = busy || !currentLabel() || $('transparent').checked;
      for (const name of ['png', 'svg', 'json']) $(name).disabled = busy || !project || invalidFields.size > 0;
      if (!busy) status(describe());
    }
    function paint() {
      if (!project || !image) return;
      const canvas = $('canvas'), ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('L’aperçu ne peut pas être affiché dans ce navigateur.');
      if (canvas.width !== project.source.width) canvas.width = project.source.width;
      if (canvas.height !== project.source.height) canvas.height = project.source.height;
      engine.draw(ctx, project, image);
      const label = currentLabel();
      if (label) {
        const x = label.x * canvas.width, y = label.y * canvas.height;
        const radius = Math.max(3, canvas.width / 250);
        ctx.save(); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = '#70c8ff'; ctx.lineWidth = Math.max(2, canvas.width / 600);
        ctx.stroke(); ctx.restore();
      }
    }
    function shortText(label, index) { return `${index + 1} · ${label.text.replace(/\s+/g, ' ').slice(0, 55) || 'Texte vide'}`; }
    function renderList() {
      $('label').replaceChildren();
      project?.labels.forEach((label, index) => {
        const option = document.createElement('option');
        option.value = label.id; option.textContent = shortText(label, index);
        $('label').append(option);
      });
      if (selected) $('label').value = selected;
    }
    function renderFields() {
      const label = currentLabel();
      invalidFields.clear();
      $('content').value = label?.text || '';
      $('count').textContent = `${Array.from($('content').value).length} / ${engine.MAX_TEXT_LENGTH} caractères`;
      $('x').value = label ? Math.round(label.x * 10000) / 100 : '';
      $('y').value = label ? Math.round(label.y * 10000) / 100 : '';
      $('size').value = label?.fontSize || '';
      $('align').value = label?.align || 'left';
      $('color').value = fullColor(label?.color || '#ffffff');
      $('background').value = fullColor(label?.background || '#162231');
      $('transparent').checked = !label?.background;
      controls();
    }
    function fullColor(value) { return value.length === 4 ? `#${value.slice(1).split('').map(x => x + x).join('')}` : value; }
    function changeLabel(changes, fields = false) {
      if (busy || !currentLabel()) return;
      const labels = project.labels.map(label => label.id === selected ? { ...label, ...changes } : label);
      try {
        project = engine.validate({ ...project, labels }); dirty = true;
        Object.keys(changes).forEach(name => invalidFields.delete(name));
        if (!invalidFields.size) error();
        const index = project.labels.findIndex(label => label.id === selected);
        $('label').options[index].textContent = shortText(currentLabel(), index);
        if (fields) renderFields();
        paint(); controls();
      } catch (err) {
        Object.keys(changes).forEach(name => invalidFields.add(name)); dirty = true;
        error(frenchError(err)); controls();
      }
    }
    function replaceAllowed() {
      return !dirty || root.confirm('Remplacer le projet actuel ? Les modifications non enregistrées en JSON seront perdues.');
    }
    function start(message) {
      request?.abort(); request = new AbortController();
      busy = true; const token = ++epoch; error(); controls(); status(message);
      return { token, signal: request.signal };
    }
    function stale(token) { return destroyed || token !== epoch; }
    function finish(token) { if (!stale(token)) { busy = false; request = null; controls(); } }
    function fail(err, token) { if (!stale(token) && err.name !== 'AbortError') error(frenchError(err)); }
    function toDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('L’image ne peut pas être lue.'));
        reader.readAsDataURL(blob);
      });
    }
    function decode(dataUrl) {
      return new Promise((resolve, reject) => {
        const result = new Image();
        result.onload = () => resolve(result);
        result.onerror = () => reject(new Error('L’image du projet ne peut pas être décodée.'));
        result.src = dataUrl;
      });
    }
    async function install(candidate, token, fromImport) {
      await engine.verifySource(candidate);
      if (stale(token)) return;
      const decoded = await decode(candidate.source.dataUrl);
      if (stale(token)) return;
      if (decoded.naturalWidth !== candidate.source.width || decoded.naturalHeight !== candidate.source.height) {
        throw new Error('Les dimensions de l’image ne correspondent pas au projet.');
      }
      project = candidate; image = decoded; dirty = false; imported = fromImport;
      selected = project.labels[0]?.id || null;
      $('source').textContent = `Original : ${project.source.width} × ${project.source.height} pixels · opération ${project.source.operationId}`;
      panel.open = true; renderList(); renderFields(); paint();
    }
    async function prepare() {
      const op = readyOperation();
      if (busy || !op || !replaceAllowed()) return;
      const { token, signal } = start('Lecture et vérification de l’original archivé…');
      try {
        const response = await fetchImpl(`/api/images/operations/${op.id}/image`, { signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('L’original archivé ne peut pas être chargé.');
        const advertised = Number(response.headers.get('content-length'));
        const maxBytes = Math.floor(engine.MAX_JSON_BYTES * .7);
        if (advertised > maxBytes) throw new Error('Cette image est trop volumineuse pour le projet éditable.');
        const blob = await response.blob();
        if (stale(token)) return;
        if (blob.size > maxBytes) throw new Error('Cette image est trop volumineuse pour le projet éditable.');
        const dataUrl = await toDataUrl(blob);
        if (stale(token)) return;
        const candidate = engine.create({ operationId: op.id, sha256: op.artifact.sha256.toLowerCase(),
          width: op.artifact.width, height: op.artifact.height, dataUrl });
        await install(candidate, token, false);
      } catch (err) { fail(err, token); } finally { finish(token); }
    }
    async function importFile() {
      const file = $('file').files?.[0]; $('file').value = '';
      if (busy || !file || !replaceAllowed()) return;
      const { token } = start('Vérification du projet et de son image originale…');
      try {
        if (file.size > engine.MAX_JSON_BYTES) throw new Error('Le projet JSON dépasse la taille autorisée.');
        const json = await file.text();
        if (stale(token)) return;
        const candidate = engine.parse(json);
        await install(candidate, token, true);
      } catch (err) { fail(err, token); } finally { finish(token); }
    }
    function download(blob, extension) {
      const url = URL.createObjectURL(blob); urls.add(url);
      const link = document.createElement('a');
      link.href = url; link.download = `agentx-textes-${project.source.operationId}.${extension}`;
      document.body.append(link); link.click(); link.remove();
      root.setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
    }
    async function exportFile(format) {
      if (busy || !project || invalidFields.size) return;
      const { token } = start('Préparation du téléchargement…');
      try {
        if (format === 'png') {
          const canvas = document.createElement('canvas');
          canvas.width = project.source.width; canvas.height = project.source.height;
          engine.draw(canvas.getContext('2d'), project, image);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (stale(token)) return;
          if (!blob) throw new Error('Le PNG ne peut pas être exporté.');
          download(blob, 'png');
        } else if (format === 'svg') download(new Blob([engine.svg(project)], { type: 'image/svg+xml' }), 'svg');
        else {
          download(new Blob([engine.stringify(project)], { type: 'application/json' }), 'json'); dirty = false;
        }
      } catch (err) { fail(err, token); } finally { finish(token); }
    }
    function add() {
      if (busy || !project || project.labels.length >= engine.MAX_LABELS) return;
      let index = 1; while (project.labels.some(label => label.id === `label-${index}`)) index++;
      const label = { id: `label-${index}`, text: 'Nouveau libellé', x: .1, y: .1,
        fontSize: Math.min(engine.MAX_FONT_SIZE, Math.max(16, Math.round(project.source.width / 35))),
        color: '#ffffff', background: '#162231', align: 'left' };
      project = engine.validate({ ...project, labels: [...project.labels, label] });
      selected = label.id; dirty = true; error(); renderList(); renderFields(); paint(); $('content').focus();
    }
    function remove() {
      if (busy || !currentLabel()) return;
      const index = project.labels.findIndex(label => label.id === selected);
      project = engine.validate({ ...project, labels: project.labels.filter(label => label.id !== selected) });
      selected = project.labels[Math.min(index, project.labels.length - 1)]?.id || null;
      dirty = true; error(); renderList(); renderFields(); paint();
    }
    function refresh() {
      const next = key();
      if (next !== contextKey) {
        contextKey = next; epoch++; request?.abort(); request = null; busy = false;
      }
      controls();
    }

    if (!engine) {
      error('L’éditeur de textes ne peut pas être chargé. Recharge la page.');
      return { refresh() {}, destroy() {} };
    }
    listen($('prepare'), 'click', prepare); listen($('file'), 'change', importFile);
    listen($('add'), 'click', add); listen($('delete'), 'click', remove);
    listen($('label'), 'change', () => { selected = $('label').value; error(); renderFields(); paint(); });
    listen($('content'), 'input', () => {
      $('count').textContent = `${Array.from($('content').value).length} / ${engine.MAX_TEXT_LENGTH} caractères`;
      changeLabel({ text: $('content').value });
    });
    for (const name of ['x', 'y', 'size']) listen($(name), 'input', () => {
      if (!$(name).value || !$(name).checkValidity()) {
        invalidFields.add(name === 'size' ? 'fontSize' : name); dirty = true;
        error('Ce placement ou cette taille dépasse les limites indiquées.'); controls(); return;
      }
      changeLabel(name === 'size' ? { fontSize: Number($(name).value) } : { [name]: Number($(name).value) / 100 });
    });
    listen($('align'), 'change', () => changeLabel({ align: $('align').value }));
    listen($('color'), 'input', () => changeLabel({ color: $('color').value }));
    listen($('background'), 'input', () => changeLabel({ background: $('background').value }));
    listen($('transparent'), 'change', () => changeLabel({ background: $('transparent').checked ? null : $('background').value }));
    listen($('canvas'), 'click', event => {
      if (busy || invalidFields.size || !currentLabel()) return;
      const bounds = $('canvas').getBoundingClientRect();
      changeLabel({ x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) }, true);
    });
    listen($('canvas'), 'keydown', event => {
      const label = currentLabel(), directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (busy || invalidFields.size || !label || !directions[event.key]) return;
      event.preventDefault(); const [dx, dy] = directions[event.key], step = event.shiftKey ? 10 : 1;
      changeLabel({ x: Math.max(0, Math.min(1, label.x + dx * step / project.source.width)),
        y: Math.max(0, Math.min(1, label.y + dy * step / project.source.height)) }, true);
    });
    for (const format of ['png', 'svg', 'json']) listen($(format), 'click', () => exportFile(format));
    listen(root, 'beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
    refresh();
    return { refresh, open() { panel.hidden = false; panel.open = true; $('file').focus(); }, destroy() {
      destroyed = true; epoch++; request?.abort(); events.forEach(removeListener => removeListener());
      urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); image = null; project = null;
    } };
  }

  root.ImageTextEditor = { init };
})(window);
