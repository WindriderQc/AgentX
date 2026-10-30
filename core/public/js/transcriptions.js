'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const form = $('transcriptionForm'), dialog = $('transcriptDialog');
  const states = { queued: 'En attente', running: 'En cours', completed: 'Terminée', failed: 'Échec', cancelled: 'Annulée', uncertain: 'À vérifier' };
  const stages = { queued: 'En attente du créneau', accepted: 'Prise en charge', dispatching: 'Envoi au service vocal',
    downloading: 'Téléchargement de l’audio', decoding: 'Préparation de l’audio', transcribing: 'Reconnaissance vocale', cleaning: 'Nettoyage des fichiers temporaires',
    cancelling: 'Annulation demandée · arrêt après l’opération en cours', reconciling: 'Vérification du reçu sur le serveur',
    completed: 'Prête à lire', failed: 'Traitement arrêté sur erreur', admission: 'Ressources indisponibles', interrupted: 'Service redémarré · tentative interrompue', cancelled: 'Traitement annulé' };
  let offset = 0, busy = false, searchTimer, lastRows = [], fetchSequence = 0, serviceStatus = null, selectedId = null;
  const flow = window.TranscriptionFlow.mount($('transcriptionFlow'));
  function drawFlow(rows, select = false) {
    const row = rows.find(item => item._id === selectedId) || rows.find(item => item.state === 'running') ||
      rows.find(item => item.state === 'queued') || rows[0] || null;
    if (row) selectedId = row._id;
    flow.update(row, serviceStatus, { select });
    updateElapsed();
  }
  async function observeService() {
    try { serviceStatus = await api('/status'); }
    catch { serviceStatus = null; }
    drawFlow(lastRows);
  }
  const storageKey = 'agentx.transcription.pending';
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* unavailable storage */ }
  $('timeZone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    const prefs = JSON.parse(localStorage.getItem('agentx.transcription.preferences') || 'null');
    if (['auto', 'fr', 'en', 'fr-en'].includes(prefs?.language)) $('transcriptionLanguage').value = prefs.language;
    if (prefs?.timeZone && Intl.DateTimeFormat('fr', { timeZone: prefs.timeZone })) $('timeZone').value = prefs.timeZone;
  } catch { /* Invalid or unavailable browser preferences keep safe defaults. */ }
  form.addEventListener('change', () => {
    try { localStorage.setItem('agentx.transcription.preferences', JSON.stringify({
      language: $('transcriptionLanguage').value, timeZone: $('timeZone').value
    })); } catch { /* Preferences never block a durable request. */ }
  });
  const formatDate = (value, zone) => value ? new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium', timeStyle: 'short',
    ...(zone && { timeZone: zone }) }).format(new Date(value)) : '';
  const duration = seconds => {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(n / 3600) + ':' + String(Math.floor(n / 60) % 60).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  };
  function element(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  async function api(path = '', method = 'GET', body) {
    const response = await fetch('/api/transcriptions' + path, { method, headers: { 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw Object.assign(Error(payload.error?.message || 'Le serveur est indisponible.'), { status: response.status });
    return payload.data;
  }
  function link(text, href) {
    const a = element('a', text, 'tr-button');
    a.href = href;
    return a;
  }
  function action(text, fn) {
    const button = element('button', text, 'tr-button');
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await fn(); await refresh(); }
      catch (error) { $('connectionStatus').textContent = error.message; }
      finally { button.disabled = false; }
    });
    return button;
  }
  function actionsForFlow(card, row) {
    const button = element('button', 'Voir le chemin', 'tr-button');
    button.type = 'button';
    button.addEventListener('click', () => {
      selectedId = row._id; drawFlow(lastRows, true);
      $('transcriptionFlow').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    card.append(button);
  }
  function draw(rows) {
    const list = $('transcriptionList');
    list.replaceChildren();
    if (!rows.length) {
      const empty = element('div', undefined, 'tr-empty');
      empty.append(element('i', '', 'fas fa-file-audio'), element('h3', $('transcriptionSearch').value ? 'Aucun passage trouvé' : 'Votre prochaine vidéo commence ici'),
        element('p', $('transcriptionSearch').value ? 'Essayez un autre titre, lien ou mot du texte.' : 'Collez un lien. Vos tâches et vos textes apparaîtront dans cette bibliothèque.'));
      list.append(empty);
    }
    for (const row of rows) {
      const card = element('article', undefined, 'tr-card');
      card.dataset.id = row._id;
      const top = element('div', undefined, 'tr-card-top'), badge = element('span', states[row.state] || row.state, 'tr-badge');
      badge.dataset.state = row.state;
      const date = element('time', formatDate(row.createdAt));
      date.dateTime = row.createdAt;
      top.append(badge, date);
      const source = element('a', row.url, 'tr-source');
      source.href = row.url; source.target = '_blank'; source.rel = 'noopener noreferrer';
      card.append(top, element('h3', row.title || 'Vidéo YouTube'), source);
      const meta = element('div', undefined, 'tr-meta');
      if (row.duration) meta.append(element('span', 'Audio ' + duration(row.duration)));
      meta.append(element('span', row.detectedLanguage || (row.language === 'auto' ? 'Langue automatique' : row.language)));
      card.append(meta);
      actionsForFlow(card, row);
      card.append(element('p', row.requestedAt ? 'Départ demandé : ' + formatDate(row.requestedAt, row.timeZone) + ' · ' + row.timeZone
        : 'Départ demandé dès que possible · ' + row.timeZone));
      if (!['completed', 'cancelled'].includes(row.state)) {
        card.append(element('p', stages[row.stage] || 'Vérification de la tentative'));
        if (row.startedAt) {
          const elapsed = element('span'); elapsed.dataset.started = row.startedAt; elapsed.dataset.finished = row.finishedAt || '';
          card.append(elapsed);
        }
      }
      if (row.error || row.planningError) card.append(element('p', row.error || row.planningError, 'tr-error'));
      const actions = element('div', undefined, 'tr-actions');
      if (row.state === 'completed') actions.append(action('Lire la transcription', () => open(row._id)),
        link('Texte', '/api/transcriptions/' + row._id + '/export/txt'), link('SRT', '/api/transcriptions/' + row._id + '/export/srt'));
      else if (['failed', 'cancelled'].includes(row.state)) actions.append(action('Réessayer', async () => {
        // Stable identity also survives a lost retry response.
        const key = 'agentx.transcription.retry.' + row._id;
        let requestKey = sessionStorage.getItem(key);
        if (!requestKey) { requestKey = crypto.randomUUID(); sessionStorage.setItem(key, requestKey); }
        await api('/' + row._id + '/retry', 'POST', { requestKey });
      }));
      else actions.append(action('Annuler', () => api('/' + row._id + '/cancel', 'POST')));
      card.append(actions); list.append(card);
    }
    updateElapsed();
  }
  function updateElapsed() {
    for (const node of document.querySelectorAll('[data-started]')) {
      const end = node.dataset.finished ? Date.parse(node.dataset.finished) : Date.now();
      node.textContent = 'Temps écoulé : ' + duration((end - Date.parse(node.dataset.started)) / 1000);
    }
  }
  async function refresh() {
    const sequence = ++fetchSequence;
    try {
      const data = await api('?q=' + encodeURIComponent($('transcriptionSearch').value) + '&offset=' + offset);
      if (sequence !== fetchSequence) return;
      if (JSON.stringify(lastRows) !== JSON.stringify(data.rows) || !$('transcriptionList').children.length) draw(data.rows);
      lastRows = data.rows;
      drawFlow(data.rows);
      $('transcriptionCount').textContent = '(' + data.count + ')';
      $('connectionStatus').textContent = 'À jour · les tâches continuent sur le serveur.';
      $('previousPage').disabled = offset === 0;
      $('nextPage').disabled = offset + data.limit >= data.count;
      $('pagePosition').textContent = data.count ? (offset + 1) + '–' + (offset + data.rows.length) + ' / ' + data.count : '';
    } catch (error) {
      flow.update(lastRows.find(row => row._id === selectedId) || null, null);
      $('connectionStatus').textContent = 'Connexion interrompue. Dernier état conservé. ' + error.message;
    } finally { $('transcriptionList').setAttribute('aria-busy', 'false'); }
  }
  async function open(id) {
    const row = await api('/' + id);
    $('transcriptTitle').textContent = row.title || 'Vidéo YouTube';
    $('transcriptMetadata').textContent = [formatDate(row.createdAt), duration(row.duration), row.detectedLanguage].filter(Boolean).join(' · ');
    $('transcriptLinks').replaceChildren(link('Vidéo source', row.url), link('Exporter le texte', '/api/transcriptions/' + id + '/export/txt'), link('Exporter SRT', '/api/transcriptions/' + id + '/export/srt'));
    const content = $('transcriptText'); content.replaceChildren();
    if (!row.result?.segments?.length) content.append(element('p', row.result?.text || 'Aucune parole détectée.'));
    for (const segment of row.result?.segments || []) {
      const line = element('div', undefined, 'tr-segment');
      const anchor = element('a', duration(segment.start));
      anchor.href = row.url + '&t=' + Math.floor(segment.start) + 's'; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      line.append(anchor, element('p', segment.text)); content.append(line);
    }
    if (!dialog.open) dialog.showModal();
  }
  function schedule() {
    const planned = form.elements.when.value === 'at';
    $('scheduleFields').hidden = !planned;
    $('startLocal').required = planned;
    $('submitTranscription').textContent = planned ? 'Planifier la transcription' : 'Transcrire la vidéo';
    if (planned && $('startLocal').value) {
      try {
        const instant = window.TranscriptionTime.resolve($('startLocal').value, $('timeZone').value);
        $('schedulePreview').textContent = 'Pas avant le ' + formatDate(instant, $('timeZone').value) + ' · ' + $('timeZone').value + ' · ' + instant;
      } catch (error) { $('schedulePreview').textContent = error.message; }
    }
  }
  form.addEventListener('change', schedule);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; $('submitTranscription').disabled = true; $('formError').textContent = '';
    try {
      const planned = form.elements.when.value === 'at';
      const startAt = planned ? window.TranscriptionTime.resolve($('startLocal').value, $('timeZone').value) : null;
      const intent = { url: $('sourceUrl').value.trim(), language: $('transcriptionLanguage').value, timeZone: $('timeZone').value, startAt };
      // Reuse the same request identity across double clicks, refresh and lost replies.
      if (pending && JSON.stringify(pending.intent) !== JSON.stringify(intent)) {
        throw Error('Une demande précédente attend confirmation. Actualisez la liste ou renvoyez les mêmes champs avant de préparer une autre vidéo.');
      }
      if (!pending) pending = { requestKey: crypto.randomUUID(), intent };
      try { localStorage.setItem(storageKey, JSON.stringify(pending)); } catch { /* memory identity still retained */ }
      const accepted = await api('', 'POST', { ...intent, requestKey: pending.requestKey });
      selectedId = accepted._id;
      pending = null; localStorage.removeItem(storageKey);
      $('sourceUrl').value = ''; offset = 0; await refresh(); drawFlow(lastRows, true);
    } catch (error) {
      if (error.status === 400) { pending = null; try { localStorage.removeItem(storageKey); } catch {} }
      $('formError').textContent = error.message;
    }
    finally { busy = false; $('submitTranscription').disabled = false; }
  });
  if (pending?.intent) {
    $('sourceUrl').value = pending.intent.url;
    $('transcriptionLanguage').value = pending.intent.language;
    $('timeZone').value = pending.intent.timeZone;
    if (pending.intent.startAt) {
      form.querySelector('[value=at]').checked = true;
      $('startLocal').value = window.TranscriptionTime.wallKey(pending.intent.startAt, pending.intent.timeZone);
    }
    $('formError').textContent = 'Une demande attend confirmation. Renvoyez-la pour consulter la même tâche sans doublon.';
  }
  $('closeTranscript').addEventListener('click', () => dialog.close());
  $('refreshTranscriptions').addEventListener('click', () => { refresh(); observeService(); });
  $('transcriptionSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { offset = 0; refresh(); }, 250); });
  $('previousPage').addEventListener('click', () => { offset = Math.max(0, offset - 30); refresh(); });
  $('nextPage').addEventListener('click', () => { offset += 30; refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  setInterval(updateElapsed, 1000);
  setInterval(() => { if (!document.hidden) observeService(); }, 10000);
  schedule(); refresh(); observeService();
})();
