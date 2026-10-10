'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const ACTIVE = ['queued', 'accepted', 'reserving', 'generating', 'archiving', 'restoring'];
  const statuses = { queued: 'Image en file. Elle démarrera lorsque son créneau sera libre.', accepted: 'Demande enregistrée.', reserving: 'Préparation du GPU et des services qui le partagent.',
    generating: 'Génération en cours…', archiving: 'Archivage de l’original…', restoring: 'Restitution des ressources aux services habituels…',
    completed: 'Image prête, original archivé et ressources restituées.', cancelled: 'Génération annulée.', failed: 'La génération a échoué.',
    unknown: 'État incertain : récupère cette opération avant une nouvelle demande.', archive_failed: 'Image calculée ; son archivage doit être repris.' };
  let config, workshop, operation, origin = 'generation', pollTimer, request, selectedReference = null;
  let draftEpoch = 0, referenceEpoch = 0, pendingSubmit = false, history = [], shownDetails = null;
  const detailsCache = new Map();
  let exportEpoch = 0;
  let draftExpert = null;
  const mp = pixels => `${new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 }).format(pixels / 1e6)} MP`;
  const dimensions = (w, h) => `${w} × ${h} px · ${mp(w * h)}`;
  const duration = ms => { const seconds = Math.round(ms / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`; };
  const locked = () => pendingSubmit || ACTIVE.includes(operation?.state) || operation?.state === 'unknown';
  const textEditor = globalThis.ImageTextEditor?.init({ getContext: () => ({ operation, locked: locked() }) });
  const currentRecipe = () => workshop?.profiles.find(p => p.id === $('image-profile').value) || config?.profiles.find(p => p.id === $('image-profile').value);
  const genericSizes = [...$('image-size').options].map(option => [option.value, option.textContent]);
  const shape = (w, h) => w === h ? 'Carré' : w > h ? 'Paysage' : 'Portrait';
  const referenceCount = () => (selectedReference ? 1 : 0) + $('image-references').files.length;
  const expert = globalThis.AgentXImageExpert?.mount({
    getContext: () => {
      const [width, height] = $('image-size').value.split(',').map(Number);
      return { ready: !!config?.configured, locked: locked(), prompt: $('image-prompt').value,
        profile: $('image-profile').value, width, height, referenceCount: referenceCount(),
        seed: $('image-seed').value, referenceEpoch, worker: workshop?.worker || null };
    },
    apply: (prompt, source) => {
      draftExpert = source;
      ++draftEpoch; $('image-prompt').value = prompt; $('image-draft-source').hidden = true;
      $('image-status').textContent = 'Brief préparé avec imageX · Hermes. Vérifie les références et lance la création.';
      $('image-prompt').focus();
    }
  });
  const starters = globalThis.AgentXImageStarters?.mount({
    getContext: () => ({ locked: locked() || !config?.configured, referenceCount: referenceCount(),
      profiles: workshop?.profiles || [], hasPrompt: !!$('image-prompt').value.trim() }),
    apply: prompt => {
      draftExpert = null;
      ++draftEpoch; $('image-prompt').value = prompt; $('image-draft-source').hidden = true;
      $('image-status').textContent = 'Canevas préparé. Remplace les passages entre crochets et vérifie les références avant de créer.';
      $('image-prompt').focus();
    }
  });
  function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
  function facts(target, entries) {
    target.replaceChildren();
    for (const [label, value] of entries) { if (value === undefined || value === null || value === '') continue;
      const row = node('div'); row.append(node('dt', label), node('dd', String(value))); target.append(row); }
  }
  async function api(route, body) {
    const r = await fetch(`/api/images${route}`, { method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok || !result.ok) throw new Error(result.message || 'Service indisponible.'); return result;
  }
  function controls() {
    const block = locked();
    $('image-create').disabled = block || !config?.configured || referenceCount() > 2;
    $('image-new').disabled = block || !config; $('image-use-reference').disabled = block; $('image-reuse-brief').disabled = block;
    for (const button of $('image-gallery').querySelectorAll('button')) button.disabled = block;
    starters?.refresh();
    expert?.refresh();
    textEditor?.refresh();
  }
  function updateFormMode() {
    const count = referenceCount();
    $('image-compose-title').textContent = count ? 'Retouche avec référence' : 'Nouvelle création';
    $('image-create-label').textContent = count ? 'Appliquer la retouche' : 'Créer une nouvelle image';
    $('image-reference-help').textContent = count > 2 ? 'Deux références au maximum : retire une image avant l’envoi.'
      : count ? `${count} référence${count > 1 ? 's' : ''} jointe${count > 1 ? 's' : ''}. Décris les changements et les éléments à préserver. La retouche peut aussi modifier des zones non demandées.`
      : 'Sans référence jointe, le modèle crée une nouvelle composition.';
    const [w, h] = $('image-size').value.split(',').map(Number);
    $('image-format-help').textContent = count && currentRecipe()?.editingFraming === 'first-reference'
      ? `Qwen reprend le cadrage de la première référence, avec une surface cible de ${mp(w * h)}. Les dimensions réelles seront indiquées au résultat.`
      : `Format demandé : ${dimensions(w, h)}. Les dimensions réelles apparaissent sous l’image produite.`;
    controls();
  }
  function renderRecipe() {
    const p = currentRecipe(); if (!p) return;
    $('image-recipe-summary').replaceChildren();
    const heading = node('div', undefined, 'recipe-top'); heading.append(node('strong', p.label), node('span', p.steps ? `${p.steps} étapes` : 'Étapes non renseignées', 'recipe-pill'));
    const summary = node('p', p.description || (p.steps <= 8 ? 'Recette à peu d’étapes pour explorer une idée ou préparer une retouche.' : 'Recette avec davantage d’étapes pour travailler une proposition. La cohérence des objets reste à examiner.'));
    const limits = node('div', undefined, 'recipe-limits');
    limits.append(node('span', `Surface maximale : ${mp(p.maxPixels)}`), node('span', p.precision || 'Précision non renseignée'));
    $('image-recipe-summary').append(heading, summary, limits);
    facts($('image-components'), [['Diffusion', p.diffusion], ['Encodeur', p.encoder], ['VAE', p.vae]]);
    // A model with published sizes offers exactly those; the others keep the generic list.
    const previous = $('image-size').value, sizes = p.sizes?.length
      ? p.sizes.map(s => [`${s.width},${s.height}`, `${shape(s.width, s.height)} ${s.ratio} · ${s.width} × ${s.height} · ${mp(s.width * s.height)}`]) : genericSizes;
    $('image-size').replaceChildren(...sizes.map(([value, label]) => { const option = node('option', label); option.value = value;
      const [w, h] = value.split(',').map(Number); option.disabled = w * h > p.maxPixels; return option; }));
    const enabled = [...$('image-size').options].filter(option => !option.disabled);
    $('image-size').value = (enabled.find(option => option.value === previous) || enabled[0])?.value || '';
    updateFormMode();
  }
  function renderResultFacts() {
    if (!operation) return;
    const d = shownDetails, a = operation.artifact;
    facts($('image-result-facts'), [['Modèle / recette', d?.recipe.label || operation.label || operation.profile],
      ['Dimensions réelles', a ? dimensions(a.width, a.height) : null], ['Étapes', d?.recipe.steps],
      ['Hôte enregistré', d?.worker?.label], ['GPU associé actuellement', d?.worker?.gpu],
      ['Durée totale de l’opération', operation.timings?.totalMs != null ? duration(operation.timings.totalMs) : null]]);
    $('image-result-facts').hidden = !a;
    if (!d) return;
    $('image-saved-prompt').textContent = d.request.prompt || 'Brief non disponible.';
    facts($('image-saved-recipe'), [['Format demandé', d.request.width && d.request.height ? dimensions(d.request.width, d.request.height) : null],
      ['Recette enregistrée', d.recipe.declaredIdentity?.id], ['Version enregistrée', d.recipe.declaredIdentity?.version],
      ['Graphe préparé (SHA-256)', d.execution?.graphSha256],
      ['Graine', d.request.seed], ['Diffusion', d.recipe.diffusion], ['Encodeur', d.recipe.encoder], ['VAE', d.recipe.vae],
      ['Précision', d.recipe.precision], ['Archive', d.archivePath]]);
    const parent = d.lineage?.parent;
    if (parent) {
      const row = node('div'), value = node('dd'), link = node('a', 'Consulter l’original choisi'), preview = node('img');
      link.href = `/images?operation=${encodeURIComponent(parent.operationId)}`;
      preview.src = `/api/images/operations/${encodeURIComponent(parent.operationId)}/image`;
      preview.alt = 'Original parent de cette retouche'; preview.loading = 'lazy'; preview.width = 96;
      value.append(link, preview, node('span', dimensions(parent.width, parent.height)));
      row.append(node('dt', 'Image parent enregistrée'), value); $('image-saved-recipe').append(row);
    }
    $('image-result-details').hidden = false;
    if (d.expert) {
      const row = node('div'), value = node('dd'), link = node('a', 'Brief préparé avec imageX · Hermes');
      link.href = `/images?expertSession=${encodeURIComponent(d.expert.sessionId)}#imagex`;
      value.append(link, node('span', d.expert.promptEdited ? ' · prompt ajusté après la proposition' : ' · prompt proposé par Hermes'));
      row.append(node('dt', 'Collaboration'), value); $('image-saved-recipe').append(row);
    }
    $('image-result-note').textContent = 'La durée totale inclut la préparation, le calcul, l’archivage et la restitution ; ces temps ne sont pas détaillés séparément dans ce reçu. Le matériel affiché vient de la configuration actuelle associée à l’hôte enregistré.';
    $('image-result-note').hidden = false;
  }
  async function loadDetails(op) {
    const cached = detailsCache.get(op.id);
    if (cached?.stamp === op.updatedAt) return cached.data;
    const result = await api(`/operations/${encodeURIComponent(op.id)}/details`);
    detailsCache.set(op.id, { stamp: op.updatedAt, data: result.details }); return result.details;
  }
  function resetExport(ready) {
    ++exportEpoch;
    $('image-export').hidden = !ready; $('image-export').open = false;
    $('image-export-prepare').disabled = false;
    $('image-export-status').textContent = ''; $('image-export-links').replaceChildren();
  }
  async function prepareExport() {
    const op = operation, epoch = ++exportEpoch;
    if (op?.state !== 'completed' || !op.runtimeRestored) return;
    $('image-export-prepare').disabled = true; $('image-export-links').replaceChildren();
    $('image-export-status').textContent = 'Vérification des fichiers archivés…';
    try {
      const url = `/api/images/operations/${encodeURIComponent(op.id)}/export`;
      const response = await fetch(url, { method: 'GET' }), manifest = await response.json();
      if (!response.ok) throw new Error(manifest.message || 'Cet export est indisponible.');
      if (epoch !== exportEpoch || operation?.id !== op.id) return;
      const list = node('ul'), add = (label, href, filename) => {
        const row = node('li'), link = node('a', label); link.href = href; link.download = filename; row.append(link); list.append(row);
      };
      add('Manifeste de la recette', url, 'image-recipe.json');
      for (const part of manifest.parts) {
        if (!/^(graph\.json|output\.(png|jpg)|reference-[01]-(source\.(png|jpg)|worker\.png))$/.test(part.name)) throw new Error('Liste de fichiers invalide.');
        add(part.name, `${url}/parts/${encodeURIComponent(part.name)}`, part.name);
      }
      $('image-export-links').replaceChildren(list);
      $('image-export-status').textContent = 'Fichiers vérifiés. Télécharge le manifeste et les pièces que tu souhaites conserver.';
    } catch (error) { if (epoch === exportEpoch) $('image-export-status').textContent = error.message; }
    finally { if (epoch === exportEpoch) $('image-export-prepare').disabled = false; }
  }
  function show(op, source = origin) {
    operation = op; origin = source;
    const busy = ACTIVE.includes(op.state), ready = op.state === 'completed' && op.runtimeRestored === true && op.artifact;
    resetExport(ready);
    $('image-result-title').textContent = busy ? 'Ton image prend forme' : source === 'library' ? 'Image de la bibliothèque' : 'Résultat de la demande';
    $('image-result-origin').textContent = source === 'library' ? 'BIBLIOTHÈQUE' : source === 'continuation' ? 'DEPUIS LA CONVERSATION' : 'CETTE DEMANDE';
    $('image-result-origin').hidden = false;
    $('image-preview-help').textContent = source === 'library' ? 'Consultation d’une image conservée. Ton brief et tes références restent inchangés.' : 'Le résultat est disponible après archivage et restitution des ressources.';
    if (source !== 'library' || busy || op.state === 'unknown') $('image-status').textContent = `${statuses[op.state] || op.state}${op.error ? ' ' + op.error : ''}`;
    $('image-cancel').hidden = !busy; $('image-recover').hidden = !['unknown', 'archive_failed'].includes(op.state);
    $('image-stages').hidden = !busy;
    const stage = { accepted: 0, reserving: 0, generating: 1, archiving: 2, restoring: 3 }[op.state];
    [...$('image-stages').children].forEach((el, i) => { el.className = i === stage ? 'current' : i < stage ? 'done' : ''; if (i === stage) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current'); });
    $('image-use-reference').hidden = !ready; $('image-reuse-brief').hidden = !ready;
    $('image-output').hidden = !ready; $('image-download').hidden = !ready; $('image-placeholder').hidden = Boolean(ready);
    if (ready) { $('image-output').src = op.artifact.url; $('image-download').href = op.artifact.url; }
    shownDetails = null; $('image-result-details').hidden = true; $('image-result-note').hidden = true; renderResultFacts(); controls();
    for (const button of $('image-gallery').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.operation === op.id));
    clearTimeout(pollTimer);
    if (busy) pollTimer = setTimeout(poll, 1500);
    else { void loadHistory(); if (ready) void loadDetails(op).then(d => { if (operation?.id !== op.id) return; shownDetails = d; renderResultFacts(); }).catch(() => {
      if (operation?.id !== op.id) return; $('image-result-note').textContent = 'La recette enregistrée ne peut pas être chargée pour le moment.'; $('image-result-note').hidden = false;
    }); }
  }
  async function applyDraft(op) {
    const epoch = ++draftEpoch;
    try {
      const { draft } = await api(`/operations/${encodeURIComponent(op.id)}/draft`);
      if (epoch !== draftEpoch || operation?.id !== op.id) return;
      draftExpert = op.expert ? { sessionId: op.expert.sessionId, turnId: op.expert.turnId } : null;
      if (!config.profiles.some(p => p.id === draft.profile)) throw new Error('Cette ancienne recette n’est plus disponible. Son brief reste consultable sous l’image.');
      $('image-prompt').value = draft.prompt; $('image-seed').value = draft.seed ?? ''; $('image-profile').value = draft.profile; renderRecipe();
      const size = `${draft.width},${draft.height}`, p = currentRecipe();
      if (![...$('image-size').options].some(o => o.value === size) && [draft.width, draft.height].every(x => Number.isInteger(x) && x >= 256 && x <= (p.maxEdge || 2048) && x % 32 === 0) && draft.width * draft.height <= p.maxPixels) {
        const option = node('option', `Format précédent · ${dimensions(draft.width, draft.height)}`); option.value = size; $('image-size').append(option);
      }
      if ([...$('image-size').options].some(o => o.value === size && !o.disabled)) $('image-size').value = size;
      $('image-draft-source').textContent = `Brief et réglages repris depuis la création du ${new Date(op.createdAt).toLocaleDateString('fr-CA')}. L’image consultée devient une référence seulement avec le bouton « Joindre cette image ». Les références déjà jointes restent en place.`;
      $('image-draft-source').hidden = false; request = null; updateFormMode();
    } catch (error) { if (epoch === draftEpoch) $('image-status').textContent = error.message; }
  }
  async function select(op) {
    if (locked()) return;
    ++draftEpoch; show(op, 'library');
  }
  async function poll() {
    const id = operation?.id; if (!id) return;
    try { const result = await api(`/operations/${encodeURIComponent(id)}`); if (operation?.id === id) show(result.operation); }
    catch { if (operation?.id !== id) return; $('image-status').textContent = 'Connexion interrompue. Vérification de la demande enregistrée…'; pollTimer = setTimeout(poll, 5000); }
  }
  function renderHistory() {
    const query = $('image-search').value.trim().toLocaleLowerCase('fr-CA');
    const visible = history.filter(op => [op.label, op.profile, op.artifact.width, op.artifact.height, new Date(op.createdAt).toLocaleDateString('fr-CA')].join(' ').toLocaleLowerCase('fr-CA').includes(query));
    $('image-gallery').replaceChildren();
    $('image-gallery-count').textContent = `${visible.length} image${visible.length > 1 ? 's' : ''} affichée${visible.length > 1 ? 's' : ''} · les 30 dernières opérations sont consultées.`;
    for (const op of visible) {
      const button = node('button'), img = node('img'), caption = node('div', undefined, 'gallery-caption');
      button.type = 'button'; button.dataset.operation = op.id; button.setAttribute('aria-pressed', String(operation?.id === op.id));
      button.setAttribute('aria-label', `Consulter ${op.label || op.profile}, ${op.artifact.width} par ${op.artifact.height} pixels, ${new Date(op.createdAt).toLocaleDateString('fr-CA')}`);
      img.src = op.artifact.url; img.alt = 'Création conservée'; img.loading = 'lazy';
      caption.append(node('strong', op.label || op.profile), node('span', dimensions(op.artifact.width, op.artifact.height)),
        node('span', `${new Date(op.createdAt).toLocaleDateString('fr-CA')} · ${op.runtimeRestored && op.state === 'completed' ? 'Prête' : statuses[op.state] || op.state}`), node('span', 'Ouvrir l’aperçu ↗', 'gallery-open'));
      button.append(img, caption); button.addEventListener('click', () => { void select(op); }); $('image-gallery').append(button);
    }
    if (!visible.length) $('image-gallery').append(node('p', query ? 'Aucune création ne correspond à ce filtre.' : 'Tes créations archivées apparaîtront ici.', 'gallery-empty'));
    controls();
  }
  async function loadHistory() {
    try { const result = await api('/operations'); history = result.operations.filter(x => x.artifact); renderHistory(); return result.operations; }
    catch { $('image-gallery-count').textContent = 'La bibliothèque ne peut pas être chargée pour le moment.'; return []; }
  }
  async function fileBytes(file) {
    if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choisis une image PNG ou JPEG.');
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); const ratio = Math.min(1, 1536 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(img.width * ratio); canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    } finally { URL.revokeObjectURL(url); }
  }
  $('image-form').addEventListener('input', () => { ++draftEpoch; starters?.refresh(); expert?.refresh(); });
  $('image-search').addEventListener('input', renderHistory);
  $('image-size').addEventListener('change', updateFormMode);
  $('image-profile').addEventListener('change', renderRecipe);
  $('image-reuse-brief').addEventListener('click', () => { if (!locked() && operation) void applyDraft(operation); });
  $('image-export-prepare').addEventListener('click', () => { void prepareExport(); });
  $('image-new').addEventListener('click', () => {
    if (locked()) return;
    ++draftEpoch; ++referenceEpoch; selectedReference = null; request = null; operation = null; shownDetails = null;
    draftExpert = null;
    resetExport(false);
    $('image-form').reset(); $('image-profile').value = config.defaultProfile;
    for (const id of ['image-draft-source', 'image-selected-reference', 'image-result-origin', 'image-output', 'image-download', 'image-use-reference', 'image-reuse-brief', 'image-result-details', 'image-result-facts', 'image-result-note', 'image-cancel', 'image-recover', 'image-stages']) $(id).hidden = true;
    $('image-reference-previews').replaceChildren(); $('image-placeholder').hidden = false;
    $('image-result-title').textContent = 'Ton prochain résultat'; $('image-preview-help').textContent = 'Une image sélectionnée dans la bibliothèque s’affiche ici.';
    $('image-status').textContent = 'Nouveau brief. Choisis une recette et un format.'; renderRecipe(); renderHistory(); $('image-prompt').focus();
  });
  $('image-references').addEventListener('change', () => {
    ++referenceEpoch; $('image-reference-previews').replaceChildren();
    const files = [...$('image-references').files];
    files.slice(0, 2).forEach((file, i) => { const item = node('div', undefined, 'reference-preview'), img = node('img');
      const url = URL.createObjectURL(file); img.src = url; img.alt = file.name; img.onload = img.onerror = () => URL.revokeObjectURL(url);
      item.append(img, node('span', `Image ${i + (selectedReference ? 2 : 1)} · ${file.name}`)); $('image-reference-previews').append(item);
    });
    if (files.length) { const remove = node('button', 'Retirer les fichiers joints', 'quiet-button'); remove.type = 'button'; remove.addEventListener('click', () => { $('image-references').value = ''; $('image-references').dispatchEvent(new Event('change')); }); $('image-reference-previews').append(remove); }
    updateFormMode();
  });
  $('image-use-reference').addEventListener('click', () => {
    if (locked() || !operation) return;
    const selected = operation; ++referenceEpoch;
    try {
      if ($('image-references').files.length >= 2) throw new Error('Retire un fichier joint pour ajouter cette création aux références.');
      if (selected.state !== 'completed' || selected.runtimeRestored !== true || !selected.artifact?.sha256) throw new Error('L’original choisi doit être archivé et ses ressources restituées.');
      selectedReference = { id: selected.id, sha256: selected.artifact.sha256 };
      $('image-selected-reference').replaceChildren(); const thumb = node('img'), copy = node('div'), remove = node('button', 'Retirer', 'quiet-button');
      thumb.src = selected.artifact.url; thumb.alt = 'Image 1 jointe comme référence'; copy.append(node('strong', 'Image 1 · original choisi'), node('p', 'L’original archivé sert de parent à cette retouche. Il reste conservé. Au-delà de 4 MP, choisis une autre référence.'));
      remove.type = 'button'; remove.addEventListener('click', () => { ++referenceEpoch; selectedReference = null; $('image-selected-reference').hidden = true; $('image-references').dispatchEvent(new Event('change')); });
      $('image-selected-reference').append(thumb, copy, remove); $('image-selected-reference').hidden = false;
      $('image-references').dispatchEvent(new Event('change')); $('image-prompt').focus();
    } catch (error) { $('image-status').textContent = error.message; }
  });
  $('image-form').addEventListener('submit', async event => {
    event.preventDefault(); if (locked() || !config?.configured) return;
    pendingSubmit = true; controls(); ++draftEpoch;
    try {
      const files = [...$('image-references').files], ref = selectedReference;
      if (files.length + (ref ? 1 : 0) > 2) throw new Error('Deux références au maximum, y compris la création choisie.');
      const [width, height] = $('image-size').value.split(',').map(Number);
      const payload = { prompt: $('image-prompt').value, profile: $('image-profile').value, width, height,
        ...(draftExpert && { expert: draftExpert }),
        ...($('image-seed').value !== '' && { seed: Number($('image-seed').value) }) };
      const declared = workshop?.profiles.find(p => p.id === payload.profile)?.declaredIdentity;
      if (declared) { payload.recipeId = declared.id; payload.recipeVersion = declared.version; }
      if (ref) payload.parent = { operationId: ref.id, sha256: ref.sha256 };
      payload.references = await Promise.all(files.map(fileBytes));
      const signature = JSON.stringify(payload);
      // A network retry retains its identity; an explicit next creation gets a new one.
      if (!request || request.signature !== signature) request = { signature, payload: { ...payload, actionKey: crypto.randomUUID() } };
      const result = await api('/operations', request.payload);
      localStorage.setItem('agentx-image-operation', result.operation.id); request = null; show(result.operation, 'generation');
    } catch (error) { $('image-status').textContent = error.message; }
    finally { pendingSubmit = false; controls(); }
  });
  $('image-cancel').addEventListener('click', async () => { try { show((await api(`/operations/${operation.id}/cancel`, {})).operation); } catch (error) { $('image-status').textContent = error.message; } });
  $('image-recover').addEventListener('click', async () => {
    $('image-recover').disabled = true;
    try { show((await api(`/operations/${operation.id}/${operation.state === 'archive_failed' ? 'archive' : 'recover'}`, {})).operation); }
    catch (error) { $('image-status').textContent = error.message; } finally { $('image-recover').disabled = false; }
  });
  (async () => {
    try {
      config = await api('/status');
      try { workshop = await api('/workshop'); } catch { workshop = { profiles: [], worker: null }; }
      for (const p of config.profiles) { const recipe = workshop.profiles.find(item => item.id === p.id);
        const option = node('option', `${p.label}${recipe?.steps ? ` · ${recipe.steps} étapes` : ''} · max ${mp(p.maxPixels)}`);
        option.value = p.id; $('image-profile').append(option); }
      $('image-profile').value = config.defaultProfile;
      $('image-host').textContent = workshop.worker?.label || 'Hôte non renseigné';
      $('image-gpu').textContent = workshop.worker?.gpu ? `${workshop.worker.gpu}${workshop.worker.vramGiB ? ` · ${workshop.worker.vramGiB} Go VRAM` : ''} · matériel configuré` : 'Matériel non renseigné';
      if (config.profiles.length) renderRecipe(); controls();
      $('image-status').textContent = config.configured ? 'Prêt. Une seule demande à la fois. La bibliothèque sert à consulter tes créations.' : 'Le service d’images locales n’est pas configuré.';
      const ops = await loadHistory(), requestedId = new URLSearchParams(location.search).get('operation');
      if (requestedId) { const op = (await api(`/operations/${encodeURIComponent(requestedId)}`)).operation; show(op, 'continuation'); await applyDraft(op); }
      else { const current = ops.find(x => ACTIVE.includes(x.state) || x.state === 'unknown'); if (current) show(current, 'generation'); }
    } catch (error) { $('image-status').textContent = error.message; }
  })();
})();
