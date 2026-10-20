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
        version.innerHTML = versions.map(item => `<option value="${esc(item.partIndex)}"${item.partIndex === source.selectedPartIndex ? ' selected' : ''}${item.readable === false ? ' disabled' : ''}>${item.mimeType === 'text/html' ? 'HTML converti en texte' : 'Texte brut'}${item.readable === false ? ' · à examiner' : ''}</option>`).join('');
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
