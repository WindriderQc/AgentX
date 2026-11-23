(function () {
  'use strict';
  const CONTRACT = 'agentx.history-human-semantic-review/v1';
  const BASE = '/api/secretary/history/semantic-reviews';
  const KEY = 'history-human-semantic-review:v1';
  const HASH = /^[a-f0-9]{64}$/;
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const states = ['preparing', 'prepared', 'deciding', 'accepted', 'held', 'blocked'];
  const terminal = state => ['accepted', 'held', 'blocked'].includes(state);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const invalid = () => Error('La réponse ne correspond pas à la revue sémantique originale. Retrouvez son reçu sans renvoyer la décision.');
  const storageError = () => Error('Le journal de reprise de la revue sémantique est indisponible ou a changé. Aucune écriture n’est envoyée.');
  const labels = { original: 'Original du message (.eml)', attachment: 'Pièce jointe originale',
    analysis: 'Sources paginées et analyses enregistrées', compound_member: 'Document contenu dans une pièce jointe' };
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const sha = async bytes => [...new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');

  window.mountHistorySemanticReview = function ({ container, api, esc, getManifest, isAvailable = () => true }) {
    const manifest = getManifest();
    if (!manifest || manifest.state !== 'confirmed' || !UUID.test(manifest.requestId || '')) return { refresh() {} };
    const input = { manifestRequestId: manifest.requestId, checks: JSON.parse(JSON.stringify(manifest.input.checks)), before: manifest.input.before };
    const key = `${KEY}:${manifest.requestId}`;
    let journal = null, stored = null, receipt = null, preview = null, busy = false, error = '', unreadable = false, reviewed = false;
    const downloaded = new Map();
    try {
      stored = localStorage.getItem(key); journal = stored ? JSON.parse(stored) : null;
      if (journal && (!UUID.test(journal.requestId || '') || !states.includes(journal.phase)
        || !same(journal.input, input) || (journal.bindingSha256 !== null && !HASH.test(journal.bindingSha256 || ''))
        || (journal.inputSha256 !== null && !HASH.test(journal.inputSha256 || ''))
        || (journal.decision !== null && !['accepted_selected_semantics', 'held_ambiguous'].includes(journal.decision)))) throw storageError();
    } catch { unreadable = true; error = storageError().message; }

    function save(value, fresh = false) {
      try {
        if (unreadable || localStorage.getItem(key) !== stored) throw storageError();
        if (journal && !fresh && (value.requestId !== journal.requestId || !same(value.input, journal.input)
          || (journal.bindingSha256 && value.bindingSha256 !== journal.bindingSha256)
          || (journal.inputSha256 && value.inputSha256 !== journal.inputSha256)
          || (journal.decision && value.decision !== journal.decision))) throw storageError();
        if (fresh && journal && (!terminal(journal.phase) || !journal.acknowledged)) throw storageError();
        if (fresh && journal) {
          const archive = `${key}:${journal.requestId}`; localStorage.setItem(archive, stored);
          if (localStorage.getItem(archive) !== stored) throw storageError();
        }
        const encoded = JSON.stringify(value); localStorage.setItem(key, encoded);
        if (localStorage.getItem(key) !== encoded) throw storageError();
        stored = encoded; journal = value;
      } catch { throw storageError(); }
    }
    function sourcePreview(value) {
      const sources = value?.sources;
      if (!Array.isArray(sources) || sources.length !== input.checks.length || !Array.isArray(value.blockers)
        || sources.some((source, index) => !same(canonical(source.reference), canonical(input.checks[index].source))
          || !Array.isArray(source.resources) || !source.resources.length || source.resources.length > 256
          || source.resources.some(resource => !Object.hasOwn(labels, resource.kind) || typeof resource.key !== 'string'
            || resource.key.length > 128 || !HASH.test(resource.sha256 || '') || !Number.isSafeInteger(resource.bytes)
            || resource.bytes < 0 || resource.bytes > 16 * 1024 * 1024))) throw invalid();
      return value;
    }
    function accept(value, { allowPreview = false, keepPreview = false } = {}) {
      if (!value || value.contract !== CONTRACT || value.requestId !== journal.requestId || !states.includes(value.state)
        || value.authenticatedPerson !== null || value.semanticAcceptance !== false || value.approvalBound !== false
        || value.executionAllowed !== false || value.cleanupStatus !== 'blocked' || value.mailboxEffects !== 0
        || !HASH.test(value.inputSha256 || '') || (journal.inputSha256 && value.inputSha256 !== journal.inputSha256)
        || (value.bindingSha256 !== null && !HASH.test(value.bindingSha256 || ''))
        || (journal.bindingSha256 && value.bindingSha256 !== journal.bindingSha256)
        || (value.state === 'accepted' && journal.decision && journal.decision !== 'accepted_selected_semantics')
        || (value.state === 'held' && journal.decision && journal.decision !== 'held_ambiguous')) throw invalid();
      const phase = journal.phase === 'deciding' && !terminal(value.state) ? 'deciding' : value.state;
      const nextPreview = allowPreview && phase === 'prepared' && value.nativeState === 'observed'
        && HASH.test(value.bindingSha256 || '') && value.preview ? sourcePreview(value.preview) : null;
      save({ ...journal, phase, inputSha256: journal.inputSha256 || value.inputSha256,
        bindingSha256: journal.bindingSha256 || value.bindingSha256 });
      receipt = value;
      if (nextPreview) preview = nextPreview;
      else if (!keepPreview || phase !== 'prepared') preview = null;
      if (phase !== 'prepared') { downloaded.clear(); reviewed = false; }
    }
    async function reconcile() {
      preview = null; reviewed = false; downloaded.clear();
      try { accept(await api(`${BASE}/${encodeURIComponent(journal.requestId)}`)); }
      catch (cause) { error = `${cause.message} Le résultat reste inconnu ; une réponse 404 ne clôt pas l’écriture originale.`; }
    }
    async function write(url, body, phase) {
      save({ ...journal, phase });
      preview = null; reviewed = false; downloaded.clear();
      try { accept(await api(url, { method: 'POST', body: JSON.stringify(body) }), { allowPreview: true }); }
      catch { error = 'Réponse incertaine. Seul le reçu original est relu ; aucune décision n’est répétée.'; await reconcile(); }
    }
    const url = suffix => `${BASE}/${encodeURIComponent(journal.requestId)}/${suffix}`;
    const allResources = () => (preview?.sources || []).flatMap((source, i) => source.resources.map((resource, j) => ({ source: i, resource: j, descriptor: resource })));
    const complete = () => receipt?.coverage?.complete === true && allResources().length > 0
      && allResources().every(item => downloaded.has(`${item.source}:${item.resource}`));
    async function read(source, resource) {
      if (journal.phase !== 'prepared' || !preview) return;
      const descriptor = preview.sources[source]?.resources[resource]; if (!descriptor) throw invalid();
      downloaded.delete(`${source}:${resource}`); reviewed = false;
      const chunks = []; let offset = 0;
      // A re-opened resource starts at zero even if an earlier delivery was acknowledged.
      // The server permits exact re-reads; no missing response is counted as reviewed.
      while (true) {
        save({ ...journal, pendingRead: { source, resource, offset } });
        let result;
        try { result = await api(url('read'), { method: 'POST', body: JSON.stringify({ ...input, source, resource, offset }) }); }
        catch { preview = null; downloaded.clear(); reviewed = false;
          error = 'Lecture incertaine. Retrouvez le reçu puis rouvrez cette même revue ; le téléchargement repartira du début.';
          await reconcile(); return;
        }
        accept(result?.receipt, { keepPreview: true });
        const page = result?.page;
        if (!preview || journal.phase !== 'prepared' || !page || page.source !== source || page.resource !== resource || page.offset !== offset
          || typeof page.contentBase64 !== 'string' || !HASH.test(page.chunkSha256 || '')) throw invalid();
        let bytes;
        try { bytes = Uint8Array.from(atob(page.contentBase64), char => char.charCodeAt(0)); }
        catch { throw invalid(); }
        if (bytes.length > 32768 || offset + bytes.length > descriptor.bytes || await sha(bytes) !== page.chunkSha256
          || (page.nextOffset === null ? offset + bytes.length !== descriptor.bytes
            : page.nextOffset !== offset + bytes.length || bytes.length === 0 || page.nextOffset >= descriptor.bytes)) throw invalid();
        chunks.push(bytes); offset += bytes.length;
        if (page.nextOffset === null) break;
      }
      const bytes = new Uint8Array(descriptor.bytes); let copied = 0;
      for (const chunk of chunks) { bytes.set(chunk, copied); copied += chunk.length; }
      if (await sha(bytes) !== descriptor.sha256) throw invalid();
      const text = descriptor.kind === 'analysis' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null;
      downloaded.set(`${source}:${resource}`, { bytes, text }); reviewed = false;
      save({ ...journal, pendingRead: null });
    }
    function download(source, resource) {
      const item = downloaded.get(`${source}:${resource}`), descriptor = preview?.sources[source]?.resources[resource];
      if (!item || !descriptor) return;
      const blob = new Blob([item.bytes], { type: 'application/octet-stream' });
      const address = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = address; anchor.download = `source-${source + 1}-${resource + 1}${descriptor.kind === 'original' ? '.eml' : descriptor.kind === 'analysis' ? '.json' : '.bin'}`;
      anchor.rel = 'noopener'; anchor.click(); setTimeout(() => URL.revokeObjectURL(address), 1000);
    }
    const statuses = { preparing: 'Préparation en attente ; retrouvez le reçu original.', prepared: 'Revue préparée. Chaque original, pièce jointe et analyse doit être ouvert et examiné.',
      deciding: 'Décision en attente ou incertaine. Retrouvez uniquement son reçu original.', accepted: 'Validation sémantique humaine enregistrée. Ce jugement historique doit être revérifié nativement avant toute utilisation.',
      held: 'Sélection laissée en attente : une ambiguïté ou une source illisible empêche sa validation.', blocked: 'Cette revue est bloquée ; son identité originale reste conservée.' };
    function render() {
      if (!container.isConnected) return;
      const disabled = busy || unreadable || !isAvailable();
      container.innerHTML = `<section class="history-manifest" aria-label="Validation sémantique humaine"><h3>Valider le sens des sources et analyses</h3>
        <p>Cette décision humaine est distincte de la revue du manifeste. Elle porte sur les originaux et les analyses exactes de la sélection, sans personne authentifiée sur le réseau privé. Aucun nettoyage ni effet Gmail n’est autorisé.</p>
        <p>Les pages servies prouvent leur livraison. Vous devez réellement examiner les documents, vérifier les analyses et laisser en attente toute source illisible, lien nécessaire non consulté ou ambiguïté.</p>
        <button type="button" data-semantic-prepare${disabled || (journal && !journal.acknowledged) ? ' disabled' : ''}>Préparer la revue sémantique de ce manifeste</button>
        <p role="status" aria-live="polite" data-semantic-status>${esc(error || (journal ? statuses[journal.phase] : 'Préparez explicitement cette revue pour examiner les sources.'))}</p>
        ${journal ? `<details><summary>Identité de la revue et liaison exacte</summary><p>${esc(journal.requestId)}</p><p>${esc(journal.bindingSha256 || 'Liaison encore inconnue')}</p></details>
          <button type="button" data-semantic-reconcile${disabled ? ' disabled' : ''}>Retrouver le reçu de cette revue</button>
          ${journal.phase === 'prepared' && !preview && receipt && !journal.acknowledged ? `<button type="button" data-semantic-reopen${disabled ? ' disabled' : ''}>Rouvrir les sources exactes de cette revue</button>` : ''}
          ${receipt?.coverage ? `<p>Ressources intégralement servies : ${esc(receipt.coverage.servedResources)} / ${esc(receipt.coverage.resources)}. Cela ne prouve pas leur compréhension.</p>` : ''}
          ${receipt?.decidedAt ? `<p>Décision enregistrée le ${esc(receipt.decidedAt)}.</p>` : ''}
          ${terminal(journal.phase) && !journal.acknowledged ? `<button type="button" data-semantic-acknowledge${disabled ? ' disabled' : ''}>Conserver ce reçu et permettre une nouvelle revue explicite</button>` : ''}` : ''}
        ${preview && journal.phase === 'prepared' ? `<div data-semantic-preview>${preview.sources.map((source, i) => `<section><h4>Source ${i + 1}</h4><p>Message ${esc(source.reference.messageId)} · empreinte ${esc(source.reference.sourceSha256)}</p>
          ${source.resources.map((descriptor, j) => { const value = downloaded.get(`${i}:${j}`); return `<section><p>${esc(labels[descriptor.kind])} · ${esc(descriptor.key)} · ${esc(descriptor.bytes)} octets</p>
            <button type="button" data-semantic-read="${i}:${j}"${disabled ? ' disabled' : ''}>Charger et vérifier cette ressource</button>
            ${value ? `<button type="button" data-semantic-download="${i}:${j}"${disabled ? ' disabled' : ''}>Télécharger les octets vérifiés</button>${value.text !== null ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere" data-semantic-analysis>${esc(value.text)}</pre>` : '<p>Octets vérifiés. Téléchargez puis examinez ce document avec un lecteur adapté ; toute impossibilité de lecture doit rester en attente.</p>'}` : ''}</section>`; }).join('')}</section>`).join('')}
          ${preview.blockers.length ? `<p>Des réserves natives empêchent la validation de cette sélection.</p><ul>${preview.blockers.map(code => `<li>${esc(code)}</li>`).join('')}</ul>` : ''}
          <label class="history-pick"><input type="checkbox" data-semantic-reviewed${reviewed ? ' checked' : ''}${disabled || !complete() || preview.blockers.length ? ' disabled' : ''}> J’ai examiné les originaux, toutes les pièces et les analyses affichées. Leur sens et leurs informations pertinentes sont correctement représentés ; aucune ambiguïté ni lecture nécessaire ne reste ouverte.</label>
          <button type="button" data-semantic-accept${disabled || !reviewed || !complete() || preview.blockers.length ? ' disabled' : ''}>Enregistrer cette validation sémantique humaine</button>
          <button type="button" data-semantic-hold${disabled ? ' disabled' : ''}>Laisser en attente : source illisible ou sens ambigu</button></div>` : ''}</section>`;
    }
    async function action(run) {
      if (busy || unreadable || !isAvailable()) return;
      busy = true; error = ''; render();
      try { await run(); } catch (cause) { error = cause.message; }
      finally { busy = false; render(); }
    }
    container.addEventListener('change', event => {
      if (event.target.matches('[data-semantic-reviewed]')) { reviewed = event.target.checked && complete() && preview?.blockers.length === 0; render(); }
    });
    container.addEventListener('click', event => {
      if (event.target.disabled) return;
      if (event.target.matches('[data-semantic-prepare]')) void action(async () => {
        if (journal && !journal.acknowledged) return;
        save({ requestId: window.crypto.randomUUID(), input, bindingSha256: null, inputSha256: null, phase: 'preparing', decision: null }, true);
        await write(`/api/secretary/history/manifest-confirmations/${encodeURIComponent(input.manifestRequestId)}/semantic-reviews`,
          { requestId: journal.requestId, checks: input.checks, before: input.before }, 'preparing');
      });
      if (event.target.matches('[data-semantic-reconcile]')) void action(reconcile);
      if (event.target.matches('[data-semantic-reopen]')) void action(async () => {
        if (journal.phase !== 'prepared' || journal.acknowledged || !receipt) return;
        await write(url('reopen'), input, 'prepared');
      });
      if (event.target.matches('[data-semantic-read]')) void action(async () => {
        const [source, resource] = event.target.dataset.semanticRead.split(':').map(Number); await read(source, resource);
      });
      if (event.target.matches('[data-semantic-download]')) {
        const [source, resource] = event.target.dataset.semanticDownload.split(':').map(Number); download(source, resource);
      }
      for (const [selector, decision] of [['data-semantic-accept', 'accepted_selected_semantics'], ['data-semantic-hold', 'held_ambiguous']]) {
        if (event.target.matches(`[${selector}]`)) void action(async () => {
          if (journal.phase !== 'prepared' || !preview || (decision === 'accepted_selected_semantics'
            && (!reviewed || !complete() || preview.blockers.length))) return;
          save({ ...journal, decision });
          await write(url('decide'), { ...input, bindingSha256: journal.bindingSha256, decision }, 'deciding');
        });
      }
      if (event.target.matches('[data-semantic-acknowledge]')) void action(async () => {
        if (!terminal(journal.phase)) return;
        save({ ...journal, acknowledged: true }); preview = null; downloaded.clear(); reviewed = false;
      });
    });
    render(); return { refresh: render };
  };
})();
