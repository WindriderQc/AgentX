/* Metadata and review compose the existing phone workbench. USB cleanup keeps
 * its own selection and confirmation; frame membership is independent. */
(() => {
  'use strict';
  const endpoint = '/api/phone-media/processing', $ = id => document.getElementById(id);
  let generation = 0, page;
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const say = text => { $('processing-state').textContent = text; };
  async function call(input) {
    const response = await fetch(endpoint, { method: input ? 'POST' : 'GET', cache: 'no-store', redirect: 'error',
      ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
    const value = await response.json();
    if (!response.ok || !value.ok) throw Object.assign(new Error(value.message || 'Traitement photo indisponible.'), { status: response.status, code: value.code });
    return value.data;
  }
  async function intent(key, value) {
    const name = 'phone-photo.intent.'+key;
    const prior = sessionStorage.getItem(name);
    const input = prior ? JSON.parse(prior) : value;
    sessionStorage.setItem(name, JSON.stringify(input));
    try {
      const result = await call(input);
      sessionStorage.removeItem(name);
      return result;
    } catch (error) {
      if (error.status === 400 && /^INVALID/.test(error.code || '')) sessionStorage.removeItem(name);
      throw error;
    }
  }
  function render(result) {
    for (const row of result.results) {
      const card = document.querySelector('[data-request-id="'+row.requestId+'"]');
      if (!card) continue;
      card.querySelector('.photo-analysis')?.remove();
      const body = node('section'); body.className = 'photo-analysis';
      body.append(node('h4', row.metadata ? 'Métadonnées et relecture' : 'Analyse en attente'));
      if (row.metadata) {
        const exif = row.metadata.exif || {};
        if (exif.dateTimeOriginal) body.append(node('p', 'Prise de vue (EXIF) : '+exif.dateTimeOriginal));
        const camera = [exif.make, exif.model].filter(Boolean).join(' ');
        if (camera) body.append(node('p', camera));
        const place = [exif.city, exif.state, exif.country].filter(Boolean).join(', ');
        if (place) body.append(node('p', 'Lieu extrait : '+place));
      }
      const proposal = row.analysis?.card?.proposal;
      if (proposal) {
        body.append(node('p', 'Proposition à relire : '+proposal.description));
        body.append(node('p', 'Cadre suggéré : '+proposal.frameSuitability+' · Qualité : '+proposal.quality));
        if (proposal.reasons.length) body.append(node('p', proposal.reasons.join(' · ')));
        if (proposal.privacyReview) body.append(node('p', 'L’analyse suggère une vérification du contenu personnel.'));
      } else if (row.analysis?.state === 'running') body.append(node('p', 'Analyse en cours ou à réconcilier.'));
      else if (row.analysis?.state === 'failed') body.append(node('p', 'La proposition de l’analyse n’est pas exploitable. Les métadonnées restent disponibles pour ta relecture.'));
      if (row.assetId && row.metadata?.type === 'IMAGE') {
        const picture = card.querySelector('.picture');
        if (picture && !picture.querySelector('img')) {
          const img = node('img'); img.loading = 'lazy'; img.alt = 'Aperçu de la copie dans Immich';
          img.src = '/api/photos/assets/'+encodeURIComponent(row.assetId)+'/thumbnail';
          img.addEventListener('load', () => { const fallback = picture.querySelector('.fallback'); if (fallback) fallback.hidden = true; });
          picture.append(img);
        }
      }
      if (row.metadata) {
        const details = node('details'), summary = node('summary', 'Relire et corriger la fiche');
        const description = node('textarea'); description.setAttribute('aria-label', 'Description relue'); description.maxLength = 2000;
        description.value = (row.pendingIntent?.kind === 'review' ? row.pendingIntent.value.description : undefined)
          ?? row.review?.description ?? proposal?.description ?? row.metadata.exif?.description ?? '';
        const tags = node('input'); tags.setAttribute('aria-label', 'Étiquettes relues, séparées par une virgule');
        tags.value = ((row.pendingIntent?.kind === 'review' ? row.pendingIntent.value.tags : undefined) || row.review?.tags || proposal?.tags || []).join(', ');
        const approve = node('button', row.pendingIntent?.kind === 'review' ? 'Reprendre ma relecture' : 'Enregistrer ma relecture');
        approve.disabled = Boolean(row.pendingIntent && row.pendingIntent.kind !== 'review');
        approve.addEventListener('click', async () => {
          approve.disabled = true;
          try {
            const recovery = row.pendingIntent?.kind === 'review' ? { op: 'review', sha256: row.sha256,
              writeId: row.pendingIntent.writeId, expectedRevision: row.pendingIntent.expectedRevision, ...row.pendingIntent.value } : null;
            row.review = await intent('review.'+row.sha256, recovery || { op: 'review', writeId: crypto.randomUUID(), sha256: row.sha256,
              expectedRevision: row.review?.revision || 0, approved: true, description: description.value,
              tags: tags.value.split(',').map(x => x.trim()).filter(Boolean) });
            row.pendingIntent = null;
            say('Relecture enregistrée. Les propositions et les originaux sont conservés.');
          } catch (error) { say(error.message+' Réessaie pour réconcilier cette même décision.'); }
          finally { approve.disabled = false; }
        });
        details.append(summary, description, tags, approve); body.append(details);
      }
      if (result.frameEnabled && row.metadata?.type === 'IMAGE') {
        const frame = node('button', row.frame?.selected ? 'Retirer du Cadre Photo' : 'Ajouter au Cadre Photo');
        frame.disabled = Boolean(row.pendingIntent && row.pendingIntent.kind !== 'frame');
        frame.addEventListener('click', async () => {
          frame.disabled = true;
          try {
            const recovery = row.pendingIntent?.kind === 'frame' ? { op: 'frame', sha256: row.sha256,
              writeId: row.pendingIntent.writeId, expectedRevision: row.pendingIntent.expectedRevision, ...row.pendingIntent.value } : null;
            row.frame = await intent('frame.'+row.sha256, recovery || { op: 'frame', writeId: crypto.randomUUID(), sha256: row.sha256,
              expectedRevision: row.frame?.revision || 0, selected: !row.frame?.selected });
            row.pendingIntent = null;
            frame.textContent = row.frame.selected ? 'Retirer du Cadre Photo' : 'Ajouter au Cadre Photo';
            say(row.frame.selected ? 'Photo ajoutée à la sélection du Cadre Photo.' : 'Photo retirée de la sélection du Cadre Photo.');
          } catch (error) { say(error.message+' Réessaie pour réconcilier cette même décision.'); }
          finally { frame.disabled = false; }
        });
        body.append(frame);
      }
      card.querySelector('.card-body').append(body);
    }
    const current = result.jobs.find(x => ['queued', 'claimed', 'running', 'uncertain'].includes(x.state)) || result.jobs[0];
    if (current) {
      const labels = { queued: 'Analyse en attente', claimed: 'Préparation de l’analyse', running: 'Analyse et indexation en cours',
        completed: 'Fiches disponibles pour le tri', uncertain: 'Traitement à réconcilier', failed: 'Traitement arrêté' };
      const reason = current.error === 'HEAVY_QUEUE_CONFLICT'
        ? 'Les ressources sont occupées. Le traitement reprendra automatiquement.'
        : current.error ? 'Une vérification du traitement est nécessaire.' : '';
      say((labels[current.state] || 'État du traitement à vérifier')+(reason ? ' · '+reason : ''));
    }
  }
  async function load() {
    if (!page) return;
    const own = ++generation, selected = page.items.filter(x => x.backup).map(x => x.requestId);
    const result = await call({ op: 'page', runId: page.runId, items: selected });
    if (own !== generation) return;
    $('process-page').hidden = !result.configured;
    $('process-page').disabled = !selected.length;
    render(result);
  }
  window.addEventListener('phone-media-page', event => {
    page = event.detail; generation++;
    load().catch(error => say(error.message));
  });
  $('process-page').addEventListener('click', async () => {
    if (!page) return;
    $('process-page').disabled = true;
    try {
      await intent('enqueue.'+page.runId, { op: 'enqueueRun', operationId: crypto.randomUUID(), runId: page.runId });
      say('Traitement enregistré dans la file Core. Les fiches apparaîtront après l’indexation et l’analyse.');
      await load();
    } catch (error) { say(error.message+' Réessaie pour retrouver la même demande.'); }
    finally { $('process-page').disabled = false; }
  });
  call().then(value => { $('process-page').hidden = !value.configured; }).catch(error => say(error.message));
})();
