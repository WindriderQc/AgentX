/* Existing cards only. Browsing has no enqueue, resume, scan or cleanup action. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const filters = ['all', 'suggested', 'frame', 'review', 'reviewed', 'privacy'];
  const orders = ['recent', 'oldest', 'taken', 'quality'];
  const qualities = ['all', 'bonne', 'moyenne', 'faible', 'inconnue'];
  let query, result, generation = 0, busy = false, controlRevision = -1;
  const compared = new Map();
  function fromUrl() {
    const p = new URL(location.href).searchParams;
    return { filter: filters.includes(p.get('filter')) ? p.get('filter') : 'all', search: (p.get('search') || '').slice(0, 120),
      quality: qualities.includes(p.get('quality')) ? p.get('quality') : 'all', order: orders.includes(p.get('order')) ? p.get('order') : 'recent',
      offset: Math.trunc(Math.min(1000000, Math.max(0, Number(p.get('offset')) || 0))), limit: 60 };
  }
  async function call(input) {
    const response = await fetch('/api/phone-media/processing', { method: 'POST', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const value = await response.json();
    if (!response.ok || !value.ok) throw Object.assign(new Error('La demande n’a pas pu être confirmée. Actualise ou reprends la même décision.'), { status: response.status, code: value.code });
    return value.data;
  }
  function image(row, className) {
    const wrap = el('div', undefined, className), img = el('img');
    img.src = '/api/photos/assets/'+encodeURIComponent(row.assetId)+'/thumbnail';
    img.alt = row.review?.approved ? row.review.description : row.proposal.description;
    img.loading = 'lazy'; img.decoding = 'async';
    img.addEventListener('error', () => wrap.replaceChildren(el('p', 'Aperçu indisponible · la fiche reste consultable', 'image-missing')));
    wrap.append(img); return wrap;
  }
  function control(state) {
    if (state && Number.isSafeInteger(state.revision)) {
      if (state.revision < controlRevision) return;
      controlRevision = state.revision;
    }
    const note = $('analysis-control'); note.replaceChildren(); note.classList.toggle('unknown', !state);
    note.append(el('strong', !state ? 'État des analyses indisponible' : state.paused ? 'Analyses en pause' : 'Analyses autorisées'));
    note.append(el('span', !state ? 'Réessaie pour vérifier la pause. La consultation ne lance aucune analyse.'
      : state.paused ? (state.inFlight?.length ? 'Les travaux déjà admis finissent. Tu peux consulter et choisir tes images.' : 'Aucun traitement photo en cours. Tu peux consulter, relire et choisir pour le cadre.')
        : 'La consultation utilise les résultats existants, sans lancer de traitement supplémentaire.'));
  }
  function controls() {
    $('global-search').value = query.search; $('global-quality').value = query.quality; $('global-order').value = query.order;
    for (const button of $('library-tabs').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.filter === query.filter));
  }
  function remember(push) {
    const url = new URL(location.href); url.search = '';
    for (const [key, value] of Object.entries(query)) if (key !== 'limit' && value && !(key === 'filter' && value === 'all')
      && !(key === 'quality' && value === 'all') && !(key === 'order' && value === 'recent')) url.searchParams.set(key, value);
    history[push ? 'pushState' : 'replaceState']({}, '', url);
  }
  function selection() {
    const tray = $('comparison-tray'); tray.hidden = !compared.size;
    $('comparison-count').textContent = compared.size+' / 4 images'; $('show-comparison').disabled = compared.size < 2;
    $('comparison-items').replaceChildren();
    for (const row of compared.values()) {
      const remove = el('button'); remove.setAttribute('aria-label', 'Retirer de la comparaison : '+row.proposal.description);
      remove.append(image(row)); remove.addEventListener('click', () => toggle(row)); $('comparison-items').append(remove);
    }
    for (const card of $('global-cards').children) {
      const selected = compared.has(card.dataset.sha256), button = card.querySelector('.compare-photo');
      card.dataset.compared = String(selected); button.setAttribute('aria-pressed', String(selected));
      button.textContent = selected ? '✓ À comparer' : 'Comparer'; button.disabled = !selected && compared.size >= 4;
    }
  }
  function toggle(row) { if (compared.has(row.sha256)) compared.delete(row.sha256); else if (compared.size < 4) compared.set(row.sha256, row); selection(); }
  function card(row) {
    const box = el('article', undefined, 'global-photo'); box.dataset.sha256 = row.sha256;
    const open = el('button', undefined, 'photo-open'); open.setAttribute('aria-label', 'Ouvrir la fiche : '+row.proposal.description);
    open.append(image(row)); open.addEventListener('click', () => detail.open(row, open)); box.append(open);
    const copy = el('div', undefined, 'photo-copy'), badges = el('div', undefined, 'photo-badges');
    badges.append(el('span', row.frame?.selected ? '✓ Dans le cadre' : row.proposal.frameSuitability === 'oui' ? 'Cadre suggéré' : 'Choix libre'));
    if (row.proposal.privacyReview) badges.append(el('span', 'Contenu à vérifier', 'privacy'));
    if (row.review?.approved) badges.append(el('span', '✓ Fiche relue'));
    const text = row.review?.approved ? row.review.description : row.proposal.description;
    copy.append(badges, el('h3', text || 'Image analysée'));
    const exif = row.metadata?.exif || {}, date = exif.dateTimeOriginal?.slice(0, 10);
    copy.append(el('p', [date, exif.city || exif.country, 'Qualité '+row.proposal.quality].filter(Boolean).join(' · '), 'photo-meta'));
    const actions = el('div', undefined, 'photo-actions'), read = el('button', 'Ouvrir la fiche'), compare = el('button', 'Comparer', 'compare-photo');
    read.addEventListener('click', () => detail.open(row, read)); compare.addEventListener('click', () => toggle(row));
    actions.append(read, compare); copy.append(actions); box.append(copy); return box;
  }
  function render(value) {
    for (const row of value.results) {
      // Keep an unacknowledged browser intent visible even if its request never
      // reached Core. The next click reconciles that same identity and values.
      try {
        const saved = JSON.parse(sessionStorage.getItem('phone-photo.global.'+row.sha256) || 'null');
        if (!row.pendingDecision && saved?.sha256 === row.sha256 && ['frame','review'].includes(saved.op)) {
          row.pendingDecision = true; row.pendingIntent = { writeId: saved.writeId, kind: saved.op, expectedRevision: saved.expectedRevision,
            value: Object.fromEntries(Object.entries(saved).filter(([key]) => !['op','sha256','writeId','expectedRevision'].includes(key))) };
        }
      } catch { /* Core's own pending decision remains authoritative. */ }
    }
    result = value; control(value.control);
    for (const key of ['total', 'suggested', 'review', 'frame']) $(key+'-count').textContent = value.summary[key].toLocaleString('fr-CA');
    for (const badge of document.querySelectorAll('[data-count]')) badge.textContent = value.summary[badge.dataset.count].toLocaleString('fr-CA');
    $('library-status').textContent = value.total ? (query.offset+1)+'–'+Math.min(query.offset+value.results.length, value.total)+' sur '+value.total.toLocaleString('fr-CA')+(value.total === 1 ? ' image' : ' images')
      : 'Aucune image dans cette vue';
    const grid = $('global-cards'); grid.replaceChildren(...value.results.map(card));
    for (const row of value.results) if (compared.has(row.sha256)) compared.set(row.sha256, row);
    selection();
    $('library-empty').hidden = value.results.length > 0;
    $('empty-title').textContent = !value.configured ? 'La photothèque attend sa configuration' : value.summary.total ? 'Aucune image avec ces filtres' : 'Les premières fiches apparaîtront ici';
    $('empty-message').textContent = value.summary.total ? 'Essaie une autre recherche ou reviens à toutes les images analysées.' : 'Cette vue affiche uniquement les images déjà analysées. Elle ne démarre aucun traitement.';
    $('empty-reset').hidden = !value.summary.total;
    const pages = Math.max(1, Math.ceil(value.total/query.limit));
    $('jump-page').value = Math.floor(query.offset/query.limit)+1; $('jump-page').max = pages;
    $('global-page-count').textContent = 'sur '+pages; $('global-previous').disabled = !query.offset;
    $('global-next').disabled = query.offset+value.results.length >= value.total;
    detail.update(value);
  }
  async function load({ push = false, reset = false } = {}) {
    const own = ++generation; busy = true; controls(); remember(push);
    $('global-cards').setAttribute('aria-busy', 'true'); $('library-error').hidden = true;
    $('library-status').textContent = 'Recherche dans toute la collection…';
    try {
      const value = await call({ op: 'library', ...query });
      if (own !== generation) return;
      if (value.total && query.offset >= value.total) { query.offset = Math.floor((value.total-1)/query.limit)*query.limit; return load(); }
      if (!value.total && query.offset) { query.offset = 0; remember(false); }
      render(value);
      if (reset) $('collection').scrollIntoView({ behavior: 'instant', block: 'start' });
    } catch {
      if (own !== generation) return;
      // Old results never masquerade as a successful result for the new filters.
      $('global-cards').replaceChildren(); $('library-empty').hidden = true; $('library-error').hidden = false;
      $('library-error-message').textContent = 'La collection n’a pas pu être chargée. Tes décisions et tes images sont conservées.';
      $('library-status').textContent = 'Résultats indisponibles'; control(null); $('global-next').disabled = $('global-previous').disabled = true;
      for (const key of ['total', 'suggested', 'review', 'frame']) $(key+'-count').textContent = '—';
      for (const badge of document.querySelectorAll('[data-count]')) badge.textContent = '—';
    } finally { if (own === generation) { busy = false; $('global-cards').setAttribute('aria-busy', 'false'); } }
  }
  async function decide(row, kind, value) {
    const key = 'phone-photo.global.'+row.sha256;
    const pending = row.pendingIntent, stored = sessionStorage.getItem(key);
    const input = pending ? { op: pending.kind, sha256: row.sha256, writeId: pending.writeId,
      expectedRevision: pending.expectedRevision, ...pending.value } : stored ? JSON.parse(stored)
      : { op: kind, sha256: row.sha256, writeId: crypto.randomUUID(), expectedRevision: row[kind]?.revision || 0, ...value };
    if (input.op !== kind) throw Error('Reprends d’abord la décision en attente dans cette fiche.');
    sessionStorage.setItem(key, JSON.stringify(input));
    try {
      const decision = await call(input); row[kind] = decision; delete row.pendingIntent; delete row.pendingDecision;
      sessionStorage.removeItem(key);
      if (compared.has(row.sha256)) compared.set(row.sha256, row);
      await load(); return decision;
    } catch (error) {
      if (error.status === 400 && /INVALID/.test(error.code || '')) sessionStorage.removeItem(key);
      else { row.pendingDecision = true; row.pendingIntent = { kind, writeId: input.writeId, expectedRevision: input.expectedRevision,
        value: Object.fromEntries(Object.entries(input).filter(([k]) => !['op','sha256','writeId','expectedRevision'].includes(k))) }; }
      throw error;
    }
  }
  const detail = window.PhotoLibraryDetail.create({ $, el, image, decide, rows: () => result?.results || [] });
  query = fromUrl(); controls();
  $('library-tabs').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (button) { query.filter = button.dataset.filter; query.offset = 0; load({ push: true }); } });
  $('library-search').addEventListener('submit', event => { event.preventDefault(); query.search = $('global-search').value;
    query.quality = $('global-quality').value; query.order = $('global-order').value; query.offset = 0; load({ push: true }); });
  for (const id of ['global-quality','global-order']) $(id).addEventListener('change', () => $('library-search').requestSubmit());
  function reset() { query = { filter: 'all', search: '', quality: 'all', order: 'recent', offset: 0, limit: 60 }; load({ push: true }); }
  $('reset-filters').addEventListener('click', reset); $('empty-reset').addEventListener('click', reset);
  $('refresh-library').addEventListener('click', () => load()); $('retry-library').addEventListener('click', () => load());
  $('global-previous').addEventListener('click', () => { if (!busy) { query.offset = Math.max(0, query.offset-query.limit); load({ push: true, reset: true }); } });
  $('global-next').addEventListener('click', () => { if (!busy && result) { query.offset += query.limit; load({ push: true, reset: true }); } });
  $('jump-form').addEventListener('submit', event => { event.preventDefault(); if (!busy && result) {
    query.offset = (Math.min(Math.max(1, Number($('jump-page').value)||1), Math.max(1, Math.ceil(result.total/query.limit)))-1)*query.limit;
    load({ push: true, reset: true }); } });
  $('show-comparison').addEventListener('click', () => detail.compare([...compared.values()], $('show-comparison')));
  $('clear-comparison').addEventListener('click', () => { compared.clear(); selection(); });
  $('library-density').addEventListener('change', () => $('global-cards').classList.toggle('compact', $('library-density').value === 'compact'));
  window.addEventListener('popstate', () => { query = fromUrl(); load(); });
  // A failed status read is shown as unknown; never pretend a past pause is current.
  setInterval(() => { if (!document.hidden) call({ op: 'control' }).then(control).catch(() => control(null)); }, 30000);
  load();
})();
