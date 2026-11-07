(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = '/api/voice-personas/private/document-candidates';
  const labels = { staged: 'À revoir', selected: 'Sélectionné', dismissed: 'Mis de côté',
    dispatching: 'Résultat à vérifier', uncertain: 'Résultat non confirmé', promoted: 'Copie familiale enregistrée' };
  let current, busy = false, sourcesOffset = 0, candidatesOffset = 0;
  const status = text => { $('document-status').textContent = text; };
  async function api(suffix = '', body) {
    const response = await fetch(base + suffix, { credentials: 'same-origin', cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || 'Revue indisponible.');
    return payload.data;
  }
  async function act(work) {
    if (busy) return;
    busy = true;
    try { await work(); } catch (error) { status(error.message); }
    finally { busy = false; }
  }
  function button(text, action) {
    const element = document.createElement('button'); element.textContent = text;
    element.addEventListener('click', () => act(action)); return element;
  }
  function show(row) {
    current = row; $('document-detail').hidden = false;
    $('detail-heading').textContent = `${row.title} · ${labels[row.state] || row.state}`;
    $('document-text').textContent = row.text;
    const fields = { 'Classification de l’original': `${row.scope} / ${row.sensitivity}`, Archive: row.archiveId,
      Original: row.original ? `${row.original.root}/${row.original.relativePath}` : '', 'SHA-256': row.sha256,
      Révision: row.revision, 'Date du document': row.validFrom || 'Inconnue', 'Péremption': row.expiresAt || 'Non renseignée',
      'Fin de validité': row.invalidatedAt || 'Non renseignée', Références: JSON.stringify(row.sourceRefs), Étiquettes: row.tags.join(', ') };
    $('document-metadata').replaceChildren();
    for (const [label, value] of Object.entries(fields)) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value;
      $('document-metadata').append(dt, dd);
    }
    const editable = ['staged', 'selected', 'dismissed'].includes(row.state);
    $('document-select').disabled = !editable || !!row.blockedReason;
    $('document-dismiss').disabled = !editable;
    $('document-reviewer').value = row.selection?.reviewer || '';
    $('document-sharing').hidden = row.state !== 'selected';
    $('document-confirm').checked = false; $('document-promote').disabled = true;
    const audience = { family: 'conversation familiale', reader: 'Lecture', operator: 'espace personnel' };
    $('document-target').textContent = row.selection?.target ? `Copie approuvée dans « ${row.selection.target.source} », accessible à : ${row.selection.target.lanes.map(lane => audience[lane] || lane).join(', ')}. L’original garde sa classification.` : '';
    $('document-receipt').textContent = row.receipt ? `Copie familiale enregistrée. Son enregistrement a été vérifié le ${new Date(row.receipt.observedAt).toLocaleString('fr-CA')}. L’original est conservé. La qualité des réponses en conversation reste à vérifier.`
      : row.blockedReason ? 'Ce document est périmé ou remplacé ; il ne peut pas être partagé.'
        : row.requestId ? `Requête ${row.requestId} : résultat non confirmé. Actualisez pour vérifier ; aucun nouvel envoi automatique.` : '';
  }
  async function sources(offset = 0) {
    const data = await api(`/sources?offset=${offset}`);
    if (!offset) $('document-sources').replaceChildren();
    if (!data.configured) $('document-sources').textContent = 'Aucun export privé configuré. Aucun dossier n’est parcouru automatiquement.';
    for (const row of data.entries) {
      $('document-sources').append(button(`${row.title} · ${row.scope}/${row.sensitivity} · Préparer`, async () => {
        show(await api('', { sourceId: row.id })); await candidates(); status('Copie privée préparée pour votre revue.');
      }));
    }
    sourcesOffset = data.nextOffset; $('sources-more').hidden = sourcesOffset === null;
  }
  async function candidates(offset = 0) {
    const data = await api(`?offset=${offset}`);
    if (!offset) $('document-candidates').replaceChildren();
    for (const row of data.entries) $('document-candidates').append(button(`${row.title} · ${labels[row.state] || row.state}`, async () => show(await api(`/${row.id}`))));
    candidatesOffset = data.nextOffset; $('candidates-more').hidden = candidatesOffset === null;
  }
  for (const [id, decision] of [['document-select', 'select'], ['document-dismiss', 'dismiss']]) {
    $(id).addEventListener('click', () => act(async () => {
      show(await api(`/${current.id}/review`, { expectedRevision: current.revision, decision, reviewer: $('document-reviewer').value }));
      await candidates(); status(decision === 'select' ? 'Document sélectionné. Confirmez séparément son partage.' : 'Candidat conservé et mis de côté.');
    }));
  }
  $('document-confirm').addEventListener('change', () => { $('document-promote').disabled = !$('document-confirm').checked; });
  $('document-promote').addEventListener('click', () => act(async () => {
    if (!$('document-confirm').checked || current.state !== 'selected') return;
    // Store the identity before the first HTTP request, retaining it across a
    // page reload or lost response. A different request never retries an effect.
    const key = `household-share:${current.id}`;
    const requestId = current.requestId || localStorage.getItem(key) || crypto.randomUUID();
    localStorage.setItem(key, requestId);
    const row = await api(`/${current.id}/promote`, { expectedRevision: current.revision, requestId, confirmation: `SHARE ${current.id}` });
    show(row); await candidates(); status(row.state === 'promoted' ? 'Copie familiale enregistrée et vérifiée.' : 'Résultat non confirmé. Conservez cette requête.');
  }));
  $('document-refresh').addEventListener('click', () => act(async () => {
    if (!current) return;
    const row = await api(`/${current.id}`);
    // Reuse the exact intent to read/reconcile an existing dispatch, never to
    // initiate one. Server-side state retains the same durable fence.
    show(row.requestId && row.state !== 'promoted' ? await api(`/${row.id}/promote`, {
      expectedRevision: row.revision, requestId: row.requestId, confirmation: `SHARE ${row.id}` }) : row);
    await candidates();
  }));
  $('sources-more').addEventListener('click', () => act(() => sources(sourcesOffset)));
  $('candidates-more').addEventListener('click', () => act(() => candidates(candidatesOffset)));
  act(async () => { await sources(); await candidates(); });
})();
