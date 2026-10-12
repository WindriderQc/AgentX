'use strict';

const iotConfiguration = { device: '', data: null, profiles: [], error: '', note: '', armed: null, timeout: null, generation: 0, editor: '' };
const iotConfigModes = { IN: 'Entrée', OUT: 'Sortie', INPULL: 'Entrée pull-up', INPULLD: 'Entrée pull-down' };
function iotConfigurationReset() {
  iotConfigDisarm(); iotConfiguration.generation++;
  Object.assign(iotConfiguration, { device: iotState.selected, data: null, error: '', note: '', editor: '' });
}
async function iotConfigurationLoad() {
  const id = iotState.selected, generation = ++iotConfiguration.generation, seq = state.renderSeq;
  if (!id) return;
  try {
    const [data, profiles] = await Promise.all([api(`${iotPath(id)}/controls`), api('/iot/profiles')]);
    if (id !== iotState.selected || generation !== iotConfiguration.generation || seq !== state.renderSeq || state.tab !== 'iot') return;
    Object.assign(iotConfiguration, { device: id, data, profiles: array(profiles.profiles), error: '' });
  } catch (error) {
    if (id !== iotState.selected || generation !== iotConfiguration.generation || seq !== state.renderSeq || state.tab !== 'iot') return;
    iotConfiguration.error = error.message;
  }
  iotPaint('#iotConfiguration', iotConfigurationHtml());
}
function iotConfigDisarm(note = '') {
  if (iotConfiguration.timeout) clearTimeout(iotConfiguration.timeout);
  iotConfiguration.armed = null; iotConfiguration.timeout = null;
  if (note) iotConfiguration.note = note;
}
function iotConfigBlock() {
  const blocked = iotCommandBlock();
  if (blocked) return blocked;
  if (iotDevice()?.status !== 'online') return 'l’appareil n’est pas annoncé en ligne';
  if (!iotConfiguration.data?.observedFresh || Date.now() - Date.parse(iotConfiguration.data.observed?.receivedAt) > 60000) return 'l’appareil n’a pas déclaré récemment une configuration compatible';
  if (iotConfiguration.data.inFlight) return 'l’application précédente attend une confirmation ou une vérification';
  return '';
}
function iotConfigRow(pin = { io: 15, mode: 'OUT', lbl: '', isA: false, name: '' }) {
  return `<tr data-iot-config-row><td><input data-field="io" type="number" min="0" max="48" required value="${e(pin.io)}" aria-label="GPIO"></td>
    <td><select data-field="mode" aria-label="Mode">${Object.entries(iotConfigModes).map(([mode, name]) => `<option value="${mode}"${pin.mode === mode ? ' selected' : ''}>${e(name)}</option>`).join('')}</select></td>
    <td><input data-field="lbl" maxlength="64" value="${e(pin.lbl)}" aria-label="Repère"></td>
    <td><input data-field="isA" type="checkbox"${pin.isA ? ' checked' : ''} aria-label="Analogique"></td>
    <td><input data-field="name" maxlength="64" value="${e(pin.name)}" aria-label="Nom"></td>
    <td><button type="button" class="button" data-iot-config-remove aria-label="Retirer cette broche">Retirer</button></td></tr>`;
}
function iotProfileEditorHtml() {
  const profile = iotConfiguration.profiles.find(row => row.id === iotConfiguration.editor);
  return `<form id="iotProfileEditor" data-revision="${profile?.revision || 0}" data-name="${e(profile?.id || '')}">
    <label>Nom du profil<input name="profileName" maxlength="64" required value="${e(profile?.id || '')}"></label>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Broches du profil"><table class="iot-config-editor"><thead><tr><th>GPIO</th><th>Mode</th><th>Repère</th><th>Analogique</th><th>Nom</th><th>Action</th></tr></thead><tbody id="iotConfigRows">${array(profile?.config).map(iotConfigRow).join('')}</tbody></table></div>
    <div class="iot-config-buttons"><button type="button" class="button" data-iot-config-add>Ajouter une broche</button><button class="button" type="submit"${iotState.pending ? ' disabled' : ''}>Enregistrer le profil</button></div>
    <p class="muted">Cet enregistrement ne modifie aucun appareil. Modifier un profil conserve les affectations déjà enregistrées.</p></form>`;
}
function iotAppliedHtml(data) {
  const observed = data.observed;
  if (!observed) return '<p class="notice warning">Aucune configuration déclarée par cet appareil. Le micrologiciel doit prendre en charge les profils et minuteries avant tout envoi.</p>';
  const outputs = new Map(array(observed.outputs).map(row => [row.io, row]));
  return `<div class="iot-config-observed"><h4>Configuration déclarée par l’appareil</h4><p>${data.observedFresh ? 'Reçue' : 'Dernière connue, devenue ancienne'} ${e(iotAge(observed.receivedAt))} · ${e(observed.timezone || 'Fuseau inconnu')} · ${observed.clockValid ? `heure locale : ${e(observed.localTime)}` : 'heure non synchronisée : aucune activation quotidienne'}.</p>
    ${observed.lastError ? `<p class="notice warning">L’appareil signale : ${e(observed.lastError)}</p>` : ''}
    <div class="table-wrap" tabindex="0" role="region" aria-label="Configuration déclarée"><table><thead><tr><th>GPIO</th><th>Nom / repère</th><th>Mode</th><th>État déclaré</th></tr></thead><tbody>${array(observed.config).map(pin => {
      const output = outputs.get(pin.io);
      return `<tr><th>${e(pin.io)}</th><td>${e(pin.name || pin.lbl || '—')}</td><td>${e(iotConfigModes[pin.mode] || pin.mode)}${pin.isA ? ' analogique' : ''}</td><td>${output ? `${output.available ? output.active ? 'ON' : 'OFF' : 'Réservée, indisponible'}${output.inverted ? ' · polarité inversée' : ''}` : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="4">Aucune broche configurée.</td></tr>'}</tbody></table></div>
    <h4>Minuteries déclarées par l’appareil</h4><div class="table-wrap"><table><thead><tr><th>GPIO</th><th>Début → fin</th><th>État</th><th>Prochain début déclaré</th></tr></thead><tbody>${array(observed.timers).map(row => `<tr><th>${e(row.io)}</th><td>${e(row.tStart)} → ${e(row.tStop)}${row.tStart > row.tStop ? ' · passe minuit' : ''}</td><td>${row.enabled ? 'Activée' : 'Désactivée'}</td><td>${row.nextStart ? e(date(row.nextStart)) : '—'}</td></tr>`).join('') || '<tr><td colspan="4">Aucune minuterie déclarée.</td></tr>'}</tbody></table></div>
    <p class="muted">Ce retour décrit la configuration et les niveaux lus par le micrologiciel; il ne prouve pas le mouvement d’un moteur ni l’état d’un relais.</p></div>`;
}
function iotConfigurationHtml() {
  const data = iotConfiguration.data;
  if (iotConfiguration.error) return `<article class="card"><h3>Profils et minuteries</h3><p class="notice warning">${e(iotConfiguration.error)}</p><button type="button" class="button" data-iot-config-refresh>Actualiser la configuration</button></article>`;
  if (!data || iotConfiguration.device !== iotState.selected) return '<article class="card"><h3>Profils et minuteries</h3><p>Lecture de la configuration…</p></article>';
  const block = iotConfigBlock();
  const profileOptions = iotConfiguration.profiles.map(row => `<option value="${e(row.id)}"${row.id === data.profileName ? ' selected' : ''}>${e(row.id)} · version ${row.revision}</option>`).join('');
  const outputs = array(data.observed?.outputs).filter(row => row.available);
  const editedTimer = array(data.timers).find(row => row.io === outputs[0]?.io);
  return `<div class="iot-config-space"><article class="card"><header class="iot-config-heading"><h3>Profils et minuteries</h3><button type="button" class="button" data-iot-config-refresh${iotState.pending ? ' disabled' : ''}>Actualiser la configuration</button></header>
    <p>Un profil conserve le nom et les champs GPIO, mode, repère, analogique et nom du format historique. Les horaires s’exécutent dans l’appareil, même si MQTT se déconnecte.</p>
    <p id="iotConfigNote" class="iot-feedback" role="status">${e(iotConfiguration.note)}</p>
    ${data.operation ? `<p>Dernière tentative : ${e(({ published: 'publiée, application non confirmée', acknowledged: 'configuration appliquée déclarée par l’appareil', uncertain: 'résultat incertain', not_sent: 'non envoyée', resolved_not_applied: 'vérifiée, configuration non appliquée' })[data.operation.outcome] || 'envoi à vérifier')} · <span class="mono">${e(data.operation.id)}</span>.</p>` : ''}
    ${block ? `<p class="notice warning">Envoi indisponible : ${e(block)}.</p>` : ''}
    ${data.inFlight ? `<p class="notice warning">Tentative ${e(data.inFlight)} : ${e(({ dispatching: 'envoi en cours ou résultat inconnu', published: 'publiée, application non confirmée', uncertain: 'peut-être envoyée' })[data.operation?.outcome] || 'résultat à vérifier')}. Aucun nouvel envoi tant que cette tentative n’est pas vérifiée.</p>
      <button type="button" class="button" data-iot-config-resolve>Terminer cette tentative d’après le dernier état déclaré</button>` : ''}
    <div id="iotConfigConfirmation">${iotConfigConfirmationHtml()}</div>${iotAppliedHtml(data)}</article>
    <details class="card"><summary>Créer ou modifier un profil</summary><label>Profil à modifier<select id="iotProfileEditorSelect"><option value="">Nouveau profil</option>${iotConfiguration.profiles.map(row => `<option value="${e(row.id)}"${row.id === iotConfiguration.editor ? ' selected' : ''}>${e(row.id)} · version ${row.revision}</option>`).join('')}</select></label><div id="iotProfileEditorBox">${iotProfileEditorHtml()}</div></details>
    <details class="card"><summary>Affecter et envoyer un profil</summary><p>Profil enregistré pour cet appareil : <strong>${e(data.profileName || 'Aucun')}</strong>${data.profileName ? ` · version ${data.profileRevision}` : ''}.</p>
      <form id="iotProfileAssignment"><label>Profil<select name="profileName"><option value="">Aucun profil</option>${profileOptions}</select></label><button class="button" type="submit"${iotState.pending ? ' disabled' : ''}>Enregistrer l’affectation</button></form>
      <p class="muted">L’affectation seule n’envoie rien. Elle conserve une copie de la version choisie.</p>
      <label class="iot-config-check"><input id="iotRestoreProfile" type="checkbox"${data.restoreOnBoot ? ' checked' : ''}>Autoriser Data à répondre aux demandes de configuration lors des prochains démarrages</label>
      <p class="muted">${data.restoreOnBoot ? 'Réponse aux prochains démarrages autorisée pour la version enregistrée.' : 'Réponse automatique aux prochains démarrages désactivée.'} La configuration déjà sauvegardée dans l’appareil reste locale.</p>
      <button type="button" class="button" data-iot-profile-prepare${block || !data.profileName ? ' disabled' : ''}>Préparer l’envoi du profil</button></details>
    <details class="card"><summary>Minuteries quotidiennes par sortie</summary><p>Heure locale de l’appareil : ${e(data.observed?.timezone || 'inconnue')}. Après un redémarrage, les sorties minutées restent OFF jusqu’au prochain début de créneau avec une heure valide.</p>
      <form id="iotTimerEditor"><label>Sortie<select name="io" id="iotTimerGPIO">${outputs.map(row => `<option value="${row.io}">GPIO ${row.io}</option>`).join('') || '<option value="">Aucune sortie disponible</option>'}</select></label>
      <label>Début<input name="tStart" type="time" step="1" required value="${e(editedTimer?.tStart || '06:00:00')}"></label><label>Fin<input name="tStop" type="time" step="1" required value="${e(editedTimer?.tStop || '23:59:59')}"></label>
      <label class="iot-config-check"><input name="enabled" type="checkbox"${editedTimer?.enabled ? ' checked' : ''}>Minuterie activée</label><button class="button" type="submit"${iotState.pending || !outputs.length ? ' disabled' : ''}>Enregistrer les horaires</button></form>
      <p class="muted">Enregistrer garde les horaires dans Data sans les envoyer. Pour arrêter une minuterie, décoche « Minuterie activée », enregistre, puis confirme son envoi ci-dessous.</p>
      <div class="table-wrap"><table><thead><tr><th>GPIO</th><th>Début → fin</th><th>Enregistrée dans Data</th><th>Application</th></tr></thead><tbody>${array(data.timers).map(row => `<tr><th>${row.io}</th><td>${e(row.tStart)} → ${e(row.tStop)}</td><td>${row.enabled ? 'Activée' : 'Désactivée'}</td><td><button type="button" class="button" data-iot-timer-prepare="${row.io}"${block ? ' disabled' : ''}>Préparer ${row.enabled ? 'l’envoi' : 'la désactivation'}</button></td></tr>`).join('') || '<tr><td colspan="4">Aucun horaire enregistré.</td></tr>'}</tbody></table></div></details></div>`;
}
function iotConfigConfirmationHtml() {
  const armed = iotConfiguration.armed;
  if (!armed) return '';
  return `<section class="iot-command-confirm" role="group" aria-label="Confirmer l’application"><h4>${armed.kind === 'profile' ? 'Envoyer ce profil' : 'Envoyer cette minuterie'} à ${e(armed.id)}</h4>
    <p>Cette étape n’a rien envoyé. L’envoi suivant atteint cet appareil et peut changer ses sorties.</p><dl><dt>Appareil</dt><dd>${e(armed.id)}</dd><dt>Messages MQTT</dt><dd>${armed.messages.map(row => `<p class="mono">${e(row.topic)}<br>${e(row.payload)}</p>`).join('')}</dd>
    <dt>Envoi</dt><dd>QoS 0, non conservé, sans mise en file ni nouvelle tentative automatique.</dd></dl>
    ${armed.kind === 'profile' ? `<p>${armed.body.restoreOnBoot ? 'Tu autorises aussi les réponses à cet appareil aux prochains démarrages.' : 'Aucune réponse automatique aux prochains démarrages.'}</p>` : ''}
    <button type="button" class="button" data-iot-config-confirm>Confirmer l’envoi</button><button type="button" class="button" data-iot-config-cancel>Annuler</button><p>Confirmation valable 20 secondes.</p></section>`;
}
function iotConfigPrepare(kind, io = null) {
  iotConfigDisarm(); iotCommandDisarm();
  const block = iotConfigBlock();
  if (block || iotState.pending) return;
  const data = iotConfiguration.data, id = iotState.selected;
  const body = { requestId: crypto.randomUUID(), revision: data.revision };
  let messages, suffix;
  if (kind === 'profile') {
    if (!data.profileName) return;
    body.restoreOnBoot = document.querySelector('#iotRestoreProfile').checked;
    messages = [{ topic: `esp32/${id}/configIOs`, payload: JSON.stringify(data.config) }]; suffix = '/profile/apply';
  } else {
    const row = data.timers.find(timer => timer.io === io); if (!row) return;
    messages = row.enabled ? [{ topic: `esp32/${id}/io/sunrise`, payload: `${io}:${row.tStart}` }, { topic: `esp32/${id}/io/nightfall`, payload: `${io}:${row.tStop}` }]
      : [{ topic: `esp32/${id}/io/timer/disable`, payload: String(io) }]; suffix = `/timers/${io}/apply`;
  }
  iotConfiguration.armed = { kind, id, body, messages, suffix, expiresAt: Date.now() + 20000 };
  iotConfiguration.timeout = setTimeout(() => { iotConfigDisarm('Confirmation expirée. Rien n’a été envoyé.'); iotPaint('#iotConfigConfirmation', ''); }, 20000);
  iotPaint('#iotConfigConfirmation', iotConfigConfirmationHtml());
  document.querySelector('#iotConfigConfirmation')?.scrollIntoView({ block: 'nearest' });
}
async function iotConfigWork(work, success, application = false) {
  if (iotState.pending || state.tab !== 'iot') return;
  const id = iotState.selected, seq = state.renderSeq;
  iotState.pending = true;
  let succeeded = false;
  try {
    const result = await work();
    if (id !== iotState.selected || seq !== state.renderSeq || state.tab !== 'iot') return;
    iotConfiguration.note = typeof success === 'function' ? success(result) : success;
    succeeded = true;
    await iotConfigurationLoad();
  } catch (error) {
    if (id === iotState.selected && seq === state.renderSeq && state.tab === 'iot') {
      iotConfiguration.note = error.message;
      const note = document.querySelector('#iotConfigNote'); if (note) note.textContent = error.message;
      if (application) await iotConfigurationLoad();
    }
  } finally {
    iotState.pending = false;
    if ((succeeded || application) && id === iotState.selected && seq === state.renderSeq && state.tab === 'iot') iotPaint('#iotConfiguration', iotConfigurationHtml());
  }
}
function iotConfigSend() {
  if (state.tab !== 'iot') { iotConfigDisarm(); return; }
  const armed = iotConfiguration.armed;
  if (!armed || armed.id !== iotState.selected || armed.expiresAt <= Date.now() || iotConfigBlock() || iotState.pending) { iotConfigDisarm(); return; }
  iotConfigDisarm();
  return iotConfigWork(() => api(`${iotPath(armed.id)}${armed.suffix}`, { method: 'POST', payload: armed.body }), result => ({
    published: 'Publié. L’application par l’appareil reste à confirmer.', acknowledged: 'L’appareil a déclaré la configuration appliquée.',
    not_sent: 'Non envoyé. Rien n’a été mis en file.', uncertain: 'Peut-être envoyé. Actualise la configuration pour vérifier cette tentative.',
    dispatching: 'Résultat de l’envoi à vérifier.'
  })[result.outcome] || 'Résultat à vérifier dans la configuration déclarée.', true);
}
function iotTimerFill() {
  const form = document.querySelector('#iotTimerEditor'); if (!form) return;
  const row = array(iotConfiguration.data?.timers).find(timer => timer.io === Number(form.elements.io.value));
  form.elements.tStart.value = row?.tStart || '06:00:00'; form.elements.tStop.value = row?.tStop || '23:59:59'; form.elements.enabled.checked = row?.enabled === true;
}
document.addEventListener('submit', event => {
  const form = event.target;
  if (state.tab !== 'iot' || !['iotProfileEditor', 'iotProfileAssignment', 'iotTimerEditor'].includes(form.id)) return;
  event.preventDefault(); iotConfigDisarm();
  if (form.id === 'iotProfileEditor') {
    const name = form.elements.profileName.value.trim();
    const config = [...form.querySelectorAll('[data-iot-config-row]')].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input =>
      [input.dataset.field, input.dataset.field === 'isA' ? input.checked : input.dataset.field === 'io' ? Number(input.value) : input.value])));
    const revision = name === form.dataset.name ? Number(form.dataset.revision) : 0;
    return iotConfigWork(() => api(`/iot/profiles/${encodeURIComponent(name)}`, { method: 'PUT', payload: { revision, config } }), 'Profil enregistré. Aucun appareil n’a été modifié.');
  }
  const revision = iotConfiguration.data.revision, id = iotState.selected;
  if (form.id === 'iotProfileAssignment') {
    const profileName = form.elements.profileName.value || null;
    const profile = iotConfiguration.profiles.find(row => row.id === profileName);
    return iotConfigWork(() => api(`${iotPath(id)}/profile`, { method: 'PUT', payload: { revision, profileName, profileRevision: profile?.revision || 0 } }), 'Affectation enregistrée. Rien n’a été envoyé.');
  }
  const io = Number(form.elements.io.value);
  const normalize = value => value.length === 5 ? `${value}:00` : value;
  return iotConfigWork(() => api(`${iotPath(id)}/timers/${io}`, { method: 'PUT', payload: { revision, io, tStart: normalize(form.elements.tStart.value), tStop: normalize(form.elements.tStop.value), enabled: form.elements.enabled.checked } }), 'Horaires enregistrés dans Data. Rien n’a été envoyé.');
});
document.addEventListener('click', event => {
  if (state.tab !== 'iot') return;
  const target = event.target;
  if (target.closest('[data-iot-config-confirm]')) return iotConfigSend();
  if (target.closest('[data-iot-config-cancel]')) { iotConfigDisarm('Envoi annulé. Rien n’a été envoyé.'); iotPaint('#iotConfigConfirmation', ''); return; }
  if (target.closest('[data-iot-config-refresh]')) { iotConfigDisarm(); return iotConfigurationLoad(); }
  if (target.closest('[data-iot-profile-prepare]')) return iotConfigPrepare('profile');
  const timer = target.closest('[data-iot-timer-prepare]'); if (timer) return iotConfigPrepare('timer', Number(timer.dataset.iotTimerPrepare));
  if (target.closest('[data-iot-config-add]')) { iotConfigDisarm(); document.querySelector('#iotConfigRows').insertAdjacentHTML('beforeend', iotConfigRow()); }
  if (target.closest('[data-iot-config-remove]')) { iotConfigDisarm(); target.closest('[data-iot-config-row]').remove(); }
  if (target.closest('[data-iot-config-resolve]')) {
    const data = iotConfiguration.data;
    if (!data?.inFlight || !data.observedFresh) return;
    return iotConfigWork(() => api(`${iotPath(iotState.selected)}/operations/${encodeURIComponent(data.inFlight)}/resolve`, { method: 'POST', payload: { observedBootId: data.observed.bootId, observedSerial: data.observed.serial } }), 'Tentative vérifiée d’après le dernier état déclaré. Aucun message n’a été envoyé.');
  }
});
document.addEventListener('change', event => {
  if (state.tab !== 'iot') return;
  if (event.target.id === 'iotProfileEditorSelect') { iotConfiguration.editor = event.target.value; iotPaint('#iotProfileEditorBox', iotProfileEditorHtml()); }
  if (event.target.id === 'iotTimerGPIO') iotTimerFill();
});
document.addEventListener('input', event => {
  if (event.target.closest?.('#iotConfiguration') && iotConfiguration.armed) { iotConfigDisarm('Formulaire modifié. Rien n’a été envoyé.'); iotPaint('#iotConfigConfirmation', ''); }
});
window.addEventListener('hashchange', () => iotConfigDisarm());
