'use strict';

let setupCapabilities = null;
let setupMicrophone = 'unknown';
let setupGeneration = 0;

function setSetupCapabilities(payload) {
  setupCapabilities = payload;
  renderSetup();
}

function clearSetup() {
  setupGeneration += 1;
  setupCapabilities = null;
  setupMicrophone = 'unknown';
  $('setupChecklist').replaceChildren();
  $('setupNotice').textContent = '';
  $('formulationStatus').textContent = '';
}

function renderSetup() {
  const container = $('setupChecklist');
  if (!setupCapabilities) { container.replaceChildren(); return; }
  const privacy = setupCapabilities.privacy || {};
  const routes = state.routing?.taskConfigState || {};
  const routeReady = task => Boolean(routes[task]?.effective?.model || state.routing?.taskModels?.[task]?.model);
  const microphoneLabels = { unknown: 'permission non vérifiée', prompt: 'permission à demander',
    granted: 'permission accordée', denied: 'permission refusée', unavailable: 'microphone indisponible' };
  const rows = [
    ['Accès privé', privacy.accessMode === 'token' ? 'Jeton natif requis'
      : 'LAN privé : aucun compte ni code exigé'],
    ['Réponse normale', routeReady('analysis') ? 'Modèle configuré' : 'Modèle non confirmé'],
    ['Réponse profonde', routeReady('deep_reasoning') ? 'Modèle configuré' : 'Modèle non confirmé'],
    ['Réflexion automatique', setupCapabilities.review?.automatic ? 'Activée' : 'Désactivée'],
    ['Voix locale', !setupCapabilities.voice?.enabled ? 'Facultative, non configurée'
      : state.voice.reachable ? 'VoiX joignable' : 'Configurée, VoiX indisponible'],
    ['Microphone de ce navigateur', !window.isSecureContext ? 'HTTPS ou localhost requis'
      : !navigator.mediaDevices?.getUserMedia ? 'Capture non prise en charge' : microphoneLabels[setupMicrophone]],
    ['Contenu hors LAN', typeof frontierSetupLabel === 'function' ? frontierSetupLabel()
      : 'Désactivé : les réponses et revues restent sur les voies locales']
  ];
  container.innerHTML = rows.map(([label, value]) => `<div class="state-item"><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(value)}</small></div></div>`).join('');
  $('testSetupMicrophone').disabled = !window.isSecureContext || !navigator.mediaDevices?.getUserMedia;
}

async function refreshSetup() {

  const generation = ++setupGeneration;
  $('setupNotice').textContent = 'Vérification en cours…';
  try {
    const payload = await api('/api/psyx/status', { cache: 'no-store' });
    if (generation !== setupGeneration) return;
    setupCapabilities = payload;
    await Promise.all([loadRouting(), loadVoiceStatus()]);
    if (generation !== setupGeneration) return;
    let permission = null;
    try { permission = await navigator.permissions?.query({ name: 'microphone' }); } catch { /* Some browsers expose permission only on capture. */ }
    if (generation !== setupGeneration) return;
    setupMicrophone = permission?.state || 'unknown';
    renderSetup();
    $('setupNotice').textContent = 'Configuration vérifiée. Aucun audio n’a été enregistré.';
  } catch (error) {
    if (generation === setupGeneration) $('setupNotice').textContent = error.message;
  }
}

function wireSetup() {
  $('refreshSetup').addEventListener('click', refreshSetup);
  $('testSetupMicrophone').addEventListener('click', async () => {

    const generation = ++setupGeneration;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== setupGeneration) return;
      setupMicrophone = 'granted';
      $('setupNotice').textContent = 'Microphone accessible. Le test est terminé; aucun audio n’est conservé.';
    } catch (error) {
      if (generation !== setupGeneration) return;
      setupMicrophone = error.name === 'NotAllowedError' ? 'denied' : 'unavailable';
      $('setupNotice').textContent = 'Vérifie la permission du microphone et le périphérique dans ce navigateur.';
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      if (generation === setupGeneration) renderSetup();
    }
  });
}
