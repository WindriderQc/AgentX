import { fetchWithDeadline } from './chat-network.js';

export async function appendOpenClawSource(elements, state) {
  try {
    const response = await fetchWithDeadline('/api/models/execution-sources');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const source = body.sources?.find(entry => entry.id === 'openclaw');
    state.openclawSource = source;
    if (!source?.configured) return;
    const option = document.createElement('option');
    option.value = 'openclaw';
    option.textContent = source.available ? 'OpenClaw · models and agents' : 'OpenClaw · unavailable';
    elements.hostInput.appendChild(option);
    if (state.settings?.hostUrl === 'openclaw' || !state.ollamaHosts?.some(host => host.available)) {
      elements.hostInput.value = 'openclaw';
      if (elements.routingModeSelect) elements.routingModeSelect.value = 'manual';
    }
  } catch { state.openclawSource = { available: false }; }
  syncSourceControls(elements);
}

export function openClawChatState(elements, state) {
  const available = state.openclawSource?.available === true;
  return { available, requiresModel: !elements.modelSelect?.value, mode: 'manual', host: 'openclaw',
    status: available ? 'available' : 'unavailable', unavailableKind: available ? null : 'OpenClaw',
    reason: available ? 'Choose a model alone or a configured OpenClaw agent.' : 'OpenClaw execution source is unavailable.' };
}

export function openClawOptions(elements) {
  // Native agent settings belong to its OpenClaw profile. The Responses API
  // does not attest per-turn generation parameters.
  if (elements.modelSelect?.value?.startsWith('openclaw:agent:')) return {};
  return { ...(elements.temperature.disabled ? {} : { temperature: Number(elements.temperature.value) }), ...(elements.topP.disabled ? {} : { top_p: Number(elements.topP.value) }),
    ...(elements.numPredict.value ? { num_predict: Number(elements.numPredict.value) } : {}),
    ...(!elements.seed.disabled && elements.seed.value ? { seed: Number(elements.seed.value) } : {}) };
}

export function syncSourceControls(elements) {
  const openclaw = elements.hostInput?.value === 'openclaw';
  const agent = openclaw && elements.modelSelect?.value?.startsWith('openclaw:agent:');
  for (const key of ['topK', 'numCtx', 'repeatPenalty', 'presencePenalty', 'frequencyPenalty', 'stopSequences', 'keepAlive']) {
    if (elements[key]) elements[key].disabled = openclaw;
  }
  for (const key of ['temperature', 'topP', 'numPredict', 'seed', 'thinkingToggle']) {
    if (elements[key]) elements[key].disabled = agent;
  }
  let support = {};
  try { support = JSON.parse(elements.modelSelect?.selectedOptions?.[0]?.dataset.parameterSupport || '{}'); } catch { /* default to unqualified */ }
  for (const [key, control] of [['seed', 'seed'], ['topP', 'topP'], ['temperature', 'temperature'], ['thinking', 'thinkingToggle']]) {
    if (openclaw && elements[control]) elements[control].disabled = agent || support[key] !== true;
  }
  if (openclaw && elements.routingModeSelect) elements.routingModeSelect.value = 'manual';
}
