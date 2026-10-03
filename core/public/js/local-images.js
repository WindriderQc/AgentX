'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let config, operation, pollTimer, request;
  const statuses = { accepted: 'Demande enregistrée.', reserving: 'Préparation du GPU. Nestor peut attendre pendant ce temps.',
    generating: 'Ton image prend forme…', archiving: 'Conservation de l’original…', restoring: 'Restauration des services habituels…',
    completed: 'Image prête et conservée dans les photos.', cancelled: 'Génération annulée.', failed: 'La génération a échoué.',
    unknown: 'État incertain. Une récupération est nécessaire ; cette image ne sera pas relancée automatiquement.',
    archive_failed: 'Image calculée ; son archivage doit être repris.' };
  async function api(route, body) {
    const r = await fetch(`/api/images${route}`, { method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await r.json();
    if (!r.ok || !result.ok) throw new Error(result.message || 'Service indisponible.');
    return result;
  }
  function show(op) {
    operation = op;
    const busy = ['accepted', 'reserving', 'generating', 'archiving', 'restoring'].includes(op.state);
    $('image-create').disabled = busy;
    $('image-cancel').hidden = !busy;
    $('image-recover').hidden = !['unknown', 'archive_failed'].includes(op.state);
    $('image-status').textContent = `${statuses[op.state] || op.state}${op.error ? ' ' + op.error : ''}${op.timings?.totalMs ? ` (${Math.round(op.timings.totalMs / 1000)} s)` : ''}`;
    if (op.artifact) {
      $('image-output').src = op.artifact.url; $('image-output').hidden = false;
      $('image-placeholder').hidden = true; $('image-download').href = op.artifact.url; $('image-download').hidden = false;
    }
    clearTimeout(pollTimer);
    if (busy) pollTimer = setTimeout(poll, 1500); else loadHistory();
  }
  async function poll() {
    try { show((await api(`/operations/${operation.id}`)).operation); }
    catch { $('image-status').textContent = 'Connexion interrompue. La demande enregistrée continue ; vérification en cours…'; pollTimer = setTimeout(poll, 5000); }
  }
  async function loadHistory() {
    try {
      const result = await api('/operations');
      $('image-gallery').replaceChildren();
      for (const op of result.operations.filter(x => x.artifact)) {
        const button = document.createElement('button'), img = document.createElement('img'), caption = document.createElement('p');
        img.src = op.artifact.url; img.alt = 'Création locale'; img.loading = 'lazy';
        caption.textContent = `${op.label || op.profile} · ${new Date(op.createdAt).toLocaleDateString('fr-CA')}`;
        button.append(img, caption); button.addEventListener('click', () => show(op)); $('image-gallery').append(button);
      }
      return result.operations;
    } catch { return []; }
  }
  async function fileBytes(file) {
    if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choisis une image PNG ou JPEG.');
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const ratio = Math.min(1, 1536 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(img.width * ratio); canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    } finally { URL.revokeObjectURL(url); }
  }
  $('image-references').addEventListener('change', async () => {
    $('image-reference-previews').replaceChildren();
    for (const file of [...$('image-references').files].slice(0, 2)) {
      const img = document.createElement('img'); img.src = URL.createObjectURL(file); img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src); $('image-reference-previews').append(img);
    }
  });
  $('image-form').addEventListener('submit', async event => {
    event.preventDefault(); $('image-create').disabled = true;
    try {
      const files = [...$('image-references').files]; if (files.length > 2) throw new Error('Deux références au maximum.');
      const [width, height] = $('image-size').value.split(',').map(Number);
      const payload = { prompt: $('image-prompt').value, profile: $('image-profile').value, width, height,
        references: await Promise.all(files.map(fileBytes)) };
      const signature = JSON.stringify(payload);
      // A network retry retains its identity. An explicit next creation gets a new identity.
      if (!request || request.signature !== signature) request = { signature, payload: { ...payload, actionKey: crypto.randomUUID() } };
      const result = await api('/operations', request.payload);
      localStorage.setItem('agentx-image-operation', result.operation.id); request = null; show(result.operation);
    } catch (error) { $('image-status').textContent = error.message; $('image-create').disabled = false; }
  });
  $('image-cancel').addEventListener('click', async () => {
    try { show((await api(`/operations/${operation.id}/cancel`, {})).operation); }
    catch (error) { $('image-status').textContent = error.message; }
  });
  $('image-recover').addEventListener('click', async () => {
    $('image-recover').disabled = true;
    try { show((await api(`/operations/${operation.id}/${operation.state === 'archive_failed' ? 'archive' : 'recover'}`, {})).operation); }
    catch (error) { $('image-status').textContent = error.message; }
    finally { $('image-recover').disabled = false; }
  });
  $('image-profile').addEventListener('change', () => {
    const profile = config.profiles.find(p => p.id === $('image-profile').value);
    for (const option of $('image-size').options) {
      const [w, h] = option.value.split(',').map(Number); option.disabled = w * h > profile.maxPixels;
    }
    if ($('image-size').selectedOptions[0].disabled) $('image-size').value = '1024,1024';
  });
  (async () => {
    try {
      config = await api('/status');
      for (const p of config.profiles) { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = p.label; $('image-profile').append(opt); }
      $('image-profile').value = config.defaultProfile;
      if (config.profiles.length) $('image-profile').dispatchEvent(new Event('change'));
      $('image-create').disabled = !config.configured;
      $('image-status').textContent = config.configured ? 'Prêt. Une seule création à la fois.' : 'Le service d’images locales n’est pas encore configuré.';
      const ops = await loadHistory();
      const current = ops.find(x => ['accepted', 'reserving', 'generating', 'archiving', 'restoring'].includes(x.state));
      const lastId = new URLSearchParams(location.search).get('operation') || localStorage.getItem('agentx-image-operation');
      if (current) show(current);
      else if (lastId) show((await api(`/operations/${encodeURIComponent(lastId)}`)).operation);
      else if (ops[0]?.artifact) show(ops[0]);
    } catch (error) { $('image-status').textContent = error.message; }
  })();
})();
