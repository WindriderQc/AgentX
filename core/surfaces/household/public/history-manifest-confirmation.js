(function () {
  'use strict';
  const CONTRACT = 'agentx.history-manifest-confirmation/v1';
  const KEY = 'history-manifest-confirmation:v1';
  const BASE = '/api/secretary/history/manifest-confirmations';
  const HASH = /^[a-f0-9]{64}$/;
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const terminal = value => ['confirmed', 'blocked'].includes(value);
  const phases = ['preparing', 'prepared', 'reopening', 'confirming', 'confirmed', 'blocked'];
  const reference = source => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, source?.[key]]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sourceKey = source => JSON.stringify(reference(source));
  const validSource = source => source?.system === 'gmail' && /^[a-f0-9]{10,32}$/.test(source.messageId || '')
    && /^[a-f0-9]{10,32}$/.test(source.threadId || '') && HASH.test(source.sourceSha256 || '');
  const storageFailure = () => Error('Le journal de reprise du navigateur est indisponible ou a changé. Aucune nouvelle écriture n’est envoyée. Retrouvez la demande originale après avoir rétabli ce stockage.');
  const limits = {
    native_semantic_acceptance_unavailable: 'Le sens et l’exactitude des informations ne sont pas validés.',
    native_decision_reconciliation_unavailable: 'La réconciliation de toutes les décisions reste non validée.',
    native_preservation_acceptance_unavailable: 'La préservation complète des archives reste non validée.',
    native_manifest_approval_binding_unavailable: 'Aucune autorisation de nettoyage n’est liée au manifeste.',
    selected_evidence_needs_review: 'Des éléments de cette sélection restent à examiner.',
    selected_native_findings_need_review: 'Des relevés natifs restent à examiner.',
    empty_recorded_finding_set_not_semantic_acceptance: 'L’absence de relevé natif ne valide pas le sens du message.',
    recorded_findings_need_review: 'Des relevés enregistrés restent à examiner.',
    thread_questions_unresolved: 'Des questions sur l’échange restent ouvertes.',
    core_references_outside_recorded_finding_set: 'Des références Core sont absentes du jeu de relevés natifs.',
    owner_decision_not_recorded: 'Une décision humaine datée manque.',
    retained_action_still_open: 'Un suivi conservé reste ouvert.',
    pending_source_review_intent: 'Un constat sur les sources est encore en attente.',
    linked_souvenirs_need_review: 'Des souvenirs liés restent à examiner.',
    linked_souvenir_unavailable: 'Un souvenir lié est indisponible.',
    linked_souvenir_source_mismatch: 'Les sources d’un souvenir lié diffèrent.',
    linked_souvenir_context_mismatch: 'Le contexte d’un souvenir lié diffère.',
    linked_souvenir_replacement_pending: 'Le remplacement d’un souvenir lié est en attente.',
    live_message_outside_cutoff: 'Le message Gmail actuel est hors de la date limite.',
    live_message_not_found: 'Le message Gmail actuel est introuvable.',
    live_source_hash_mismatch: 'Le contenu Gmail actuel diffère de l’archive.',
    live_thread_mismatch: 'L’échange Gmail actuel diffère de l’archive.',
    live_message_is_draft: 'Le message Gmail actuel est un brouillon.',
    live_message_in_trash: 'Le message Gmail actuel est dans la corbeille.'
  };

  async function collectChecks(entries, api) {
    if (!entries.length) throw Error('Sélectionnez au moins un relevé existant.');
    const selectedMessages = new Map();
    const selection = entries.map(entry => {
      // Match the native sourceIndex order, including deduplication of aliases.
      const seen = new Set();
      const sources = [entry.source, ...(entry.relatedSources || [])].filter(Boolean).filter(source => {
        const key = JSON.stringify([source.system, source.id || '', source.messageId || '', source.threadId || '', source.sourceSha256]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      if (!sources.length || sources.some(source => !validSource(source))) {
        throw Error(`Le relevé « ${entry.text} » contient une source qui n’est pas un message Gmail exact admissible.`);
      }
      for (const source of sources) {
        const existing = selectedMessages.get(source.messageId);
        if (existing && sourceKey(existing) !== sourceKey(source)) throw Error('Un même message porte deux références différentes. Actualisez la sélection avant de préparer le manifeste.');
        selectedMessages.set(source.messageId, source);
      }
      return { entry, sources };
    });
    if (selectedMessages.size > 20) throw Error('La sélection dépasse 20 messages Gmail distincts. Réduisez-la avant de préparer le manifeste.');
    const byMessage = new Map();
    for (const { entry, sources } of selection) {
      const listed = await api(`/api/secretary/history/${encodeURIComponent(entry.id)}/preservation`);
      for (const [index, source] of sources.entries()) {
        const latest = (listed.receipts || []).filter(receipt => receipt.sourceIndex === index
          && receipt.verification === 'review-restoration' && receipt.entryCurrent === true)
          .sort((a, b) => Date.parse(b.preparedAt) - Date.parse(a.preparedAt))[0];
        if (!latest) throw Error(`Le relevé « ${entry.text} » n’a pas de preuve courante de restauration du dossier pour la source ${index + 1}. Faites préparer cette preuve avant de reprendre.`);
        const result = await api(`/api/secretary/history/${encodeURIComponent(entry.id)}/preservation/${encodeURIComponent(latest.requestId)}`);
        const receipt = result.receipt;
        if (!receipt || receipt.requestId !== latest.requestId || receipt.entryCurrent !== true || receipt.nativeState !== 'current'
          || receipt.verification !== 'review-restoration' || receipt.snapshot?.contract !== 'agentx.history-preservation/v3'
          || receipt.snapshot.status !== 'verified_scope' || !HASH.test(receipt.snapshotHash || '')
          || sourceKey(receipt.snapshot.reference) !== sourceKey(source)) {
          throw Error(`La preuve de restauration du dossier du relevé « ${entry.text} », source ${index + 1}, n’est plus vérifiable sur ce périmètre exact. Aucune source sélectionnée n’est omise.`);
        }
        const check = { entryId: entry.id, requestId: receipt.requestId, snapshotHash: receipt.snapshotHash, source: reference(source) };
        const existing = byMessage.get(source.messageId);
        if (!existing) byMessage.set(source.messageId, check);
      }
    }
    return [...byMessage.values()].sort((a, b) => a.source.messageId.localeCompare(b.source.messageId));
  }

  window.mountHistoryManifestConfirmation = function ({ container, api, esc, getSelection, isAvailable = () => true }) {
    let journal = null, stored = null, receipt = null, preview = null, busy = false, error = '', unreadable = false;
    let cutoff = '', reviewed = false;
    function validJournal(value) {
      return value && UUID.test(value.requestId || '') && phases.includes(value.phase)
        && (value.bindingSha256 === null || HASH.test(value.bindingSha256 || ''))
        && Array.isArray(value.input?.checks) && value.input.checks.length >= 1 && value.input.checks.length <= 20
        && value.input.checks.every(check => validSource(check.source) && UUID.test(check.requestId || '')
          && /^[a-f0-9]{24}$/.test(check.entryId || '') && HASH.test(check.snapshotHash || ''))
        && typeof value.input.before === 'string' && Number.isFinite(Date.parse(value.input.before))
        && new Date(value.input.before).toISOString() === value.input.before;
    }
    try {
      stored = localStorage.getItem(KEY);
      journal = stored ? JSON.parse(stored) : null;
      if (journal && !validJournal(journal)) throw storageFailure();
    } catch { unreadable = true; error = storageFailure().message; }

    function save(value, fresh = false) {
      try {
        if (unreadable || localStorage.getItem(KEY) !== stored) throw storageFailure();
        if (journal && !fresh && (value.requestId !== journal.requestId || !same(value.input, journal.input)
          || (journal.bindingSha256 && value.bindingSha256 !== journal.bindingSha256))) throw storageFailure();
        if (fresh && journal && ((!terminal(journal.phase) && journal.phase !== 'prepared') || !journal.acknowledged)) throw storageFailure();
        const encoded = JSON.stringify(value);
        // Keep completed original identities accessible while advancing the active journal.
        if (fresh && journal) {
          const archivedKey = `${KEY}:${journal.requestId}`;
          localStorage.setItem(archivedKey, stored);
          if (localStorage.getItem(archivedKey) !== stored) throw storageFailure();
        }
        localStorage.setItem(KEY, encoded);
        if (localStorage.getItem(KEY) !== encoded) throw storageFailure();
        stored = encoded; journal = value;
      } catch { throw storageFailure(); }
    }
    function accept(value, allowPreview) {
      if (!value || value.contract !== CONTRACT || value.requestId !== journal.requestId || !phases.includes(value.state)
        || value.authenticatedPerson !== null || value.reviewOnly !== true || value.semanticAcceptance !== false
        || value.approvalBound !== false || value.executionAllowed !== false || value.cleanupStatus !== 'blocked'
        || value.mailboxEffects !== 0 || !Array.isArray(value.nativeValidationGaps)
        || (value.bindingSha256 !== null && !HASH.test(value.bindingSha256 || ''))
        || (journal.bindingSha256 && value.bindingSha256 !== journal.bindingSha256)) {
        throw Error('La réponse ne correspond pas au reçu original attendu. Retrouvez son état sans renvoyer l’écriture.');
      }
      // A historical prepared read cannot settle a delayed confirmation write.
      const phase = journal.phase === 'confirming' && !terminal(value.state) ? 'confirming' : value.state;
      const next = { ...journal, phase, bindingSha256: journal.bindingSha256 || value.bindingSha256 };
      save(next);
      receipt = value; preview = null; reviewed = false;
      if (allowPreview && phase === 'prepared' && value.nativeState === 'observed' 
        && value.preview?.manifest && value.preview?.coreRestoration && HASH.test(value.bindingSha256 || '')
        && HASH.test(value.manifestSha256 || '') && HASH.test(value.coreRestorationSha256 || '')) preview = value.preview;
    }
    async function reconcile() {
      preview = null; reviewed = false;
      try { accept(await api(`${BASE}/${encodeURIComponent(journal.requestId)}`), false); }
      catch (cause) {
        error = `${cause.message} Le résultat reste inconnu. Un reçu absent, même avec une réponse 404, ne prouve pas la fin de l’écriture originale. Seule cette identité sera relue.`;
      }
    }
    async function write(suffix, phase, body) {
      save({ ...journal, phase }); // Fail closed before EVERY write, including reopen.
      preview = null; reviewed = false;
      try { accept(await api(`${BASE}${suffix}`, { method: 'POST', body: JSON.stringify(body) }), true); }
      catch {
        error = 'La réponse de l’écriture est incertaine. Lecture du reçu original ; aucune écriture n’est répétée.';
        await reconcile();
      }
    }
    const list = codes => `<ul>${codes.map(code => `<li>${esc(limits[code] || `Limite signalée par le producteur : ${code}`)}</li>`).join('')}</ul>`;
    const canLeavePrepared = () => journal?.phase === 'prepared' && receipt?.state === 'prepared' && !preview && !journal.acknowledged;
    function previewHtml() {
      const manifest = preview.manifest.snapshot || preview.manifest;
      const core = preview.coreRestoration.snapshot || preview.coreRestoration;
      const counts = manifest.coverage?.counts || {};
      const collections = core.restoration?.collections || {};
      return `<section data-manifest-preview><h3>Manifeste exact à relire</h3>
        <p>Sources : ${esc(counts.messages ?? 'inconnu')} · Relevés Core : ${esc(counts.entries ?? 'inconnu')} · Souvenirs observés : ${esc(counts.observedNotes ?? 'inconnu')} · Messages Gmail présents : ${esc(counts.livePresent ?? 'inconnu')} · Messages avec réserves : ${esc(counts.evidenceHeldMessages ?? 'inconnu')}.</p>
        <p>Preuves composées, sans instantané atomique entre les composants.</p>
        ${list(manifest.coverage?.blockers || receipt.nativeValidationGaps)}
        ${(manifest.coverage?.messages || []).map((message, index) => {
          const copies = manifest.restoration?.snapshot?.members?.[index]?.snapshot?.copies || [];
          const findings = manifest.decisions?.snapshot?.findings?.[index]?.snapshot?.coverage?.counts || {};
          const links = manifest.downstream?.snapshot?.members?.[index]?.snapshot?.coverage?.counts || {};
          const live = manifest.mailbox?.[index]?.snapshot?.mailbox;
          return `<section><h4>Source ${index + 1}</h4>
            <details><summary>Identifiants de la source et empreinte</summary><dl><dt>Message Gmail</dt><dd>${esc(message.reference?.messageId)}</dd><dt>Échange Gmail</dt><dd>${esc(message.reference?.threadId)}</dd><dt>Empreinte du contenu archivé</dt><dd>${esc(message.reference?.sourceSha256)}</dd></dl></details>
            <p>Relevés natifs : ${esc(findings.recordedFindings ?? 'inconnu')} · Décisions observées : ${esc(findings.observedDecision ?? 'inconnu')} · Éléments à examiner : ${esc(findings.needsReview ?? 'inconnu')} · Souvenirs liés courants : ${esc(links.currentLinks ?? 'inconnu')}.</p>
            <p>Gmail : ${live?.status === 'present' ? 'message présent' : live?.status === 'not_found' ? 'message introuvable' : 'état inconnu'}${live?.current ? ` · étiquettes : ${esc(live.current.labelIds.join(', '))}` : ''}.</p>
            ${copies.map((copy, copyIndex) => `<p>Copie ${copyIndex + 1} : ${copy.status === 'available' ? 'disponible' : 'indisponible'} · Fichiers du dossier de revue : ${esc(copy.content?.reviewPacket?.counts?.files ?? 'inconnu')} · Pages : ${esc(copy.content?.reviewPacket?.counts?.pages ?? 'inconnu')} · Pièces jointes : ${esc(copy.content?.reviewPacket?.counts?.attachments ?? 'inconnu')}.</p>`).join('')}
            ${message.blockers?.length ? list(message.blockers) : '<p>Aucune réserve supplémentaire signalée pour ce message.</p>'}</section>`;
        }).join('')}
        <p>Restauration Core temporaire : ${esc(collections.history?.documents ?? 'inconnu')} relevé(s), ${esc(collections.souvenirs?.documents ?? 'inconnu')} souvenir(s), ${esc(collections.history?.indexes ?? 'inconnu')} index des relevés et ${esc(collections.souvenirs?.indexes ?? 'inconnu')} index des souvenirs. Copie temporaire retirée : ${core.restoration?.temporaryCopyRemoved === true ? 'oui' : 'non vérifié'}.</p>
        <details><summary>Empreintes des preuves</summary><dl><dt>Empreinte du manifeste</dt><dd>${esc(receipt.manifestSha256)}</dd><dt>Empreinte de la restauration Core</dt><dd>${esc(receipt.coreRestorationSha256)}</dd><dt>Liaison exacte des deux preuves</dt><dd>${esc(journal.bindingSha256)}</dd></dl></details>
        <label class="history-pick"><input type="checkbox" data-manifest-reviewed${reviewed ? ' checked' : ''}> J’ai relu ce périmètre exact et ses réserves. Ma confirmation porte uniquement sur cette revue, sans autoriser de suppression.</label>
        <button type="button" data-manifest-confirm${!reviewed || busy || !isAvailable() ? ' disabled' : ''}>Confirmer la revue de ce manifeste exact</button></section>`;
    }
    function render() {
      if (!container.isConnected) return;
      const selected = getSelection();
      const frozen = journal && !journal.acknowledged;
      const disabled = busy || !isAvailable() || unreadable;
      const statuses = { preparing: 'Préparation en attente. Retrouvez le reçu original sans relancer la préparation.',
        prepared: journal?.acknowledged ? 'Préparation conservée sans confirmation. Une autre sélection peut être préparée explicitement.'
          : preview ? 'Preuves du manifeste exact affichées. Relisez le périmètre et ses réserves avant de confirmer.' : 'Reçu préparé. Ouvrez explicitement ses preuves actuelles avant de confirmer.',
        reopening: 'Réouverture en attente. Retrouvez d’abord le reçu original.',
        confirming: 'Confirmation en attente ou incertaine. Seul le reçu original peut établir son résultat ; aucune nouvelle confirmation n’est envoyée.',
        confirmed: 'Revue du manifeste exact confirmée. Ce reçu est historique ; il ne prouve pas la disponibilité actuelle des sources.',
        blocked: 'Cette demande est bloquée. Son identité et ses empreintes originales restent conservées.' };
      container.innerHTML = `<section class="history-manifest" aria-label="Confirmation du manifeste des sources"><h2>Revoir le manifeste des sources sélectionnées</h2>
        <p>Confirmation humaine sur le réseau privé, sans personne authentifiée. Elle atteste la revue des preuves affichées, sans valider le sens des informations ni autoriser de nettoyage. Aucune suppression ; aucun effet sur la boîte Gmail.</p>
        <p>Sélection actuelle : ${selected.length} relevé(s). Chaque source doit disposer d’une preuve courante de restauration du dossier ; aucune preuve manquante n’est créée automatiquement.</p>
        ${selected.length ? `<ul>${selected.map(entry => `<li>${esc(entry.text)}</li>`).join('')}</ul>` : ''}
        <label>Messages strictement antérieurs au jour choisi (00:00 UTC)<input type="date" data-manifest-before value="${esc(cutoff)}"${disabled || frozen ? ' disabled' : ''}></label>
        <button type="button" data-manifest-prepare${disabled || frozen || !selected.length || !cutoff ? ' disabled' : ''}>Préparer le manifeste de la sélection</button>
        <p role="status" aria-live="polite" data-manifest-status>${esc(error || (journal ? statuses[journal.phase] : 'Choisissez une date limite explicite, puis préparez les preuves.'))}</p>
        ${journal ? `${error ? `<p>${esc(statuses[journal.phase])}</p>` : ''}<dl><dt>Date limite figée</dt><dd>${esc(journal.input.before)}</dd><dt>Sources figées</dt><dd>${esc(journal.input.checks.length)} message(s)</dd></dl>
          <details><summary>Identifiants et empreintes de la demande</summary><dl><dt>Demande originale</dt><dd>${esc(journal.requestId)}</dd></dl>
          <ul>${journal.input.checks.map(check => `<li>Message ${esc(check.source.messageId)} · échange ${esc(check.source.threadId)} · empreinte ${esc(check.source.sourceSha256)}</li>`).join('')}</ul></details>
          <p>La sélection actuelle et la date ne modifient jamais cette demande.</p>
          ${receipt?.confirmedAt ? `<p>Confirmation enregistrée le ${esc(receipt.confirmedAt)}.</p>` : ''}
          ${receipt?.blockedCode ? `<details><summary>Référence technique du blocage</summary><p>${esc(receipt.blockedCode)}</p></details>` : ''}
          <button type="button" data-manifest-reconcile${disabled ? ' disabled' : ''}>Retrouver le reçu original</button>
          ${journal.phase === 'prepared' && !journal.acknowledged && !preview ? `<button type="button" data-manifest-reopen${disabled || !receipt ? ' disabled' : ''}>Rouvrir les preuves de cette demande</button>` : ''}
          ${canLeavePrepared() ? `<button type="button" data-manifest-leave-prepared${disabled ? ' disabled' : ''}>Conserver cette préparation sans la confirmer</button><p>La demande originale restera conservée dans Core. Vous pourrez préparer explicitement une autre sélection, sans confirmer celle-ci.</p>` : ''}
          ${terminal(journal.phase) && !journal.acknowledged ? `<button type="button" data-manifest-acknowledge${disabled ? ' disabled' : ''}>Prendre acte du reçu et permettre une nouvelle préparation explicite</button>` : ''}
          ${preview ? previewHtml() : ''}` : ''}</section>`;
    }
    async function action(run) {
      if (busy || !isAvailable() || unreadable) return;
      busy = true; error = ''; render();
      try { await run(); }
      catch (cause) { error = cause.message; }
      finally { busy = false; render(); }
    }
    container.addEventListener('change', event => {
      if (event.target.matches('[data-manifest-before]') && (!journal || journal.acknowledged)) {
        cutoff = event.target.value; render();
      }
      if (event.target.matches('[data-manifest-reviewed]')) { reviewed = event.target.checked; render(); }
    });
    container.addEventListener('click', event => {
      if (event.target.disabled) return;
      if (event.target.matches('[data-manifest-prepare]')) void action(async () => {
        if (journal && !journal.acknowledged) return;
        const before = new Date(`${cutoff}T00:00:00.000Z`).toISOString();
        const entries = JSON.parse(JSON.stringify(getSelection())); // Freeze before the first async read.
        const checks = await collectChecks(entries, api);
        const original = { requestId: window.crypto.randomUUID(), input: { checks, before }, bindingSha256: null, phase: 'preparing' };
        save(original, true); receipt = null;
        await write('', 'preparing', { requestId: original.requestId, ...original.input });
      });
      if (event.target.matches('[data-manifest-reconcile]')) void action(reconcile);
      if (event.target.matches('[data-manifest-reopen]')) void action(async () => {
        if (journal.phase !== 'prepared' || journal.acknowledged || !receipt) return;
        await write(`/${encodeURIComponent(journal.requestId)}/reopen`, 'reopening', journal.input);
      });
      if (event.target.matches('[data-manifest-confirm]')) void action(async () => {
        if (!reviewed || !preview || journal.phase !== 'prepared' || journal.acknowledged) return;
        await write(`/${encodeURIComponent(journal.requestId)}/confirm`, 'confirming', { ...journal.input,
          bindingSha256: journal.bindingSha256, confirmation: 'reviewed_selected_manifest' });
      });
      if (event.target.matches('[data-manifest-acknowledge]')) void action(async () => {
        if (!terminal(journal.phase)) return;
        save({ ...journal, acknowledged: true }); preview = null;
      });
      if (event.target.matches('[data-manifest-leave-prepared]')) void action(async () => {
        if (!canLeavePrepared()) return;
        save({ ...journal, acknowledged: true }); preview = null; reviewed = false;
      });
    });
    render();
    return { refresh: render };
  };
})();
