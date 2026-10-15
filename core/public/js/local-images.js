'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const ACTIVE = ['queued', 'accepted', 'reserving', 'generating', 'archiving', 'restoring'];
  const statuses = { queued: 'Image queued. It will start when its slot is free.', accepted: 'Request recorded.', reserving: 'Preparing the GPU and the services that share it.',
    generating: 'Generating…', archiving: 'Archiving the original…', restoring: 'Returning resources to their usual services…',
    completed: 'Image ready, original archived and resources returned.', cancelled: 'Generation cancelled.', failed: 'Generation failed.',
    unknown: 'Uncertain state: recover this operation before a new request.', archive_failed: 'Image computed; its archiving must be resumed.' };
  let config, workshop, operation, origin = 'generation', pollTimer, request, selectedReference = null;
  let draftEpoch = 0, referenceEpoch = 0, pendingSubmit = false, history = [], shownDetails = null, guideReference = null;
  const detailsCache = new Map();
  let exportEpoch = 0;
  let draftExpert = null;
  const mp = pixels => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(pixels / 1e6)} MP`;
  const dimensions = (w, h) => `${w} × ${h} px · ${mp(w * h)}`;
  const duration = ms => { const seconds = Math.round(ms / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`; };
  const locked = () => pendingSubmit || ACTIVE.includes(operation?.state) || operation?.state === 'unknown';
  const constraints = globalThis.AgentXImageConstraints?.mount({
    getContext: () => ({ locked: locked(), prompt: $('image-prompt').value, textPolicy: textPolicy?.getValue({ draft: true }) }),
    onChange: () => { ++draftEpoch; draftExpert = null; queueMicrotask(controls); }
  });
  const textPolicy = globalThis.AgentXImageTextPolicy?.mount({
    getContext: () => ({ locked: locked(), prompt: $('image-prompt').value, constraints: constraints?.getValue({ draft: true }) }),
    onChange: () => { ++draftEpoch; draftExpert = null; queueMicrotask(controls); },
    onAdvice: () => expert?.planTexts()
  });
  const textEditor = globalThis.ImageTextEditor?.init({ getContext: () => ({ operation, details: shownDetails, locked: locked() }) });
  const imageCompare = globalThis.ImageCompare?.init({ getContext: () => ({ operation, details: shownDetails, locked: locked() }) });
  const protectedComposition = globalThis.ImageProtectedComposition?.init({ getContext: () => ({ operation, details: shownDetails, locked: locked() }) });
  const currentRecipe = () => workshop?.profiles.find(p => p.id === $('image-profile').value) || config?.profiles.find(p => p.id === $('image-profile').value);
  const genericSizes = [...$('image-size').options].map(option => [option.value, option.textContent]);
  const shape = (w, h) => w === h ? 'Square' : w > h ? 'Landscape' : 'Portrait';
  const referenceCount = () => (selectedReference ? 1 : 0) + $('image-references').files.length + (guideReference ? 1 : 0);
  const references = globalThis.AgentXImageReferenceSelection.create({
    getSelection: () => ({ epoch: referenceEpoch, parent: selectedReference && { operationId: selectedReference.id, sha256: selectedReference.sha256 },
      files: $('image-references').files, sketch: guideReference }),
    upload: async (sessionId, prepared, kind, original) => {
      if (prepared.bytes > 2 * 1024 * 1024) throw new Error('Each selected working copy must be 2 MiB or less. Choose a smaller input; your draft and references are kept.');
      if (original?.size > 50 * 1024 * 1024) throw new Error('The original reference exceeds 50 MiB. Choose a smaller original; your draft and references are kept.');
      const route = `/expert/sessions/${encodeURIComponent(sessionId)}/references`;
      const { reference } = await api(route, { kind, name: kind === 'sketch' ? 'composition-sketch.png' : 'browser-working-copy.jpg',
        dataUrl: `data:${prepared.mimeType};base64,${prepared.base64}` });
      if (reference?.sha256 !== prepared.sha256 || reference.mimeType !== prepared.mimeType || reference.byteLength !== prepared.bytes
        || reference.width !== prepared.width || reference.height !== prepared.height) throw new Error('The uploaded reference does not match the prepared image. Your draft is kept.');
      if (original) {
        const response = await fetch(`/api/images${route}/${encodeURIComponent(reference.attachmentId)}/original`, {
          method: 'POST', headers: { 'Content-Type': original.type, 'X-Attachment-Name': encodeURIComponent(original.name || 'original-image') }, body: original });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || 'The original reference could not be retained. Your draft and selection are kept.');
      }
      return reference;
    },
    resolve: async (sessionId, selected) => (await api(`/expert/sessions/${encodeURIComponent(sessionId)}/references/resolve`, { references: selected })).references,
    onChange: () => queueMicrotask(() => expert?.refresh())
  });
  const layoutGuide = globalThis.ImageLayoutGuide?.init({
    getContext: () => { const [width, height] = $('image-size').value.split(',').map(Number);
      return { locked: locked(), width, height, referenceCount: referenceCount(), guideAttached: !!guideReference }; },
    onReference: value => {
      if (locked() || referenceCount() - (guideReference ? 1 : 0) >= 2) throw new Error('Two references at most, including the sketch and the parent.');
      guideReference = value; ++referenceEpoch; ++draftEpoch; draftExpert = null; updateFormMode();
    },
    onRemoveReference: () => { if (locked()) return; guideReference = null; ++referenceEpoch; ++draftEpoch; draftExpert = null; updateFormMode(); }
  });
  const expert = globalThis.AgentXImageExpert?.mount({
    prepareReferences: sessionId => references.inspect(sessionId),
    matchReferences: selected => references.matches(selected),
    restoreBrief: saved => {
      if (locked() || $('image-prompt').value.trim()) return;
      globalThis.ImageBriefConstraints?.composeBrief(saved.prompt, saved.constraints);
      constraints?.setValue(saved.constraints);
      textPolicy?.setValue(saved.textPolicy, saved.constraints);
      draftExpert = null; ++draftEpoch;
      $('image-prompt').value = saved.prompt; $('image-draft-source').hidden = true;
      $('image-status').textContent = 'Saved brief recovered. Check the settings and reattach references if needed.';
      controls(); $('image-prompt').focus();
    },
    getContext: () => {
      const [width, height] = $('image-size').value.split(',').map(Number);
      return { ready: !!config?.configured, locked: locked(), prompt: $('image-prompt').value,
        profile: $('image-profile').value, width, height, referenceCount: referenceCount(),
        seed: $('image-seed').value, referenceEpoch, references: references.current(), worker: workshop?.worker || null,
        constraints: constraints?.getValue({ draft: true }), constraintsInvalid: constraints ? !constraints.isValid({ forPlanning: true }) : false,
        textPolicy: textPolicy?.getValue({ draft: true }), textPolicyError: textPolicy?.getError({ forPlanning: true }) || '' };
    },
    apply: (prompt, source, policy) => {
      if (policy) textPolicy?.setValue(policy);
      draftExpert = source;
      ++draftEpoch; $('image-prompt').value = prompt; $('image-draft-source').hidden = true;
      $('image-status').textContent = 'Brief prepared with imageX · Hermes. Check the references and start the creation.';
      controls();
      $('image-prompt').focus();
    }
  });
  const starters = globalThis.AgentXImageStarters?.mount({
    getContext: () => ({ locked: locked() || !config?.configured, referenceCount: referenceCount(),
      profiles: workshop?.profiles || [], hasPrompt: !!$('image-prompt').value.trim() }),
    apply: prompt => {
      draftExpert = null;
      ++draftEpoch; $('image-prompt').value = prompt; $('image-draft-source').hidden = true;
      $('image-status').textContent = 'Template prepared. Replace the bracketed passages and check the references before creating.';
      controls();
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
    const result = await r.json(); if (!r.ok || !result.ok) throw Object.assign(new Error(result.message || 'Service unavailable.'), { status: r.status }); return result;
  }
  function controls() {
    const block = locked();
    const prompt = $('image-prompt').value, hasBrief = !!prompt.trim();
    let valid = prompt.length <= (globalThis.ImageBriefConstraints?.MAX_PROMPT || 8000) && (!constraints || constraints.isValid({ forPlanning: true })), finalPrompt = '', renderError = '';
    try {
      if (hasBrief && (!constraints || constraints.isValid({ forPlanning: true }))) {
        const items = constraints?.getValue(), policy = textPolicy?.getValue();
        finalPrompt = globalThis.ImageTextPolicy.inspect(prompt, items, policy).prompt || '';
        globalThis.ImageTextPolicy.compose(prompt, items, policy);
      }
    }
    catch (error) { valid = false; renderError = error.message; }
    $('image-render-preview').hidden = !finalPrompt;
    $('image-render-prompt').textContent = finalPrompt;
    $('image-create').disabled = block || !config?.configured || !hasBrief || referenceCount() > 2 || !valid;
    $('image-create-help').textContent = block ? 'Wait for the current request to finish before starting another image.'
      : !config?.configured ? 'The local render service is unavailable.'
      : !hasBrief ? 'Describe your image in the brief to begin.'
      : referenceCount() > 2 ? 'Remove a reference: two images at most.'
      : !valid ? renderError || 'Prepare a version of at most 8,000 characters, constraints included: refine the brief or shorten it here.'
      : 'Ready to create with this brief. This button starts the local render.';
    $('image-new').disabled = block || !config; $('image-use-reference').disabled = block; $('image-reuse-brief').disabled = block;
    for (const button of $('image-gallery').querySelectorAll('button')) button.disabled = block;
    starters?.refresh();
    expert?.refresh();
    textEditor?.refresh();
    imageCompare?.refresh();
    protectedComposition?.refresh();
    constraints?.refresh();
    textPolicy?.refresh();
    layoutGuide?.refresh();
  }
  function updateFormMode() {
    const count = referenceCount();
    $('image-compose-title').textContent = selectedReference ? 'Prepare an edit' : count ? 'Creation with references' : 'New creation';
    $('image-create-label').textContent = selectedReference ? 'Create the edit' : count ? 'Create the image with references' : 'Create a new image';
    $('image-reference-help').textContent = count > 2 ? 'Two references at most: remove an image before sending.'
      : count ? `${count} reference${count > 1 ? 's' : ''} attached. Describe the changes and the elements to preserve. The edit may also change areas you did not ask for.`
      : 'Without an attached reference, the model creates a new composition.';
    const [w, h] = $('image-size').value.split(',').map(Number);
    $('image-format-help').textContent = count && currentRecipe()?.editingFraming === 'first-reference'
      ? `Qwen keeps the framing of the first reference, with a target area of ${mp(w * h)}. The actual dimensions are shown with the result.`
      : `Requested format: ${dimensions(w, h)}. The actual dimensions appear under the produced image.`;
    controls();
  }
  function renderRecipe() {
    const p = currentRecipe(); if (!p) return;
    $('image-recipe-summary').replaceChildren();
    const heading = node('div', undefined, 'recipe-top'); heading.append(node('strong', p.label), node('span', p.steps ? `${p.steps} steps` : 'Steps not specified', 'recipe-pill'));
    const summary = node('p', p.description || (p.steps <= 8 ? 'Few-step recipe to explore an idea or prepare an edit.' : 'Recipe with more steps to work on a proposal. Object consistency still needs review.'));
    const limits = node('div', undefined, 'recipe-limits');
    limits.append(node('span', `Maximum area: ${mp(p.maxPixels)}`), node('span', p.precision || 'Precision not specified'));
    $('image-recipe-summary').append(heading, summary, limits);
    facts($('image-components'), [['Diffusion', p.diffusion], ['Encoder', p.encoder], ['VAE', p.vae]]);
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
    textEditor?.refresh();
    imageCompare?.refresh();
    protectedComposition?.refresh();
    if (!operation) return;
    const d = shownDetails, a = operation.artifact;
    facts($('image-result-facts'), [['Model / recipe', d?.recipe.label || operation.label || operation.profile],
      ['Actual dimensions', a ? dimensions(a.width, a.height) : null], ['Steps', d?.recipe.steps],
      ['Recorded host', d?.worker?.label], ['Currently associated GPU', d?.worker?.gpu],
      ['Total operation time', operation.timings?.totalMs != null ? duration(operation.timings.totalMs) : null]]);
    $('image-result-facts').hidden = !a;
    if (!d) return;
    $('image-saved-prompt').textContent = d.request.prompt || 'Brief not available.';
    facts($('image-saved-recipe'), [['Requested format', d.request.width && d.request.height ? dimensions(d.request.width, d.request.height) : null],
      ['Recorded recipe', d.recipe.declaredIdentity?.id], ['Recorded version', d.recipe.declaredIdentity?.version],
      ['Prepared graph (SHA-256)', d.execution?.graphSha256],
      ['Seed', d.request.seed], ['Diffusion', d.recipe.diffusion], ['Encoder', d.recipe.encoder], ['VAE', d.recipe.vae],
      ['Precision', d.recipe.precision], ['Archive', d.archivePath]]);
    const parent = d.lineage?.parent;
    if (parent) {
      const row = node('div'), value = node('dd'), link = node('a', 'View the chosen original'), preview = node('img');
      link.href = `/images?operation=${encodeURIComponent(parent.operationId)}`;
      preview.src = `/api/images/operations/${encodeURIComponent(parent.operationId)}/image`;
      preview.alt = 'Parent original of this edit'; preview.loading = 'lazy'; preview.width = 96;
      value.append(link, preview, node('span', dimensions(parent.width, parent.height)));
      row.append(node('dt', 'Recorded parent image'), value); $('image-saved-recipe').append(row);
    }
    $('image-result-details').hidden = false;
    if (d.expert) {
      const row = node('div'), value = node('dd'), link = node('a', 'Brief prepared with imageX · Hermes');
      link.href = `/images?expertSession=${encodeURIComponent(d.expert.sessionId)}#imagex`;
      value.append(link, node('span', d.expert.promptEdited ? ' · prompt adjusted after the proposal' : ' · prompt proposed by Hermes'));
      row.append(node('dt', 'Collaboration'), value); $('image-saved-recipe').append(row);
    }
    $('image-result-note').textContent = 'The total time includes preparation, computation, archiving and restoration; this receipt does not break these times down separately. The hardware shown comes from the current configuration associated with the recorded host.';
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
    $('image-export-status').textContent = 'Checking the archived files…';
    try {
      const url = `/api/images/operations/${encodeURIComponent(op.id)}/export`;
      const response = await fetch(url, { method: 'GET' }), manifest = await response.json();
      if (!response.ok) throw new Error(manifest.message || 'This export is unavailable.');
      if (epoch !== exportEpoch || operation?.id !== op.id) return;
      const list = node('ul'), add = (label, href, filename) => {
        const row = node('li'), link = node('a', label); link.href = href; link.download = filename; row.append(link); list.append(row);
      };
      add('Recipe manifest', url, 'image-recipe.json');
      for (const part of manifest.parts) {
        if (!/^(graph\.json|output\.(png|jpg)|reference-[01]-(source\.(png|jpg)|worker\.png))$/.test(part.name)) throw new Error('Invalid file list.');
        add(part.name, `${url}/parts/${encodeURIComponent(part.name)}`, part.name);
      }
      $('image-export-links').replaceChildren(list);
      $('image-export-status').textContent = 'Files verified. Download the manifest and the parts you want to keep.';
    } catch (error) { if (epoch === exportEpoch) $('image-export-status').textContent = error.message; }
    finally { if (epoch === exportEpoch) $('image-export-prepare').disabled = false; }
  }
  function show(op, source = origin) {
    operation = op; origin = source;
    const busy = ACTIVE.includes(op.state), ready = op.state === 'completed' && op.runtimeRestored === true && op.artifact;
    resetExport(ready);
    $('image-result-title').textContent = busy ? 'Your image is taking shape' : source === 'library' ? 'Library image' : 'Request result';
    $('image-result-origin').textContent = source === 'library' ? 'LIBRARY' : source === 'continuation' ? 'FROM THE CONVERSATION' : 'THIS REQUEST';
    $('image-result-origin').hidden = false;
    $('image-preview-help').textContent = source === 'library' ? 'Viewing a kept image. Your brief and references stay unchanged.' : 'The result is available after archiving and returning resources.';
    if (source !== 'library' || busy || op.state === 'unknown') $('image-status').textContent = `${statuses[op.state] || op.state}${op.error ? ' ' + op.error : ''}${busy && op.cancelRequested ? ' · Cancellation requested…' : ''}`;
    // Archiving and restoring always finish; once asked, cancelling again does nothing.
    $('image-cancel').hidden = !busy || ['archiving', 'restoring'].includes(op.state); $('image-cancel').disabled = Boolean(op.cancelRequested);
    $('image-recover').hidden = !['unknown', 'archive_failed'].includes(op.state);
    $('image-stages').hidden = !busy;
    const stage = { accepted: 0, reserving: 0, generating: 1, archiving: 2, restoring: 3 }[op.state];
    [...$('image-stages').children].forEach((el, i) => { el.className = i === stage ? 'current' : i < stage ? 'done' : ''; if (i === stage) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current'); });
    $('image-use-reference').hidden = !ready; $('image-reuse-brief').hidden = !ready;
    $('image-improve-help').hidden = !ready;
    $('image-text-open').hidden = !!ready;
    $('image-output').hidden = !ready; $('image-download').hidden = !ready; $('image-placeholder').hidden = Boolean(ready);
    if (ready) { $('image-output').src = op.artifact.url; $('image-download').href = op.artifact.url; }
    shownDetails = null; $('image-result-details').hidden = true; $('image-result-note').hidden = true; renderResultFacts(); controls();
    for (const button of $('image-gallery').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.operation === op.id));
    clearTimeout(pollTimer);
    if (busy) pollTimer = setTimeout(poll, 1500);
    else { void loadHistory(); if (ready) void loadDetails(op).then(d => { if (operation?.id !== op.id) return; shownDetails = d; renderResultFacts(); }).catch(() => {
      if (operation?.id !== op.id) return; $('image-result-note').textContent = 'The recorded recipe cannot be loaded right now.'; $('image-result-note').hidden = false;
    }); }
  }
  async function applyDraft(op) {
    const epoch = ++draftEpoch;
    try {
      const { draft } = await api(`/operations/${encodeURIComponent(op.id)}/draft`);
      if (epoch !== draftEpoch || operation?.id !== op.id) return;
      if (!config.profiles.some(p => p.id === draft.profile)) throw new Error('This older recipe is no longer available. Its brief remains viewable under the image.');
      constraints?.setValue(draft.constraints);
      textPolicy?.setValue(draft.textPolicy, draft.constraints);
      draftExpert = op.expert ? { sessionId: op.expert.sessionId, turnId: op.expert.turnId } : null;
      $('image-prompt').value = draft.visualPrompt ?? draft.prompt; $('image-seed').value = draft.seed ?? ''; $('image-profile').value = draft.profile; renderRecipe();
      const size = `${draft.width},${draft.height}`, p = currentRecipe();
      if (![...$('image-size').options].some(o => o.value === size) && [draft.width, draft.height].every(x => Number.isInteger(x) && x >= 256 && x <= (p.maxEdge || 2048) && x % 32 === 0) && draft.width * draft.height <= p.maxPixels) {
        const option = node('option', `Previous format · ${dimensions(draft.width, draft.height)}`); option.value = size; $('image-size').append(option);
      }
      if ([...$('image-size').options].some(o => o.value === size && !o.disabled)) $('image-size').value = size;
      $('image-draft-source').textContent = `Brief and settings reused from the creation of ${new Date(op.createdAt).toLocaleDateString('en-US')}. The viewed image becomes a reference only with the "Attach this image" button. References already attached stay in place.`;
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
    catch (error) {
      if (operation?.id !== id) return;
      // A 4xx will not heal by retrying (unknown or removed request): stop and unlock the form.
      if (error.status >= 400 && error.status < 500) { operation = null; controls(); $('image-status').textContent = `This request is no longer tracked: ${error.message}`; return; }
      $('image-status').textContent = 'Connection interrupted. Checking the recorded request…'; pollTimer = setTimeout(poll, 5000);
    }
  }
  function renderHistory() {
    const query = $('image-search').value.trim().toLocaleLowerCase('fr-CA');
    const visible = history.filter(op => [op.label, op.profile, op.artifact.width, op.artifact.height, new Date(op.createdAt).toLocaleDateString('en-US')].join(' ').toLocaleLowerCase('fr-CA').includes(query));
    $('image-gallery').replaceChildren();
    $('image-gallery-count').textContent = `${visible.length} image${visible.length > 1 ? 's' : ''} shown · the last 30 operations are checked.`;
    for (const op of visible) {
      const button = node('button'), img = node('img'), caption = node('div', undefined, 'gallery-caption');
      button.type = 'button'; button.dataset.operation = op.id; button.setAttribute('aria-pressed', String(operation?.id === op.id));
      button.setAttribute('aria-label', `View ${op.label || op.profile}, ${op.artifact.width} by ${op.artifact.height} pixels, ${new Date(op.createdAt).toLocaleDateString('en-US')}`);
      img.src = op.artifact.url; img.alt = 'Kept creation'; img.loading = 'lazy';
      caption.append(node('strong', op.label || op.profile), node('span', dimensions(op.artifact.width, op.artifact.height)),
        node('span', `${new Date(op.createdAt).toLocaleDateString('en-US')} · ${op.runtimeRestored && op.state === 'completed' ? 'Ready' : statuses[op.state] || op.state}`), node('span', 'Open preview ↗', 'gallery-open'));
      button.append(img, caption); button.addEventListener('click', () => { void select(op); }); $('image-gallery').append(button);
    }
    if (!visible.length) $('image-gallery').append(node('p', query ? 'No creation matches this filter.' : 'Your archived creations will appear here.', 'gallery-empty'));
    controls();
  }
  async function loadHistory() {
    try { const result = await api('/operations'); history = result.operations.filter(x => x.artifact); renderHistory(); return result.operations; }
    catch { $('image-gallery-count').textContent = 'The library cannot be loaded right now.'; return []; }
  }
  $('image-form').addEventListener('input', () => { ++draftEpoch; controls(); });
  $('image-search').addEventListener('input', renderHistory);
  $('image-size').addEventListener('change', updateFormMode);
  $('image-profile').addEventListener('change', renderRecipe);
  $('image-reuse-brief').addEventListener('click', () => { if (!locked() && operation) void applyDraft(operation); });
  $('image-export-prepare').addEventListener('click', () => { void prepareExport(); });
  $('image-new').addEventListener('click', () => {
    if (locked()) return;
    ++draftEpoch; ++referenceEpoch; selectedReference = null; guideReference = null; request = null; operation = null; shownDetails = null;
    draftExpert = null;
    resetExport(false);
    // The inline proposal remains an independent draft when the creation form resets.
    const proposed = $('imagex-proposal-prompt').value;
    $('image-form').reset(); $('image-profile').value = config.defaultProfile;
    $('imagex-proposal-prompt').value = proposed; $('imagex-proposal-panel').hidden = true;
    constraints?.reset();
    textPolicy?.reset();
    for (const id of ['image-draft-source', 'image-selected-reference', 'image-result-origin', 'image-output', 'image-download', 'image-use-reference', 'image-reuse-brief', 'image-result-details', 'image-result-facts', 'image-result-note', 'image-cancel', 'image-recover', 'image-stages', 'image-improve-help']) $(id).hidden = true;
    $('image-text-open').hidden = false;
    $('image-reference-previews').replaceChildren(); $('image-placeholder').hidden = false;
    $('image-result-title').textContent = 'Your next result'; $('image-preview-help').textContent = 'An image selected in the library is shown here.';
    $('image-status').textContent = 'New brief. Choose a recipe and a format.'; renderRecipe(); renderHistory(); $('image-prompt').focus();
  });
  $('image-references').addEventListener('change', () => {
    ++referenceEpoch; draftExpert = null; $('image-reference-previews').replaceChildren();
    const files = [...$('image-references').files];
    files.slice(0, 2).forEach((file, i) => { const item = node('div', undefined, 'reference-preview'), img = node('img');
      const url = URL.createObjectURL(file); img.src = url; img.alt = file.name; img.onload = img.onerror = () => URL.revokeObjectURL(url);
      item.append(img, node('span', `Image ${i + (selectedReference ? 2 : 1)} · ${file.name}`)); $('image-reference-previews').append(item);
    });
    if (files.length) { const remove = node('button', 'Remove attached files', 'quiet-button'); remove.type = 'button'; remove.addEventListener('click', () => { $('image-references').value = ''; $('image-references').dispatchEvent(new Event('change')); }); $('image-reference-previews').append(remove); }
    updateFormMode();
  });
  $('image-text-open').addEventListener('click', () => { textEditor?.open(); });
  $('image-use-reference').addEventListener('click', () => {
    if (locked() || !operation) return;
    const selected = operation; ++referenceEpoch;
    try {
      if ($('image-references').files.length + (guideReference ? 1 : 0) >= 2) throw new Error('Remove a reference to add this creation to the references.');
      if (selected.state !== 'completed' || selected.runtimeRestored !== true || !selected.artifact?.sha256) throw new Error('The chosen original must be archived and its resources returned.');
      selectedReference = { id: selected.id, sha256: selected.artifact.sha256 };
      $('image-selected-reference').replaceChildren(); const thumb = node('img'), copy = node('div'), remove = node('button', 'Remove', 'quiet-button');
      thumb.src = selected.artifact.url; thumb.alt = 'Image 1 attached as a reference'; copy.append(node('strong', 'Image 1 · chosen original'), node('p', 'The archived original serves as the parent of this edit. It stays kept. Above 4 MP, choose another reference.'));
      remove.type = 'button'; remove.addEventListener('click', () => { ++referenceEpoch; selectedReference = null; $('image-selected-reference').hidden = true; $('image-references').dispatchEvent(new Event('change')); });
      $('image-selected-reference').append(thumb, copy, remove); $('image-selected-reference').hidden = false;
      $('image-references').dispatchEvent(new Event('change')); $('image-prompt').focus();
    } catch (error) { $('image-status').textContent = error.message; }
  });
  // Enter in a one-line field (sketch zone, seed, constraint) must not submit: submitting starts a GPU render.
  $('image-form').addEventListener('keydown', event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault(); });
  $('image-form').addEventListener('submit', async event => {
    event.preventDefault(); if (locked() || !config?.configured) return;
    pendingSubmit = true; controls(); ++draftEpoch;
    try {
      const files = [...$('image-references').files], ref = selectedReference;
      if (files.length + (ref ? 1 : 0) + (guideReference ? 1 : 0) > 2) throw new Error('Two references at most, including the chosen creation and the sketch.');
      const [width, height] = $('image-size').value.split(',').map(Number);
      const payload = { prompt: $('image-prompt').value, profile: $('image-profile').value, width, height,
        ...(constraints?.getValue() && { constraints: constraints.getValue() }),
        ...(textPolicy?.getValue() && { textPolicy: textPolicy.getValue() }),
        ...(draftExpert && { expert: draftExpert }),
        ...($('image-seed').value !== '' && { seed: Number($('image-seed').value) }) };
      if (payload.prompt.length > (globalThis.ImageBriefConstraints?.MAX_BRIEF || 32000)) throw new Error('The brief exceeds 32,000 characters. Shorten it before continuing; all pasted text is kept.');
      if (payload.prompt.length > (globalThis.ImageBriefConstraints?.MAX_PROMPT || 8000)) throw new Error('The entered brief exceeds 8,000 characters. Use "Refine my brief" with Hermes, or shorten the text.');
      globalThis.ImageTextPolicy.compose(payload.prompt, payload.constraints, payload.textPolicy);
      const declared = workshop?.profiles.find(p => p.id === payload.profile)?.declaredIdentity;
      if (declared) { payload.recipeId = declared.id; payload.recipeVersion = declared.version; }
      if (ref) payload.parent = { operationId: ref.id, sha256: ref.sha256 };
      const prepared = await references.render();
      payload.references = prepared.references;
      if (prepared.referenceSelection) payload.referenceSelection = prepared.referenceSelection;
      const signature = JSON.stringify(payload);
      // A network retry retains its identity; an explicit next creation gets a new one.
      if (!request || request.signature !== signature) request = { signature, payload: { ...payload, actionKey: crypto.randomUUID() } };
      const result = await api('/operations', request.payload);
      request = null; show(result.operation, 'generation');
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
        const option = node('option', `${p.label}${recipe?.steps ? ` · ${recipe.steps} steps` : ''} · max ${mp(p.maxPixels)}`);
        option.value = p.id; $('image-profile').append(option); }
      $('image-profile').value = config.defaultProfile;
      $('image-host').textContent = workshop.worker?.label || 'Host not specified';
      $('image-gpu').textContent = workshop.worker?.gpu ? `${workshop.worker.gpu}${workshop.worker.vramGiB ? ` · ${workshop.worker.vramGiB} GB VRAM` : ''} · configured hardware` : 'Hardware not specified';
      if (config.profiles.length) renderRecipe(); controls();
      $('image-status').textContent = config.configured ? 'Ready. One request at a time. Use the library to view your creations.' : 'The local image service is not configured.';
      const ops = await loadHistory(), requestedId = new URLSearchParams(location.search).get('operation');
      if (requestedId) { const op = (await api(`/operations/${encodeURIComponent(requestedId)}`)).operation; show(op, 'continuation'); await applyDraft(op); }
      else { const current = ops.find(x => ACTIVE.includes(x.state) || x.state === 'unknown'); if (current) show(current, 'generation'); }
    } catch (error) { $('image-status').textContent = error.message; }
  })();
})();
