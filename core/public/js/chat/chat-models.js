/**
 * Chat model list and model warmup.
 */
import {
  getHostChatState, getHostPinnedModels, getHostRunningModels, isRouterMode, modelsEquivalent,
  selectedHostPreference, targetHost, updateConfigSummary
} from './chat-config.js';
import { syncSourceControls } from './chat-execution-sources.js';
import { fetchWithDeadline } from './chat-network.js';

export async function fetchModels(ctx, showStatus = true) {
  const { elements, state, defaults, helpers } = ctx;
  if (showStatus) helpers.setStatus('Connecting\u2026');
  try {
    const routerMode = isRouterMode(elements, state);
    const host = targetHost(elements, defaults, { includeRouter: true });
    const hostState = getHostChatState(elements, state, defaults);
    const readinessUi = window.ChatModelReadiness;
    if (!routerMode && !hostState.available) {
      const reason = hostState.reason || 'Chat unavailable for selected host.';
      elements.modelSelect.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = reason;
      elements.modelSelect.appendChild(opt);
      helpers.setStatus(`Unavailable: ${hostState.unavailableKind || hostState.status || 'host'}`, 'error');
      helpers.setFeedback(hostState.reason || 'Selected host is unavailable for chat.', 'error');
      updateConfigSummary(elements);
      return;
    }
    const res = await fetchWithDeadline(`/api/models/all?host=${encodeURIComponent(host)}&status=available&scope=runtime`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    const requireProfiledModels = res.headers.get('x-require-profiled-models') === 'true';
    const modelEvidence = res.headers.get('x-model-evidence') || 'available';
    elements.modelSelect.dataset.requireProfiledModels = requireProfiledModels ? 'true' : 'false';
    elements.modelSelect.dataset.modelEvidence = modelEvidence;
    const models = Array.isArray(data)
      ? data
      : (data.data && data.data.models) || data.data || data.models || [];
    elements.modelSelect.innerHTML = '';
    if (!Array.isArray(models) || models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models found';
      elements.modelSelect.appendChild(opt);
    } else {
      const orderedModels = readinessUi
        ? [...models].sort((left, right) => readinessUi.compareForDropdown(left, right))
        : [...models];
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = routerMode ? 'Model chosen by mode' : 'Select a model\u2026';
      elements.modelSelect.appendChild(placeholder);
      orderedModels.forEach((model) => {
        const opt = document.createElement('option');
        opt.value = model.name;
        if (model.execution) opt.dataset.parameterSupport = JSON.stringify(model.parameterSupport || {});
        if (readinessUi) {
          readinessUi.applyOptionState(opt, model, requireProfiledModels);
        } else {
          opt.textContent = model.name;
        }
        const pref = selectedHostPreference(elements, state, defaults);
        const runningModels = getHostRunningModels(pref);
        const pinnedModels = getHostPinnedModels(pref);
        const isLoaded = runningModels.some((running) => modelsEquivalent(running, model.name));
        const isPinned = pinnedModels.some((pinned) => modelsEquivalent(pinned, model.name));
        if (isLoaded || isPinned) {
          opt.dataset.chatPriority = isLoaded ? 'loaded' : 'pinned';
          const label = isLoaded ? 'loaded' : 'pinned';
          if (!String(opt.textContent || '').includes(label)) {
            opt.textContent = `${opt.textContent || model.name} (${label})`;
          }
        }
        elements.modelSelect.appendChild(opt);
      });
      const requestedModel = !routerMode ? state.requestedRuntime?.model : null;
      const selectableOptions = Array.from(elements.modelSelect.options)
        .filter((option) => option.value && !option.disabled);
      if (requestedModel) {
        const requestedOption = selectableOptions
          .find((option) => modelsEquivalent(option.value, requestedModel));
        if (requestedOption) {
          elements.modelSelect.value = requestedOption.value;
          state.requestedRuntime.error = null;
        } else {
          elements.modelSelect.value = '';
          const requestedHost = state.requestedRuntime.host || host;
          state.requestedRuntime.error = `Requested model ${requestedModel} is unavailable on ${requestedHost}. Choose another model or host to continue.`;
          helpers.setStatus('Requested route unavailable', 'error');
          helpers.setFeedback(state.requestedRuntime.error, 'error');
          updateConfigSummary(elements);
          return;
        }
      } else if (!routerMode && hostState.available) {
        const pref = selectedHostPreference(elements, state, defaults);
        const priorityModels = [
          ...getHostRunningModels(pref),
          ...getHostPinnedModels(pref),
          state.settings.model
        ].filter(Boolean);
        const picked = priorityModels
          .map((candidate) => selectableOptions.find((option) => modelsEquivalent(option.value, candidate)))
          .find(Boolean);
        if (picked) elements.modelSelect.value = picked.value;
      }

      if (!requestedModel && !routerMode && hostState.available && !elements.modelSelect.value) {
        const firstAllowedOption = selectableOptions[0];
        if (firstAllowedOption) elements.modelSelect.value = firstAllowedOption.value;
      }
    }
    syncSourceControls(elements);
    helpers.setStatus('Ready', 'success');
    helpers.setFeedback(
      modelEvidence === 'deferred'
        ? 'Live host inventory is ready. Profiler evidence stays on the Models and Benchmark surfaces so chat startup remains responsive.'
        : requireProfiledModels
        ? 'Models refreshed with profiler gate active.'
        : routerMode
          ? 'Session mode active. Manual model list refreshed but not selected.'
          : hostState.available
            ? (hostState.reason || 'Models refreshed with host runtime data.')
            : (hostState.reason || 'Selected host is unavailable for chat.'),
      hostState.available ? 'success' : 'error'
    );
    updateConfigSummary(elements);
  } catch (err) {
    console.warn('Failed to fetch models:', err.message);
    helpers.setStatus('Connection failed', 'error');
    let userMessage = 'Unable to connect to the selected execution source.';
    if (err.message.includes('EHOSTUNREACH') || err.message.includes('ECONNREFUSED')) {
      userMessage = `Cannot reach ${targetHost(elements, defaults)}. Check the selected execution source.`;
    } else if (err.message.includes('ETIMEDOUT')) {
      userMessage = `Connection timed out.`;
    } else if (err.message.includes('500')) {
      userMessage = err.message;
    }
    helpers.setFeedback(userMessage, 'error');
    elements.modelSelect.innerHTML = '<option value="">\u26a0\ufe0f Connection failed</option>';
  }
}

/**
 * Check if a model is already loaded on the target host, and if not,
 * freeze the input and fire a warmup request so the first real message
 * doesn't time out waiting for model load.
 */
let _warmupAbort = null;

export function cancelModelWarmup(ctx = {}) {
  if (_warmupAbort) {
    _warmupAbort.abort();
    _warmupAbort = null;
  }
  if (ctx.state) ctx.state.warming = false;
  if (ctx.elements) {
    ctx.elements.messageInput.disabled = false;
    ctx.elements.sendBtn.disabled = false;
  }
}

export async function warmupModelIfNeeded(ctx) {
  const { elements, state, defaults, helpers } = ctx;
  if (isRouterMode(elements, state) || elements.hostInput?.value === 'openclaw') return;
  const model = elements.modelSelect.value;
  if (!model) return;

  const host = targetHost(elements, defaults);
  if (!host) return;

  // Abort any in-flight warmup (user switched model/host again)
  if (_warmupAbort) _warmupAbort.abort();

  // Check if model is already loaded via cluster live state
  try {
    const liveRes = await fetch('/api/cluster/schedule/live');
    if (liveRes.ok) {
      const live = await liveRes.json();
      const hostEntry = (live.data?.hosts || []).find(h =>
        h.url && host.includes(new URL(h.url).hostname)
      );
      if (hostEntry?.models?.some(m => m.name === model || m.model === model)) {
        return; // Already loaded, no warmup needed
      }
    }
  } catch { /* fall through to warmup */ }

  // Freeze input while model loads
  const abort = _warmupAbort = new AbortController();
  state.warming = true;
  elements.messageInput.disabled = true;
  elements.messageInput.placeholder = 'Loading model…';
  elements.sendBtn.disabled = true;
  helpers.setStatus('Loading model…', 'muted');
  helpers.setFeedback(`Warming up ${model} — this may take a moment.`, 'muted');

  try {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        message: 'hi',
        messages: [],
        stream: false,
        host: host
      }),
      signal: abort.signal
    });

    helpers.setStatus('Ready', 'success');
    helpers.setFeedback(`${model} loaded and ready.`, 'success');
  } catch (err) {
    if (err.name === 'AbortError') return; // Superseded by newer warmup
    helpers.setStatus('Model load failed', 'error');
    helpers.setFeedback(`Warmup failed: ${err.message}`, 'error');
  } finally {
    if (_warmupAbort === abort) {
      // Only unfreeze if this is still the active warmup
      state.warming = false;
      elements.messageInput.disabled = false;
      elements.messageInput.placeholder = '';
      elements.sendBtn.disabled = false;
      elements.messageInput.focus();
      if (typeof helpers.applyChatAvailability === 'function') {
        helpers.applyChatAvailability();
      }
      _warmupAbort = null;
    }
  }
}
