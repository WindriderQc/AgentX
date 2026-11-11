(function () {
  'use strict';
  window.mountPersonalHistory = async function ({ app, api, esc }) {
    const kinds = { action: 'Action relevée', fact: 'Information à retenir', deliverable: 'Document ou élément attendu',
      invoice: 'Pièce comptable', calendar: 'Calendrier', contact: 'Contact' };
    const states = { candidate: 'À vérifier', retained: 'Conservé', resolved: 'Suivi clos', dismissed: 'Sans suite' };
    const assertions = { unknown: 'À préciser', reported: 'Rapporté par la source', planned: 'Prévu',
      confirmed: 'Confirmé', cancelled: 'Annulé', disputed: 'Contesté' };
    const directions = { received: 'Courriel reçu', sent: 'Courriel envoyé', draft: 'Brouillon non envoyé', unknown: 'Sens de l’échange à préciser' };
    const day = value => value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long' }).format(new Date(value)) : 'Date inconnue';
    app.innerHTML = `<section class="personal-history"><header><p class="card-kicker">PERSONNEL</p><h1>Revue des archives</h1>
      <p>Reprenez les sources du plus ancien au plus récent. Conservez ce qui compte et fermez les suivis à votre rythme.</p>
      <p class="muted">La date de la source et celle de l’événement sont présentées séparément. Chaque relevé reste à vérifier; un suivi conservé reste ouvert jusqu’à sa clôture.</p></header>
      <form data-history-filters class="history-filters"><label>Rechercher<input type="search" name="query" maxlength="300" placeholder="Un sujet ou une personne"></label>
      <label>À parcourir<select name="state"><option value="pending">À vérifier et suivis ouverts</option><option value="candidate">À vérifier</option><option value="retained">Conservés</option><option value="resolved">Suivis clos</option><option value="dismissed">Sans suite</option><option value="">Tout</option></select></label>
      <label>Type<select name="kind"><option value="">Tout</option>${Object.entries(kinds).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
      <label>Année de la source<input type="number" name="year" min="1990" max="2100" placeholder="Toutes"></label>
      <label>Souvenirs<select name="souvenir"><option value="">Tous les relevés</option><option value="not-kept">Pas encore gardés</option><option value="kept">Souvenirs gardés</option></select></label>
      <label class="history-page-size">Par page<select name="limit"><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label>
      <button type="submit">Afficher</button></form>
      <div class="history-batch row wrap" data-history-batch><button type="button" data-history-select-all>Tout sélectionner sur la page</button>
      <button type="button" data-history-keep-selected disabled>Garder la sélection comme souvenirs</button>
      <p class="muted" data-history-selection>Aucune information sélectionnée.</p></div><p data-history-status role="status" aria-live="polite"></p>
      <div data-history-list class="history-list"></div><nav class="row wrap" aria-label="Pages de l’histoire"><button type="button" data-history-prev>Précédents</button><button type="button" data-history-next>Suivants</button></nav></section>`;
    const get = name => app.querySelector(`[data-history-${name}]`);
    let rows = [], offset = 0, next = null, loading = false, epoch = 0;
    let maximum = 20;
    const selected = new Set();
    const sourceStates = new WeakMap();
    // An action is followed up and closed; the other kinds can become souvenirs.
    const canKeep = entry => entry.kind !== 'action' && !entry.souvenirNoteId;
    const lock = value => { loading = value; app.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = value; }); };
    const card = entry => `<article class="history-entry" data-entry="${esc(entry.id)}"><header><p class="card-kicker">${esc(kinds[entry.kind] || entry.kind)} · ${esc(states[entry.reviewState] || entry.reviewState)}</p>
      ${entry.souvenirNoteId ? '<p class="history-souvenir">Souvenir gardé dans votre mémoire</p>' : ''}
      ${canKeep(entry) ? `<label class="history-pick"><input type="checkbox" data-history-pick="${esc(entry.id)}"${selected.has(entry.id) ? ' checked' : ''}> Sélectionner pour garder comme souvenir</label>` : ''}
      <h2>${esc(entry.text)}</h2>${entry.people?.length ? `<p>Personnes associées, à vérifier : ${esc(entry.people.join(', '))}</p>` : `<p>${entry.actor ? `${['action', 'deliverable'].includes(entry.kind) ? 'Personne qui doit agir, selon le relevé' : 'Personne associée, à vérifier'} : ${esc(entry.actor)}` : 'Personne à préciser'}</p>`}
      ${entry.places?.length ? `<p>Lieux : ${esc(entry.places.join(', '))}</p>` : ''}${entry.relatedSources?.length ? `<p class="muted">Regroupe ${entry.relatedSources.length + 1} courriels sources; le souvenir les citera tous.</p>` : ''}</header>
      <dl><div><dt>Date de la source</dt><dd>${esc(day(entry.sourceDate))}</dd></div><div><dt>Date de l’événement</dt><dd>${entry.eventDate ? esc(entry.eventDatePrecision === 'day' ? entry.eventDate : day(entry.eventDate)) : 'À préciser'}${entry.eventDateAsWritten ? `<small>Dans la source : ${esc(entry.eventDateAsWritten)}</small>` : ''}</dd></div></dl>
      <p class="muted">${esc(entry.source?.system === 'gmail' ? directions[entry.source.direction] : 'Archive Outlook sélectionnée')} · ${esc(assertions[entry.assertionState])}</p>
      ${entry.gmailUrl ? `<a href="${esc(entry.gmailUrl)}" target="_blank" rel="noopener noreferrer">Consulter l’échange Gmail ↗</a>` : '<p class="muted">Source conservée dans l’archive locale.</p>'}
      ${entry.archiveUrl ? `<details data-history-source="${esc(entry.id)}"><summary>Lire la source sauvegardée</summary><p data-source-status role="status"></p><label data-source-version-label hidden>Version du texte<select data-source-version></select></label><p data-source-warning class="muted"></p><pre data-source-body></pre><details data-source-extra hidden><summary>Liens et autres données de cette version</summary><p>Les destinations sont affichées en texte. Les documents et ressources liés demandent leur propre collecte et leur propre lecture.</p><pre data-source-extra-body></pre><p data-source-extra-status class="muted"></p></details><p data-source-files class="muted"></p><button type="button" data-source-next hidden>Extrait suivant</button></details>` : ''}
      ${entry.sourceStatus ? `<details><summary>Interprétation enregistrée à l’extraction</summary><p>${esc(entry.sourceStatus)}</p></details>` : ''}
      ${entry.decision?.reason ? `<p class="history-decision">Dernière décision : ${esc(entry.decision.reason)}</p>` : ''}
      ${entry.sourceReview?.decision ? `<p>Revue des textes sources enregistrée le ${esc(day(entry.sourceReview.decision.at))}. ${entry.sourceReview.entryCurrent ? 'La disponibilité des sources sera vérifiée à la prochaine ouverture.' : 'Le relevé a changé depuis cette revue.'}</p>` : ''}
      <details data-history-source-review="${esc(entry.id)}"><summary>Revoir les textes sources et dater votre constat</summary>
      <p>Cette revue ne confirme pas le fait, ne clôt aucun suivi et n’autorise aucun nettoyage. Les documents et les parties non lues restent à examiner.</p>
      <button type="button" data-source-review-start>${entry.sourceReview ? 'Reprendre la revue enregistrée' : 'Préparer la revue des sources'}</button>
      <div data-source-review-content></div></details>
      <form data-history-review="${esc(entry.id)}"><label>Votre constat<textarea name="reason" rows="2" maxlength="2000" required placeholder="Ce que la source établit, ou pourquoi ce suivi est clos."></textarea></label>
      <div class="row wrap"><label>Date de l’événement, si établie<input name="eventDate" type="date" value="${entry.eventDatePrecision === 'day' ? esc(entry.eventDate) : ''}"></label>
      <label>Ce que la source permet d’établir<select name="assertionState">${Object.entries(assertions).map(([key, label]) => `<option value="${key}"${key === entry.assertionState ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <div class="row wrap"><button type="submit" value="retained">${['action', 'deliverable'].includes(entry.kind) ? 'Garder ce suivi ouvert' : 'Conserver dans mon histoire'}</button>
      ${['action', 'deliverable'].includes(entry.kind) ? '<button type="submit" value="resolved">Clore ce suivi</button>' : ''}<button type="submit" value="dismissed">Écarter</button>
      ${canKeep(entry) ? '<button type="submit" value="souvenir" formnovalidate>Garder comme souvenir</button>' : ''}</div></form></article>`;
    async function load() {
      const current = ++epoch;
      const filters = new FormData(get('filters'));
      lock(true); get('status').textContent = 'Lecture de votre histoire…';
      const params = new URLSearchParams({ limit: String(maximum), offset: String(offset) });
      maximum = Number(filters.get('limit')) || 20; params.set('limit', String(maximum));
      for (const [key, value] of filters) if (value && !['year', 'limit'].includes(key)) params.set(key, value);
      const year = Number(filters.get('year'));
      if (Number.isInteger(year) && year >= 1990 && year <= 2100) {
        params.set('since', `${year}-01-01T00:00:00Z`); params.set('before', `${year + 1}-01-01T00:00:00Z`);
      }
      try {
        const result = await api(`/api/secretary/history?${params}`);
        if (current !== epoch) return;
        rows = result.entries; next = result.nextOffset;
        for (const key of [...selected]) if (!rows.some(row => row.id === key && canKeep(row))) selected.delete(key);
        get('list').innerHTML = rows.length ? rows.map(card).join('') : '<p class="empty">Aucun relevé dans cette sélection.</p>';
        showSelection();
        get('status').textContent = `${result.total} relevé(s) · sources de la plus ancienne à la plus récente${rows.length ? ` · ${offset + 1}–${offset + rows.length}` : ''}`;
      } catch (error) { if (current === epoch) { get('list').replaceChildren(); get('status').textContent = 'La liste est indisponible. Utilisez Afficher pour la relire.'; } }
      finally {
        if (current === epoch) { lock(false); get('prev').disabled = offset === 0; get('next').disabled = next === null; showSelection(); }
      }
    }
    function showSelection() {
      get('selection').textContent = selected.size ? `${selected.size} information(s) sélectionnée(s) sur cette page.` : 'Aucune information sélectionnée.';
      get('keep-selected').disabled = loading || !selected.size;
      get('select-all').disabled = loading || !rows.some(canKeep);
    }
    const keep = (entry, extra = {}) => api(`/api/secretary/history/${encodeURIComponent(entry.id)}/souvenir`,
      { method: 'POST', body: JSON.stringify({ revision: entry.revision, ...extra }) });
    get('list').addEventListener('change', event => {
      const box = event.target.closest?.('[data-history-pick]');
      if (!box) return;
      if (box.checked) selected.add(box.dataset.historyPick); else selected.delete(box.dataset.historyPick);
      showSelection();
    });
    get('select-all').onclick = () => {
      if (loading) return;
      rows.filter(canKeep).forEach(row => selected.add(row.id));
      app.querySelectorAll('[data-history-pick]').forEach(box => { box.checked = true; });
      showSelection();
    };
    get('keep-selected').onclick = async () => {
      if (loading || !selected.size) return;
      const chosen = rows.filter(row => selected.has(row.id) && canKeep(row));
      const preview = chosen.slice(0, 5).map(row => `• ${row.text.slice(0, 90)}`).join('\n');
      if (!window.confirm(`Garder ${chosen.length} information(s) comme souvenirs permanents dans votre mémoire ?\n\n${preview}${chosen.length > 5 ? '\n…' : ''}`)) return;
      lock(true);
      let kept = 0, failed = 0;
      for (const entry of chosen) {
        get('status').textContent = `Souvenirs gardés : ${kept} sur ${chosen.length}…`;
        try { await keep(entry); kept += 1; selected.delete(entry.id); } catch { failed += 1; }
      }
      lock(false); await load();
      get('status').textContent = `${kept} souvenir(s) gardé(s).${failed ? ` ${failed} n’ont pas pu l’être : relisez-les puis réessayez.` : ''}`;
    };
    get('filters').onsubmit = event => { event.preventDefault(); if (!loading) { offset = 0; void load(); } };
    get('prev').onclick = () => { if (!loading) { offset = Math.max(0, offset - maximum); void load(); } };
    get('next').onclick = () => { if (!loading && next !== null) { offset = next; void load(); } };
    async function readSource(details, offset = 0, part) {
      const entry = rows.find(row => row.id === details.dataset.historySource);
      if (!entry?.archiveUrl) return;
      const status = details.querySelector('[data-source-status]'), nextButton = details.querySelector('[data-source-next]');
      const version = details.querySelector('[data-source-version]');
      status.textContent = 'Lecture de la source sauvegardée…'; nextButton.disabled = true; version.disabled = true;
      try {
        const source = await api(`${entry.archiveUrl}&offset=${offset}${part === undefined || part === null ? '' : `&part=${part}`}`);
        if (!details.isConnected) return;
        const versions = source.bodyRepresentations || [];
        details.querySelector('[data-source-version-label]').hidden = versions.length < 2;
        version.innerHTML = versions.map(item => `<option value="${esc(item.partIndex)}"${item.partIndex === source.selectedPartIndex ? ' selected' : ''}${item.readable === false ? ' disabled' : ''}>${item.extraction?.processor === 'striprtf' ? 'RTF extrait en texte' : item.mimeType === 'text/html' ? 'HTML converti en texte' : 'Texte brut'}${item.readable === false ? ' · à examiner' : ''}</option>`).join('');
        version.onchange = () => void readSource(details, 0, Number(version.value));
        details.querySelector('[data-source-warning]').textContent = (versions.length > 1 ? 'Plusieurs versions du texte sont conservées. Elles peuvent contenir des informations différentes. ' : '')
          + (versions.some(item => item.readable === false) ? 'Une version demande une lecture complémentaire de l’original.' : '');
        details.querySelector('[data-source-body]').textContent = source.body;
        const extra = source.htmlEvidence;
        details.querySelector('[data-source-extra]').hidden = !extra || !extra.items.length && !extra.truncated;
        details.querySelector('[data-source-extra-body]').textContent = (extra?.items || [])
          .map(item => `${item.kind === 'reference' ? 'Destination' : item.kind === 'description' ? 'Description' : 'Données de script à examiner'} · ${item.tag} · ${item.attribute}\n${item.value}${item.truncated ? '\n[Extrait incomplet]' : ''}`).join('\n\n');
        details.querySelector('[data-source-extra-status]').textContent = extra?.truncated
          ? 'Présentation incomplète : consultez l’original avant de terminer la revue.' : '';
        details.querySelector('[data-source-files]').textContent = source.attachmentCount
          ? `Pièces conservées avec l’original : ${(source.attachments || []).map(file => file.filename).join(', ')}. Leur contenu n’est pas affiché ici.` : '';
        const author = source.headers?.From ? ` Message de ${source.headers.From}.` : '';
        status.textContent = (source.bodyReadable === false ? 'L’original est conservé; son corps ne peut pas être présenté en texte.'
          : source.bodyTruncated ? 'Extrait de cette version du texte. La suite est disponible.' : 'Fin de cette version du texte sauvegardé.') + author;
        nextButton.hidden = source.nextOffset === null;
        nextButton.onclick = () => void readSource(details, source.nextOffset, source.selectedPartIndex);
        details.dataset.loaded = 'true';
      } catch { status.textContent = 'La source sauvegardée ne peut pas être vérifiée ou lue pour le moment.'; }
      finally { nextButton.disabled = false; version.disabled = false; }
    }
    const decisionNames = { reviewed_scope: 'Textes revus sur ce périmètre', needs_follow_up: 'Reste à examiner' };
    const decisionStorageKey = id => `history-source-review-decision:${id}`;
    async function intentHash(input) {
      const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.keys(input).sort().map(key => [key, input[key]]))));
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    }
    function journal(key, value) {
      try {
        const encoded = JSON.stringify(value), old = localStorage.getItem(key);
        if (old && old !== encoded) throw Error('Another transport intent is pending');
        if (old !== encoded) localStorage.setItem(key, encoded);
        if (localStorage.getItem(key) !== encoded) throw Error('Intent was not retained');
      } catch { throw Object.assign(Error('Transport storage unavailable'), { code: 'SOURCE_REVIEW_STORAGE_REQUIRED' }); }
    }
    function loadDecisionIntent(details, state) {
      if (state.decisionJournalRead || state.pendingDecision) return;
      try {
        const raw = localStorage.getItem(decisionStorageKey(details.dataset.historySourceReview));
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && (typeof saved.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(saved.intentHash || ''))) throw Error('Invalid decision identity');
        state.pendingDecision = saved ? { requestId: saved.requestId, intentHash: saved.intentHash } : null;
        state.decisionJournalRead = true;
      } catch { throw Object.assign(Error('Decision transport storage unavailable'), { code: 'SOURCE_REVIEW_STORAGE_REQUIRED' }); }
    }
    function clearDecisionIntent(details, state) {
      state.pendingDecision = null;
      try { localStorage.removeItem(decisionStorageKey(details.dataset.historySourceReview)); } catch {}
    }
    function reconcileReview(details, state, response) {
      if (response.erased) {
        clearDecisionIntent(details, state);
        try { localStorage.removeItem(`history-source-review:${details.dataset.historySourceReview}`); } catch {}
        state.review = null; state.page = null;
        rows = rows.filter(row => row.id !== details.dataset.historySourceReview);
        details.closest('[data-entry]')?.remove();
        get('status').textContent = 'Le relevé et ses revues ont été oubliés.';
        return;
      }
      state.review = response.review;
      state.knownRequestId = state.review.requestId;
      if (!state.pendingDecision && !state.review.decision && state.review.entryCurrent && state.review.decisionIntent) {
        // Recover the canonical intent, without keeping its private content in
        // browser storage or reconstructing a replacement decision.
        state.pendingDecision = { requestId: state.review.requestId, intentHash: state.review.decisionIntent.intentHash };
      }
      if (state.review.decision) {
        const entry = rows.find(row => row.id === details.dataset.historySourceReview);
        if (entry) entry.revision = Math.max(entry.revision, state.review.decision.resultingRevision);
      }
      if (state.pendingDecision?.requestId === state.review.requestId) {
        if (state.review.decision) {
          state.notice = state.review.decision.intentHash === state.pendingDecision.intentHash ? ''
            : 'Le reçu retrouvé porte un autre constat. Votre demande ne le remplace pas.';
          clearDecisionIntent(details, state);
        } else if (!state.review.entryCurrent) {
          // A changed canonical entry/context fence prevents the old write.
          // Mere absence of a decision on a still-current entry proves nothing.
          state.notice = 'La version du relevé a changé ; l’ancien constat ne peut plus lui être appliqué.';
          clearDecisionIntent(details, state);
        }
      }
    }
    async function sendDecision(details, state) {
      const pending = state.pendingDecision;
      journal(decisionStorageKey(details.dataset.historySourceReview), { requestId: pending.requestId, intentHash: pending.intentHash });
      const retained = state.review?.requestId === pending.requestId ? state.review.decisionIntent : null;
      const input = retained?.intentHash === pending.intentHash ? { intentHash: pending.intentHash } : pending.input;
      if (!input) {
        state.notice = 'Core n’a pas encore reçu de contenu retrouvable pour ce constat. Reprenez cette même identité plus tard ; aucun autre constat n’est envoyé.';
        return;
      }
      const response = await api(`/api/secretary/history/${encodeURIComponent(details.dataset.historySourceReview)}/source-review/${pending.requestId}/decision`,
        { method: 'POST', body: JSON.stringify(input) });
      reconcileReview(details, state, response); state.page = null;
      const entry = rows.find(row => row.id === details.dataset.historySourceReview);
      if (entry) { entry.revision = response.receipt.resultingRevision; entry.sourceReview = response.review; }
    }
    function renderSourceReview(details, state) {
      if (!details.isConnected) return;
      const review = state.review;
      const gaps = review?.coverage.gaps || [];
      const pendingInput = review?.decisionIntent && review.decisionIntent.intentHash === state.pendingDecision?.intentHash
        ? review.decisionIntent.input : state.pendingDecision?.input;
      const names = { attachments_not_reviewed: 'Pièces jointes non examinées', html_supplement_not_reviewed: 'Liens et données HTML à examiner séparément',
        compound_members_not_reviewed: 'Contenu des archives jointes non examiné', no_readable_text: 'Aucun texte lisible',
        unreadable_text_representation: 'Version de texte illisible', extracted_text_limits: 'Limites de l’extraction du texte',
        original_header_length_limit: 'Un en-tête atteint la limite du lecteur ; son contenu complet reste à vérifier' };
      details.querySelector('[data-source-review-content]').innerHTML = `<p role="status" data-source-review-status>${esc(state.error || (review?.decision
        ? 'Votre décision de revue est enregistrée. Elle ne vaut pas validation de tous les documents.' : review ? 'Lisez les versions proposées, puis indiquez votre constat.' : ''))}</p>${state.notice ? `<p>${esc(state.notice)}</p>` : ''}`
        + (review ? `<p>Couverture : ${review.coverage.status === 'served_selected_text' ? 'Les pages des textes sélectionnés ont été servies.' : review.coverage.status === 'unknown' ? 'Sources indisponibles ou périmètre inconnu.' : 'Lecture des textes incomplète.'}</p>
        ${review.decision ? `<dl data-source-review-receipt><dt>Constat enregistré</dt><dd>${esc(decisionNames[review.decision.decision])}</dd><dt>Raison reçue</dt><dd>${esc(review.decision.reason)}</dd><dt>Date du reçu</dt><dd>${esc(new Date(review.decision.at).toLocaleString('fr-CA'))}</dd></dl>` : ''}
        ${review.history?.length > 1 ? `<label>Revues conservées<select data-source-review-history>${review.history.map(item => `<option value="${esc(item.requestId)}"${item.requestId === review.requestId ? ' selected' : ''}>${esc(day(item.preparedAt))} · ${esc(decisionNames[item.decision] || 'Lecture en cours')}</option>`).join('')}</select></label>` : ''}
        ${state.pendingDecision ? `<section data-source-review-pending><p>Constat en attente de vérification. Un reçu encore absent ne prouve pas que la demande précédente est terminée.</p>${pendingInput ? `<p>${esc(decisionNames[pendingInput.decision])} — ${esc(pendingInput.reason)}</p>` : '<p>Le contenu n’est pas encore retrouvable dans Core. La même identité reste en attente ; aucun nouveau constat n’est déduit.</p>'}<button type="button" data-source-review-retry-decision>Reprendre exactement ce constat</button></section>` : ''}
        ${gaps.length ? `<ul>${gaps.map(gap => `<li>${esc(names[gap.code] || 'Source indisponible ou non prise en charge')} — source ${gap.source + 1}</li>`).join('')}</ul>` : ''}
        ${review.sources.map((source, index) => `<section data-source-review-headers><h4>Origine du message · source ${index + 1}</h4>${source.headers
          ? `<p>En-têtes du message archivé. Ils ne déterminent pas l’auteur d’une citation ni la date du fait.</p><dl>${[['From', 'Expéditeur'], ['To', 'Destinataires'], ['Cc', 'Copie'], ['Date', 'Date déclarée du message'], ['Subject', 'Objet']].map(([key, label]) => `<dt>${label}</dt><dd>${esc(source.headers[key] || 'Non renseigné')}</dd>`).join('')}</dl>`
          : '<p>En-têtes non conservés dans cette revue. Ils ne sont pas déduits du relevé ni de la date de lecture.</p>'}</section>`).join('')}
        ${!review.entryCurrent || review.nativeState === 'stale' ? '<p>Le relevé ou une source a changé. Cette version ne peut plus recevoir de décision.</p>' : ''}
        ${review.nativeState === 'unknown' ? '<p>La disponibilité actuelle des sources reste inconnue. Aucun constat en attente n’est considéré comme accepté.</p>' : ''}
        ${!state.pendingDecision && (!review.entryCurrent || ['stale', 'unknown'].includes(review.nativeState) || review.decision) ? '<button type="button" data-source-review-new>Préparer une nouvelle revue de la version affichée</button>' : ''}
        ${!review.decision && review.entryCurrent ? review.sources.map((source, index) => (source.parts || []).filter(part => part.readable).map(part =>
          `<button type="button" data-source-review-read="${index}:${part.partIndex}">Lire ou reprendre la source ${index + 1} · ${part.mimeType === 'text/html' ? 'version HTML' : part.mimeType === 'text/plain' ? 'texte brut' : 'version textuelle'}</button>`).join('')).join('') : ''}
        ${state.page ? `<pre data-source-review-body>${esc(state.page.body)}</pre>` : ''}
        ${!state.pendingDecision && !review.decision && review.entryCurrent ? `<form data-source-review-decision><label>Votre constat sur ce périmètre<textarea name="reason" required maxlength="2000">${esc(state.reason || '')}</textarea></label>
        <button type="submit" value="reviewed_scope"${state.error || review.nativeState !== 'observed' || review.coverage.status !== 'served_selected_text' ? ' disabled' : ''}>Enregistrer la revue de ces textes</button>
        <button type="submit" value="needs_follow_up"${state.error || review.nativeState !== 'observed' ? ' disabled' : ''}>Noter ce qui reste à examiner</button></form>` : ''}` : '');
    }
    async function sourceAction(details, run) {
      const state = sourceStates.get(details) || {};
      if (state.busy) return;
      state.busy = true; sourceStates.set(details, state);
      details.querySelectorAll('button, textarea').forEach(node => { node.disabled = true; });
      const generation = epoch;
      try { await run(state); state.error = ''; }
      catch (error) { state.page = null; state.review = null; state.error = error.code === 'SOURCE_REVIEW_STORAGE_REQUIRED'
        ? 'Le stockage de reprise du navigateur est indisponible. Aucune nouvelle demande n’a été envoyée. Rétablissez ce stockage, puis reprenez la même demande.'
        : 'La lecture ou la décision n’a pas pu être confirmée. Reprenez la même revue pour retrouver son reçu ; aucune nouvelle décision n’est déduite de cette erreur.'; }
      finally {
        state.busy = false;
        if (generation === epoch && details.isConnected) {
          details.querySelector('[data-source-review-start]').disabled = false;
          renderSourceReview(details, state);
        }
      }
    }
    get('list').addEventListener('click', event => {
      const details = event.target.closest('[data-history-source-review]');
      if (!details) return;
      const entry = rows.find(row => row.id === details.dataset.historySourceReview);
      if (!entry) return;
      if (event.target.matches('[data-source-review-start], [data-source-review-new]')) {
        const fresh = event.target.matches('[data-source-review-new]');
        void sourceAction(details, async state => {
          loadDecisionIntent(details, state);
          if (fresh && state.pendingDecision) throw Error('Reconcile the pending decision first');
          const storageKey = `history-source-review:${entry.id}`;
          let pending = state.pendingDecision ? { requestId: state.pendingDecision.requestId, revision: state.pending?.revision ?? entry.sourceReview?.entryRevision ?? entry.revision } : fresh ? null : state.pending;
          let storageUnreadable = false;
          if (!pending && !fresh) { try {
            const saved = localStorage.getItem(storageKey);
            pending = saved ? JSON.parse(saved) : null;
            if (pending && (typeof pending.requestId !== 'string' || !Number.isSafeInteger(pending.revision))) throw Error('Invalid stored identity');
          } catch { storageUnreadable = true; } }
          if (!pending && !fresh && entry.sourceReview) pending = { requestId: entry.sourceReview.requestId, revision: entry.sourceReview.entryRevision };
          if (!pending && storageUnreadable) throw Object.assign(Error('Transport storage unavailable'), { code: 'SOURCE_REVIEW_STORAGE_REQUIRED' });
          if (!pending) pending = { requestId: window.crypto.randomUUID(), revision: entry.revision };
          if (fresh) { state.preparationDispatched = false; state.review = null; }
          state.pending = pending; state.page = null;
          const base = `/api/secretary/history/${encodeURIComponent(entry.id)}/source-review`;
          if (!state.pendingDecision && (fresh || (entry.sourceReview?.requestId !== pending.requestId && state.knownRequestId !== pending.requestId))) {
            // Journal only transport identity durably before a new dispatch.
            // A lost reply retries state.pending, even if storage later fails.
            if (!state.preparationDispatched) {
              try {
                const value = JSON.stringify(pending);
                if (localStorage.getItem(storageKey) !== value) localStorage.setItem(storageKey, value);
                if (localStorage.getItem(storageKey) !== value) throw Error('Identity was not retained');
              } catch { throw Object.assign(Error('Transport storage unavailable'), { code: 'SOURCE_REVIEW_STORAGE_REQUIRED' }); }
            }
            state.review = null; state.preparationDispatched = true;
            const prepared = await api(base, { method: 'POST', body: JSON.stringify(pending) });
            state.knownRequestId = prepared.review.requestId;
          }
          reconcileReview(details, state, await api(`${base}/${pending.requestId}`));
        });
      }
      if (event.target.matches('[data-source-review-retry-decision]')) void sourceAction(details, async state => {
        const key = state.pendingDecision.requestId;
        reconcileReview(details, state, await api(`/api/secretary/history/${encodeURIComponent(entry.id)}/source-review/${key}`));
        if (state.pendingDecision) await sendDecision(details, state);
      });
      if (event.target.matches('[data-source-review-read]')) {
        const [source, part] = event.target.dataset.sourceReviewRead.split(':').map(Number);
        void sourceAction(details, async state => {
          const progress = state.review.progress.find(p => p.source === source && p.part === part);
          const total = state.review.sources[source].parts.find(p => p.partIndex === part).totalChars;
          const offset = state.page?.source === source && state.page?.part === part && state.page.nextOffset !== null ? state.page.nextOffset
            : progress.nextOffset < total ? progress.nextOffset : 0;
          const result = await api(`/api/secretary/history/${encodeURIComponent(entry.id)}/source-review/${state.review.requestId}/page?source=${source}&part=${part}&offset=${offset}`);
          state.review = result.review; state.page = result.page;
        });
      }
    });
    get('list').addEventListener('change', event => {
      if (!event.target.matches('[data-source-review-history]')) return;
      const details = event.target.closest('[data-history-source-review]'), key = event.target.value;
      void sourceAction(details, async state => {
        state.page = null;
        reconcileReview(details, state, await api(`/api/secretary/history/${encodeURIComponent(details.dataset.historySourceReview)}/source-review/${key}`));
      });
    });
    get('list').addEventListener('submit', event => {
      if (!event.target.matches('[data-source-review-decision]')) return;
      event.preventDefault();
      const details = event.target.closest('[data-history-source-review]');
      const reason = new FormData(event.target).get('reason'), choice = event.submitter?.value;
      if (!decisionNames[choice]) return;
      void sourceAction(details, async state => {
        loadDecisionIntent(details, state);
        if (state.pendingDecision) throw Error('Reconcile the pending decision first');
        state.reason = reason;
        const input = { snapshotHash: state.review.snapshotHash, revision: state.review.entryRevision,
          decision: choice, reason: state.reason };
        state.pendingDecision = { requestId: state.review.requestId, input, intentHash: await intentHash(input) };
        await sendDecision(details, state);
      });
    });
    get('list').addEventListener('toggle', event => {
      const details = event.target;
      if (details.matches?.('[data-history-source]') && details.open && !details.dataset.loaded) void readSource(details);
    }, true);
    get('list').addEventListener('submit', async event => {
      const form = event.target.closest('[data-history-review]');
      if (!form) return;
      event.preventDefault(); if (loading) return;
      const entry = rows.find(row => row.id === form.dataset.historyReview);
      if (!entry) return;
      const values = new FormData(form);
      const when = values.get('eventDate');
      if (event.submitter?.value === 'souvenir') {
        lock(true);
        try {
          await keep(entry, when ? { eventDate: when, eventDatePrecision: 'day' } : {});
          selected.delete(entry.id); lock(false); await load();
          get('status').textContent = 'Souvenir gardé dans votre mémoire.';
        } catch { lock(false); get('status').textContent = 'Le souvenir n’a pas pu être gardé. Rechargez la liste avec Afficher avant de réessayer.'; }
        return;
      }
      const body = { revision: entry.revision, state: event.submitter?.value || 'retained', reason: values.get('reason'),
        assertionState: values.get('assertionState'), ...(when ? { eventDate: when, eventDatePrecision: 'day' } : {}) };
      lock(true);
      try {
        await api(`/api/secretary/history/${encodeURIComponent(entry.id)}/review`, { method: 'POST', body: JSON.stringify(body) });
        lock(false); await load();
      } catch { lock(false); get('status').textContent = 'La décision n’a pas pu être confirmée. Rechargez la liste avec Afficher avant de réessayer.'; }
    });
    await load();
  };
})();
