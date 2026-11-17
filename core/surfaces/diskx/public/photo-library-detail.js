(() => {
  'use strict';
  window.PhotoLibraryDetail = { create({ $, el, image, decide, rows }) {
    const dialog = $('photo-detail');
    let selected, configuration, opener, dirty = false, saving = false, mode = 'single';
    const describe = row => (row.review?.approved ? row.review.description : row.proposal.description) || 'Image analysée';
    function discard() { return !saving && (!dirty || window.confirm('Quitter cette fiche sans enregistrer tes corrections ?')); }
    function close() { if (discard()) { dialog.close(); dirty = false; if (opener?.isConnected) opener.focus(); else $('collection-title').focus(); } }
    $('detail-close').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    window.addEventListener('beforeunload', event => {
      if (dirty || saving) { event.preventDefault(); event.returnValue = ''; }
    });
    function navigation() {
      const list = rows(), index = list.findIndex(row => row.sha256 === selected?.sha256);
      $('detail-previous').disabled = mode !== 'single' || index <= 0 || saving;
      $('detail-next').disabled = mode !== 'single' || index < 0 || index >= list.length-1 || saving;
      $('detail-position').textContent = mode === 'compare' ? 'Comparer ne change aucune sélection' : index < 0 ? 'Fiche ouverte' : (index+1)+' / '+list.length+' sur cette page';
    }
    function navigate(direction) {
      if (!discard()) return;
      const index = rows().findIndex(row => row.sha256 === selected?.sha256), next = rows()[index+direction];
      if (next) { dirty = false; render(next); }
    }
    $('detail-previous').addEventListener('click', () => navigate(-1)); $('detail-next').addEventListener('click', () => navigate(1));
    dialog.addEventListener('keydown', event => {
      if (mode !== 'single' || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      if (event.key === 'ArrowLeft' && !$('detail-previous').disabled) { event.preventDefault(); navigate(-1); }
      if (event.key === 'ArrowRight' && !$('detail-next').disabled) { event.preventDefault(); navigate(1); }
    });
    function render(row) {
      selected = row; mode = 'single'; $('detail-mode').textContent = 'RELECTURE / TON CHOIX';
      $('detail-title').textContent = row.metadata?.exif?.dateTimeOriginal ? 'Souvenir du '+row.metadata.exif.dateTimeOriginal.slice(0,10) : 'Une image, ton regard';
      const layout = el('div', undefined, 'detail-layout'), copy = el('section', undefined, 'detail-copy');
      layout.append(image(row, 'detail-image'), copy); $('detail-body').replaceChildren(layout);
      const feedback = el('p', '', 'detail-feedback'); feedback.setAttribute('role', 'status');
      copy.append(el('h3', 'La proposition'), el('p', row.proposal.description));
      copy.append(el('p', 'Qualité proposée : '+row.proposal.quality+' · Cadre : '+row.proposal.frameSuitability));
      if (row.proposal.reasons?.length) { const list = el('ul'); for (const reason of row.proposal.reasons) list.append(el('li', reason)); copy.append(list); }
      if (row.proposal.privacyReview) copy.append(el('p', 'Contenu personnel à vérifier avant de choisir sa diffusion.', 'frame-state'));
      const tags = el('p', (row.proposal.tags || []).join(' · ')); copy.append(tags);
      const frame = el('button'), frameState = el('p', undefined, 'frame-state');
      const reviewDetails = el('details'), summary = el('summary', 'Relire et corriger la fiche'); reviewDetails.append(summary);
      const form = el('form'), descriptionLabel = el('label', 'Ta description'), description = el('textarea'); description.maxLength = 2000;
      description.setAttribute('aria-label', 'Ta description'); descriptionLabel.append(description);
      const tagsLabel = el('label', 'Tes étiquettes, séparées par une virgule'), tagInput = el('input'); tagInput.setAttribute('aria-label', 'Tes étiquettes'); tagsLabel.append(tagInput);
      const approve = el('button', 'Enregistrer ma relecture', 'primary'); approve.type = 'submit';
      const reviewState = el('p');
      function fields() {
        const pending = row.pendingIntent?.kind === 'review' ? row.pendingIntent.value : null;
        description.value = pending?.description ?? row.review?.description ?? row.proposal.description;
        tagInput.value = (pending?.tags || row.review?.tags || row.proposal.tags || []).join(', ');
      }
      function actions() {
        const pending = row.pendingIntent?.kind;
        frame.textContent = pending === 'frame' ? 'Reprendre mon choix Cadre' : row.frame?.selected ? 'Retirer du Cadre Photo' : 'Ajouter au Cadre Photo';
        frame.disabled = saving || !configuration?.frameEnabled || Boolean(row.pendingDecision && pending !== 'frame');
        approve.textContent = pending === 'review' ? 'Reprendre ma relecture' : 'Enregistrer ma relecture';
        approve.disabled = saving || Boolean(row.pendingDecision && pending !== 'review');
        description.disabled = tagInput.disabled = saving || Boolean(row.pendingDecision);
        frameState.textContent = row.frame?.selected ? '✓ Cette image est dans le Cadre Photo.' : row.proposal.frameSuitability === 'oui' ? 'Cadre suggéré · aucun ajout automatique.' : 'Le choix du cadre reste libre.';
        reviewState.textContent = row.review?.approved ? '✓ Fiche relue. Tu peux encore la corriger.' : 'Cette proposition attend ta relecture.';
        if (row.pendingDecision) feedback.textContent = 'Une décision attend confirmation. Reprends-la avec le bouton correspondant avant un nouveau choix.';
        navigation();
      }
      async function save(kind, value) {
        if (saving) return;
        saving = true; actions(); feedback.textContent = 'Enregistrement et vérification…';
        try {
          await decide(row, kind, value);
          if (kind === 'review') { dirty = false; fields(); }
          feedback.textContent = kind === 'review' ? 'Relecture enregistrée. La proposition d’origine est conservée.' : row.frame?.selected ? 'Image ajoutée au Cadre Photo.' : 'Image retirée du Cadre Photo.';
        } catch (error) { feedback.textContent = error.message; }
        finally { saving = false; actions(); }
      }
      frame.addEventListener('click', () => save('frame', { selected: !row.frame?.selected }));
      form.addEventListener('input', () => { dirty = true; });
      form.addEventListener('submit', event => { event.preventDefault(); save('review', { approved: true, description: description.value,
        tags: tagInput.value.split(',').map(x => x.trim()).filter(Boolean) }); });
      fields(); form.append(descriptionLabel, tagsLabel, approve); reviewDetails.append(reviewState, form);
      copy.append(frameState, frame);
      if (!configuration?.frameEnabled) copy.append(el('p', 'Le Cadre Photo attend sa configuration. Les fiches restent consultables.'));
      copy.append(reviewDetails, feedback);
      const facts = el('details'), factSummary = el('summary', 'Métadonnées et origine'); facts.append(factSummary);
      const exif = row.metadata?.exif || {}, data = el('dl');
      for (const [name, value] of [['Prise de vue (EXIF)', exif.dateTimeOriginal], ['Appareil', [exif.make, exif.model].filter(Boolean).join(' ')],
        ['Lieu extrait', [exif.city, exif.state, exif.country].filter(Boolean).join(', ')], ['Dimensions', exif.exifImageWidth && exif.exifImageHeight ? exif.exifImageWidth+' × '+exif.exifImageHeight : null],
        ['Fichier de galerie', row.source?.relativePath], ['Analyse', row.analyzedAt]]) {
        if (value) data.append(el('dt', name), el('dd', value));
      }
      facts.append(data);
      if (row.source?.runId) { const link = el('a', 'Retrouver l’import et ses repères de tri ↗'); link.href = '/diskx/phone?run='+encodeURIComponent(row.source.runId)+'#library'; facts.append(link); }
      copy.append(facts); actions(); $('detail-body').scrollTop = 0;
    }
    function open(row, trigger) {
      if (dialog.open && !discard()) return;
      dirty = false; opener = trigger || opener; render(row); if (!dialog.open) dialog.showModal();
    }
    function compare(list, trigger) {
      if (dialog.open && !discard()) return;
      dirty = false; mode = 'compare'; opener = trigger; selected = null;
      $('detail-mode').textContent = 'COMPARAISON'; $('detail-title').textContent = 'Prends le temps de choisir.';
      const grid = el('div', undefined, 'library-comparison');
      for (const row of list) {
        const figure = el('figure'), caption = el('figcaption');
        caption.append(el('p', describe(row)), el('p', 'Qualité '+row.proposal.quality+' · '+(row.frame?.selected ? 'Dans le cadre' : 'Pas encore dans le cadre')));
        const review = el('button', 'Ouvrir cette fiche'); review.addEventListener('click', () => open(row));
        caption.append(review); figure.append(image(row, 'detail-image'), caption); grid.append(figure);
      }
      $('detail-body').replaceChildren(grid); navigation(); if (!dialog.open) dialog.showModal();
    }
    return { open, compare, update: value => { configuration = value; if (dialog.open) navigation(); } };
  } };
})();
