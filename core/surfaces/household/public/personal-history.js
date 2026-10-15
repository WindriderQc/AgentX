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
      <button type="submit">Afficher</button></form><p data-history-status role="status" aria-live="polite"></p>
      <div data-history-list class="history-list"></div><nav class="row wrap" aria-label="Pages de l’histoire"><button type="button" data-history-prev>Précédents</button><button type="button" data-history-next>Suivants</button></nav></section>`;
    const get = name => app.querySelector(`[data-history-${name}]`);
    let rows = [], offset = 0, next = null, loading = false, epoch = 0;
    const maximum = 20;
    const lock = value => { loading = value; app.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = value; }); };
    const card = entry => `<article class="history-entry" data-entry="${esc(entry.id)}"><header><p class="card-kicker">${esc(kinds[entry.kind] || entry.kind)} · ${esc(states[entry.reviewState] || entry.reviewState)}</p>
      <h2>${esc(entry.text)}</h2><p>${entry.actor ? `${['action', 'deliverable'].includes(entry.kind) ? 'Personne qui doit agir, selon le relevé' : 'Personne associée, à vérifier'} : ${esc(entry.actor)}` : 'Personne à préciser'}</p></header>
      <dl><div><dt>Date de la source</dt><dd>${esc(day(entry.sourceDate))}</dd></div><div><dt>Date de l’événement</dt><dd>${entry.eventDate ? esc(entry.eventDatePrecision === 'day' ? entry.eventDate : day(entry.eventDate)) : 'À préciser'}${entry.eventDateAsWritten ? `<small>Dans la source : ${esc(entry.eventDateAsWritten)}</small>` : ''}</dd></div></dl>
      <p class="muted">${esc(entry.source?.system === 'gmail' ? directions[entry.source.direction] : 'Archive Outlook sélectionnée')} · ${esc(assertions[entry.assertionState])}</p>
      ${entry.gmailUrl ? `<a href="${esc(entry.gmailUrl)}" target="_blank" rel="noopener noreferrer">Consulter l’échange Gmail ↗</a>` : '<p class="muted">Source conservée dans l’archive locale.</p>'}
      ${entry.archiveUrl ? `<details data-history-source="${esc(entry.id)}"><summary>Lire la source sauvegardée</summary><p data-source-status role="status"></p><pre data-source-body></pre><p data-source-files class="muted"></p><button type="button" data-source-next hidden>Extrait suivant</button></details>` : ''}
      ${entry.sourceStatus ? `<details><summary>Interprétation enregistrée à l’extraction</summary><p>${esc(entry.sourceStatus)}</p></details>` : ''}
      ${entry.decision?.reason ? `<p class="history-decision">Dernière décision : ${esc(entry.decision.reason)}</p>` : ''}
      <form data-history-review="${esc(entry.id)}"><label>Votre constat<textarea name="reason" rows="2" maxlength="2000" required placeholder="Ce que la source établit, ou pourquoi ce suivi est clos."></textarea></label>
      <div class="row wrap"><label>Date de l’événement, si établie<input name="eventDate" type="date" value="${entry.eventDatePrecision === 'day' ? esc(entry.eventDate) : ''}"></label>
      <label>Ce que la source permet d’établir<select name="assertionState">${Object.entries(assertions).map(([key, label]) => `<option value="${key}"${key === entry.assertionState ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <div class="row wrap"><button type="submit" value="retained">${['action', 'deliverable'].includes(entry.kind) ? 'Garder ce suivi ouvert' : 'Conserver dans mon histoire'}</button>
      ${['action', 'deliverable'].includes(entry.kind) ? '<button type="submit" value="resolved">Clore ce suivi</button>' : ''}<button type="submit" value="dismissed">Écarter</button></div></form></article>`;
    async function load() {
      const current = ++epoch;
      const filters = new FormData(get('filters'));
      lock(true); get('status').textContent = 'Lecture de votre histoire…';
      const params = new URLSearchParams({ limit: String(maximum), offset: String(offset) });
      for (const [key, value] of filters) if (value) params.set(key, value);
      try {
        const result = await api(`/api/secretary/history?${params}`);
        if (current !== epoch) return;
        rows = result.entries; next = result.nextOffset;
        get('list').innerHTML = rows.length ? rows.map(card).join('') : '<p class="empty">Aucun relevé dans cette sélection.</p>';
        get('status').textContent = `${result.total} relevé(s) · sources de la plus ancienne à la plus récente${rows.length ? ` · ${offset + 1}–${offset + rows.length}` : ''}`;
      } catch (error) { if (current === epoch) { get('list').replaceChildren(); get('status').textContent = 'La liste est indisponible. Utilisez Afficher pour la relire.'; } }
      finally {
        if (current === epoch) { lock(false); get('prev').disabled = offset === 0; get('next').disabled = next === null; }
      }
    }
    get('filters').onsubmit = event => { event.preventDefault(); if (!loading) { offset = 0; void load(); } };
    get('prev').onclick = () => { if (!loading) { offset = Math.max(0, offset - maximum); void load(); } };
    get('next').onclick = () => { if (!loading && next !== null) { offset = next; void load(); } };
    async function readSource(details, offset = 0) {
      const entry = rows.find(row => row.id === details.dataset.historySource);
      if (!entry?.archiveUrl) return;
      const status = details.querySelector('[data-source-status]'), nextButton = details.querySelector('[data-source-next]');
      status.textContent = 'Lecture de la source sauvegardée…'; nextButton.disabled = true;
      try {
        const source = await api(`${entry.archiveUrl}&offset=${offset}`);
        if (!details.isConnected) return;
        details.querySelector('[data-source-body]').textContent = source.body;
        details.querySelector('[data-source-files]').textContent = source.attachmentCount
          ? `Pièces conservées avec l’original : ${(source.attachments || []).map(file => file.filename).join(', ')}. Leur contenu n’est pas affiché ici.` : '';
        const author = source.headers?.From ? ` Message de ${source.headers.From}.` : '';
        status.textContent = (source.bodyReadable === false ? 'L’original est conservé; son corps ne peut pas être présenté en texte.'
          : source.bodyTruncated ? 'Extrait de l’original sauvegardé. La suite est disponible.' : 'Fin du texte de l’original sauvegardé.') + author;
        nextButton.hidden = source.nextOffset === null;
        nextButton.onclick = () => void readSource(details, source.nextOffset);
        details.dataset.loaded = 'true';
      } catch { status.textContent = 'La source sauvegardée ne peut pas être vérifiée ou lue pour le moment.'; }
      finally { nextButton.disabled = false; }
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
