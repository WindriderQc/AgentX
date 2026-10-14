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
  const microphoneLabels = { unknown: 'permission not checked', prompt: 'permission to request',
    granted: 'permission granted', denied: 'permission denied', unavailable: 'microphone unavailable' };
  const rows = [
    ['Private access', privacy.accessMode === 'token' ? 'Native token required'
      : 'Private LAN: no account or code required'],
    ['Normal reply', routeReady('analysis') ? 'Model configured' : 'Model not confirmed'],
    ['Deep reply', routeReady('deep_reasoning') ? 'Model configured' : 'Model not confirmed'],
    ['Automatic reflection', setupCapabilities.review?.automatic ? 'On' : 'Off'],
    ['Local voice', !setupCapabilities.voice?.enabled ? 'Optional, not configured'
      : state.voice.reachable ? 'VoiX reachable' : 'Configured, VoiX unavailable'],
    ['This browser’s microphone', !window.isSecureContext ? 'HTTPS or localhost required'
      : !navigator.mediaDevices?.getUserMedia ? 'Capture not supported' : microphoneLabels[setupMicrophone]],
    ['Content leaving the LAN', typeof frontierSetupLabel === 'function' ? frontierSetupLabel()
      : 'Off: replies and reviews stay on the local lanes']
  ];
  container.innerHTML = rows.map(([label, value]) => `<div class="state-item"><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(value)}</small></div></div>`).join('');
  $('testSetupMicrophone').disabled = !window.isSecureContext || !navigator.mediaDevices?.getUserMedia;
}

async function refreshSetup() {

  const generation = ++setupGeneration;
  $('setupNotice').textContent = 'Checking…';
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
    $('setupNotice').textContent = 'Setup checked. No audio was recorded.';
  } catch (error) {
    if (generation === setupGeneration) $('setupNotice').textContent = error.message;
  }
}

function wireSetup() {
  $('refreshSetup').addEventListener('click', refreshSetup);
}
