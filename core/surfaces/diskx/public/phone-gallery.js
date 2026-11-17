/* Browsing and comparison only. Import, review, frame and cleanup retain their owners. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let run = '', items = [], rows = new Map(), compared = new Set(), visible = [], current = null, mode = 'single';
  const node = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const video = item => rows.get(item.requestId)?.metadata?.type === 'VIDEO' || /\.(mp4|mov|mkv|webm|avi|m4v|3gp)$/i.test(item.format || '');
  const companion = item => /\.(xmp|aae)$/i.test(item.format || '');
  const image = item => !video(item) && !companion(item);
  const suggested = row => row?.metadata?.type === 'IMAGE' && row?.analysis?.card?.proposal?.frameSuitability === 'oui';
  const preview = item => {
    const row = rows.get(item.requestId);
    return row?.assetId ? '/api/photos/assets/'+encodeURIComponent(row.assetId)+'/thumbnail?size=preview'
      : '/api/phone-media/preview/'+encodeURIComponent(run)+'/'+encodeURIComponent(item.requestId);
  };
  function apply() {
    const filter = $('view-filter').value;
    visible = items.filter(item => filter === 'all'
      || (filter === 'image' && image(item)) || (filter === 'video' && video(item))
      || (filter === 'duplicate' && item.backup?.disposition === 'duplicate')
      || (filter === 'review' && item.review.choice === 'review')
      || (filter === 'frame' && suggested(rows.get(item.requestId))));
    for (const item of items) {
      const card = document.querySelector('[data-request-id="'+item.requestId+'"]');
      if (card) card.hidden = !visible.includes(item);
    }
    $('view-count').textContent = `${visible.length} affiché${visible.length > 1 ? 's' : ''} · ${items.length} sur cette page`;
    $('filter-empty').hidden = !items.length || visible.length > 0;
    $('compare-open').textContent = `Comparer (${compared.size}/4)`;
    $('compare-open').disabled = compared.size < 2;
    $('compare-clear').hidden = !compared.size;
    document.querySelectorAll('.compare-toggle').forEach(button => {
      const selected = compared.has(button.dataset.id);
      button.setAttribute('aria-pressed', String(selected));
      button.textContent = selected ? '✓ À comparer' : 'Comparer';
    });
  }
  function stopMedia() {
    $('viewer-content').querySelectorAll('video').forEach(el => { el.pause(); el.removeAttribute('src'); el.load(); });
    $('viewer-content').replaceChildren();
  }
  function media(item) {
    const row = rows.get(item.requestId), figure = node('figure'), caption = node('figcaption');
    const stage = node('div', undefined, 'viewer-stage');
    const unavailable = node('p', video(item)
      ? 'Lecture indisponible. La vidéo doit être indexée dans Immich et prête pour la lecture. Actualise la galerie après le traitement.'
      : 'Aperçu indisponible pour ce format ou cette taille. La sauvegarde reste consultable dans son état d’import.', 'media-unavailable');
    unavailable.hidden = true;
    const fail = () => { unavailable.hidden = false; };
    if (video(item) && row?.assetId) {
      const el = node('video'); el.controls = true; el.preload = 'metadata'; el.playsInline = true;
      el.setAttribute('aria-label', 'Lire '+item.name);
      el.src = '/api/photos/assets/'+encodeURIComponent(row.assetId)+'/video';
      el.addEventListener('error', fail); stage.append(el);
    } else if (image(item) && item.backup) {
      const el = node('img'); el.alt = item.name; el.src = preview(item);
      el.addEventListener('error', () => { el.hidden = true; fail(); }); stage.append(el);
    } else { unavailable.hidden = false; }
    stage.append(unavailable);
    caption.append(node('strong', item.name), node('p', item.relativePath, 'muted'));
    caption.append(node('span', item.backup?.disposition === 'duplicate' ? 'Contenu identique déjà sur Media' : item.backup ? 'Copie reçue sur Media' : 'Sauvegarde en attente', 'badge'));
    if (item.backup) {
      const proof = node('details'); proof.append(node('summary', 'Preuve de sauvegarde'),
        node('p', 'SHA-256 : '+item.backup.sha256), node('p', 'Vérification reçue : '+item.backup.verifiedAt));
      caption.append(proof);
    }
    const exif = row?.metadata?.exif || {};
    const dimensions = [exif.exifImageWidth, exif.exifImageHeight].filter(Boolean).join(' × ');
    if (exif.dateTimeOriginal) caption.append(node('p', 'Prise de vue (EXIF) : '+exif.dateTimeOriginal, 'muted'));
    if (dimensions) caption.append(node('p', dimensions+' px', 'muted'));
    const description = row?.review?.approved ? row.review.description : row?.analysis?.card?.proposal?.description;
    if (description) {
      const details = node('details'); details.append(node('summary', row.review?.approved ? 'Description relue' : 'Description proposée · à relire'), node('p', description)); caption.append(details);
    }
    if (image(item)) caption.append(node('p', row?.frame?.selected ? '✓ Dans le Cadre Photo' : suggested(row) ? 'Cadre suggéré · ajout à choisir dans la fiche' : 'Aucun ajout au cadre', 'muted'));
    const choose = node('button', 'Ouvrir cette fiche dans la galerie');
    choose.addEventListener('click', () => {
      $('media-viewer').close();
      const card = document.querySelector('[data-request-id="'+item.requestId+'"]');
      if (card) {
        card.scrollIntoView({ block: 'center' });
        (card.querySelector('.photo-analysis > button') || card.querySelector('select'))?.focus({ preventScroll: true });
      }
    });
    caption.append(choose);
    figure.append(stage, caption); return figure;
  }
  function show() {
    stopMedia();
    const list = mode === 'compare' ? items.filter(item => compared.has(item.requestId)) : visible;
    if (!list.length) { $('media-viewer').close(); return; }
    current = list.find(item => item.requestId === current?.requestId) || list[0];
    $('viewer-mode').textContent = mode === 'compare' ? 'COMPARAISON · À TOI DE CHOISIR' : video(current) ? 'VIDÉO' : 'APERÇU PHOTO';
    $('viewer-title').textContent = mode === 'compare' ? `${list.length} prises côte à côte` : current.name;
    $('viewer-context').textContent = mode === 'compare'
      ? 'La ressemblance ne prouve pas un doublon. Comparer ne change ni le cadre, ni le tri, ni la sélection de retrait.'
      : 'Copie sauvegardée · utilise les flèches pour parcourir cette page. Échap pour fermer.';
    $('viewer-content').className = mode === 'compare' ? 'comparison-grid' : 'single-media';
    $('viewer-content').append(...(mode === 'compare' ? list : [current]).map(media));
    const index = list.indexOf(current);
    $('viewer-count').textContent = mode === 'compare' ? '' : `${index + 1} / ${list.length}`;
    $('viewer-previous').disabled = mode === 'compare' || index <= 0;
    $('viewer-next').disabled = mode === 'compare' || index >= list.length - 1;
    if (!$('media-viewer').open) $('media-viewer').showModal();
  }
  function navigate(delta) {
    if (mode !== 'single') return;
    const next = visible[visible.indexOf(current) + delta];
    if (next) { current = next; show(); }
  }
  function setPage(runId, next) {
    if (run !== runId || items.map(x => x.requestId).join() !== next.map(x => x.requestId).join()) {
      rows.clear(); compared.clear(); $('media-viewer').close();
    }
    run = runId; items = next;
    for (const item of items) {
      const card = document.querySelector('[data-request-id="'+item.requestId+'"]');
      if (!card) continue;
      const picture = card.querySelector('.picture');
      picture.dataset.kind = video(item) ? 'video' : 'image';
      picture.setAttribute('aria-label', (video(item) ? 'Voir la vidéo ' : 'Agrandir ')+item.name);
      picture.addEventListener('click', () => { current = item; mode = 'single'; show(); });
      const compare = node('button', 'Comparer', 'compare-toggle'); compare.dataset.id = item.requestId;
      compare.disabled = companion(item) || !item.backup;
      compare.setAttribute('aria-label', 'Comparer '+item.name);
      compare.addEventListener('click', () => {
        if (compared.has(item.requestId)) compared.delete(item.requestId);
        else if (compared.size < 4) compared.add(item.requestId);
        else { $('view-count').textContent = 'Quatre médias maximum. Retire une prise de la comparaison pour en choisir une autre.'; return; }
        apply();
      });
      card.querySelector('.card-body').append(compare);
    }
    apply();
  }
  $('view-filter').addEventListener('change', apply);
  $('compare-open').addEventListener('click', () => { mode = 'compare'; show(); });
  $('compare-clear').addEventListener('click', () => { compared.clear(); apply(); });
  $('viewer-close').addEventListener('click', () => $('media-viewer').close());
  $('media-viewer').addEventListener('close', stopMedia);
  $('viewer-previous').addEventListener('click', () => navigate(-1));
  $('viewer-next').addEventListener('click', () => navigate(1));
  $('media-viewer').addEventListener('keydown', event => {
    if (/INPUT|TEXTAREA|VIDEO|SUMMARY/.test(event.target.tagName)) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1); }
  });
  window.PhoneGallery = { setPage, update(row) {
    rows.set(row.requestId, row);
    const item = items.find(item => item.requestId === row.requestId);
    const picture = document.querySelector('[data-request-id="'+row.requestId+'"] .picture');
    if (picture && item) {
      picture.dataset.kind = video(item) ? 'video' : 'image';
      picture.setAttribute('aria-label', (video(item) ? 'Voir la vidéo ' : 'Agrandir ')+item.name);
    }
    apply();
  }, refresh: apply };
})();
