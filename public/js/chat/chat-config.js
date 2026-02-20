/**
 * Chat config — Settings persistence, form hydration, config summary, RAG options
 */
import { STORAGE_KEYS, DEFAULTS } from './chat-constants.js';

export function loadSettings(defaults) {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw);
    if (parsed.host === 'localhost' && defaults.host !== 'localhost') {
      parsed.host = defaults.host;
      parsed.port = defaults.port;
    }
    return {
      ...defaults,
      ...parsed,
      options: { ...defaults.options, ...(parsed.options || {}) },
    };
  } catch (e) {
    console.warn('Failed to read saved settings', e);
    return { ...defaults };
  }
}

export function readOptions(elements) {
  return {
    temperature: Number(elements.temperature.value),
    top_p: Number(elements.topP.value),
    top_k: Number(elements.topK.value),
    num_ctx: Number(elements.numCtx.value),
    repeat_penalty: Number(elements.repeatPenalty.value),
    presence_penalty: Number(elements.presencePenalty.value),
    frequency_penalty: Number(elements.frequencyPenalty.value),
    num_predict: Number(elements.numPredict.value),
    seed: elements.seed.value || '',
    stop: elements.stopSequences.value,
    keep_alive: elements.keepAlive.value,
  };
}

export function persistSettings(elements, state, defaults, refreshMessages, setFeedback) {
  const payload = {
    host: elements.hostInput.value.trim() || defaults.host,
    port: elements.portInput.value.trim() || defaults.port,
    model: elements.modelSelect.value,
    stream: elements.streamToggle.checked,
    tts: elements.ttsToggle.checked,
    ttsProvider: document.getElementById('ttsProviderSelect')?.value || 'browser',
    ttsVoice: elements.ttsVoiceSelect?.value || 'alloy',
    sttProvider: elements.sttProviderSelect?.value || 'auto',
    sttLanguage: elements.sttLanguageSelect?.value || 'en',
    whisperModel: elements.whisperModelSelect?.value || '',
    voiceAutoSend: elements.voiceAutoSend?.checked || false,
    useRag: elements.ragToggle.checked,
    showStats: elements.statsToggle.checked,
    ragExpand: elements.ragExpandQuery?.checked || false,
    ragHybrid: elements.ragHybridSearch?.checked || false,
    ragRerank: elements.ragRerankResults?.checked || false,
    ragCompress: elements.ragCompress?.checked || false,
    ragTopK: parseInt(elements.ragTopK?.value || '5', 10),
    system: elements.systemPrompt.value.trim() || defaults.system,
    options: readOptions(elements),
  };
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(payload));
  state.settings = payload;
  state.showStats = payload.showStats;
  refreshMessages();
  setFeedback('Defaults saved locally.', 'success');
}

export function hydrateForm(elements, state, defaults) {
  const cfg = state.settings;
  state.showStats = cfg.showStats !== undefined ? cfg.showStats : true;

  elements.hostInput.value = cfg.host || defaults.host;
  elements.portInput.value = cfg.port || defaults.port;
  elements.modelSelect.value = cfg.model;
  elements.systemPrompt.value = cfg.system;
  elements.streamToggle.checked = cfg.stream;
  elements.ttsToggle.checked = cfg.tts || false;

  const ttsProviderSelect = document.getElementById('ttsProviderSelect');
  const ttsProviderField = document.getElementById('ttsProviderField');
  if (ttsProviderSelect) ttsProviderSelect.value = cfg.ttsProvider || 'browser';
  if (ttsProviderField) ttsProviderField.style.display = cfg.tts ? '' : 'none';

  if (elements.sttProviderSelect) elements.sttProviderSelect.value = cfg.sttProvider || 'auto';
  if (elements.sttLanguageSelect) elements.sttLanguageSelect.value = cfg.sttLanguage || 'en';
  if (elements.whisperModelSelect) elements.whisperModelSelect.value = cfg.whisperModel || '';
  if (elements.voiceAutoSend) elements.voiceAutoSend.checked = cfg.voiceAutoSend || false;
  if (elements.ttsVoiceSelect) elements.ttsVoiceSelect.value = cfg.ttsVoice || 'alloy';

  elements.ragToggle.checked = cfg.useRag !== undefined ? cfg.useRag : true;
  elements.statsToggle.checked = state.showStats;

  if (elements.ragExpandQuery) elements.ragExpandQuery.checked = cfg.ragExpand || false;
  if (elements.ragHybridSearch) elements.ragHybridSearch.checked = cfg.ragHybrid || false;
  if (elements.ragRerankResults) elements.ragRerankResults.checked = cfg.ragRerank || false;
  if (elements.ragCompress) elements.ragCompress.checked = cfg.ragCompress || false;
  if (elements.ragTopK) elements.ragTopK.value = cfg.ragTopK || 5;
  if (elements.ragTopKValue) elements.ragTopKValue.textContent = cfg.ragTopK || 5;

  elements.temperature.value = cfg.options.temperature;
  elements.topP.value = cfg.options.top_p;
  elements.topK.value = cfg.options.top_k;
  elements.numCtx.value = cfg.options.num_ctx;
  elements.repeatPenalty.value = cfg.options.repeat_penalty;
  elements.presencePenalty.value = cfg.options.presence_penalty;
  elements.frequencyPenalty.value = cfg.options.frequency_penalty;
  elements.numPredict.value = cfg.options.num_predict;
  elements.seed.value = cfg.options.seed || '';
  elements.stopSequences.value = cfg.options.stop || '';
  elements.keepAlive.value = cfg.options.keep_alive || '';

  updateRangeDisplays(elements);
}

export function updateRangeDisplays(elements) {
  document.querySelectorAll('.value[data-for="temperature"]').forEach((el) => {
    el.textContent = elements.temperature.value;
  });
  document.querySelectorAll('.value[data-for="topP"]').forEach((el) => {
    el.textContent = elements.topP.value;
  });
}

export function getRagOptions(elements) {
  const useRag = elements.ragToggle?.checked;
  if (!useRag) return { useRag: false };
  return {
    useRag: true,
    ragExpand: elements.ragExpandQuery?.checked || false,
    ragHybrid: elements.ragHybridSearch?.checked || false,
    ragRerank: elements.ragRerankResults?.checked || false,
    ragCompress: elements.ragCompress?.checked || false,
    ragTopK: parseInt(elements.ragTopK?.value || '5', 10)
  };
}

export function toggleRagOptions(elements) {
  const content = elements.ragOptionsContent;
  const chevron = elements.ragChevron;
  if (!content || !chevron) return;
  const isOpen = content.style.display === 'block';
  content.style.display = isOpen ? 'none' : 'block';
  chevron.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
}

export async function checkRagAvailability(elements) {
  try {
    const response = await fetch('/api/rag/metrics', { credentials: 'include' });
    if (response.ok) {
      const data = await response.json();
      if (data.status === 'success' && data.stats?.totalDocuments > 0) {
        if (elements.ragOptionsPanel) elements.ragOptionsPanel.style.display = 'block';
      } else {
        if (elements.ragOptionsPanel) elements.ragOptionsPanel.style.display = 'none';
      }
    }
  } catch (error) {
    console.warn('RAG availability check failed:', error);
    if (elements.ragOptionsPanel) elements.ragOptionsPanel.style.display = 'none';
  }
}

export function updateConfigSummary(elements) {
  const modelName = elements.modelSelect.value || '—';
  const shortModel = modelName.length > 15 ? modelName.substring(0, 12) + '...' : modelName;

  const summaryModelEl = document.getElementById('summaryModel');
  if (summaryModelEl) summaryModelEl.textContent = shortModel;

  const summaryRagEl = document.getElementById('summaryRag');
  if (summaryRagEl) summaryRagEl.textContent = elements.ragToggle.checked ? 'On' : 'Off';

  const summaryStreamEl = document.getElementById('summaryStream');
  if (summaryStreamEl) summaryStreamEl.textContent = elements.streamToggle.checked ? 'On' : 'Off';

  const summaryTempEl = document.getElementById('summaryTemp');
  if (summaryTempEl) summaryTempEl.textContent = elements.temperature.value;

  const chatConfigEl = document.getElementById('chatConfigSummary');
  if (chatConfigEl) {
    const ragStatus = elements.ragToggle.checked ? '+RAG' : '';
    const streamStatus = elements.streamToggle.checked ? '' : 'No-Stream';
    const extras = [ragStatus, streamStatus].filter(s => s).join(', ');
    const summary = extras ? `${shortModel} (${extras})` : shortModel;
    chatConfigEl.textContent = summary;
  }
}

export async function loadServerConfig(defaults) {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const config = await res.json();
      if (config.ollama) {
        const hostSelect = document.getElementById('hostInput');
        const existingOptions = Array.from(hostSelect.options).map(opt => opt.value);
        if (config.ollama.host && !existingOptions.includes(config.ollama.host)) {
          const option = document.createElement('option');
          option.value = config.ollama.host;
          option.textContent = config.ollama.host;
          hostSelect.insertBefore(option, hostSelect.firstChild);
        }
        if (config.ollama.host) {
          defaults.host = config.ollama.host;
          defaults.port = config.ollama.port;
        }
        return config;
      }
    }
  } catch (err) {
    console.warn('Could not load server config:', err);
  }
  return null;
}

export function targetHost(elements, defaults) {
  const rawHost = elements.hostInput.value.trim() || defaults.host;
  const port = elements.portInput.value.trim() || defaults.port;
  if (/^https?:\/\//i.test(rawHost)) return rawHost.replace(/\/+$/, '');
  if (rawHost.includes(':')) return rawHost;
  return `${rawHost}:${port}`;
}

export function readProfileInputs(elements) {
  return {
    language: elements.memoryLanguage.value.trim(),
    role: elements.memoryRole.value.trim(),
    style: elements.memoryStyle.value.trim(),
  };
}
