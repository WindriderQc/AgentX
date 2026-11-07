// public/js/model-profiler/lanes.js
/**
 * Lane capability section of the Profiler page (#832). Reads Benchmark
 * evidence and, on request, records Full-profile requests in Core's
 * heavy-work queue and plans their night slots. Nothing here runs a model;
 * Core starts a planned measurement at its time only when the owner chose so.
 */

import { renderLaneCard, renderLaneSummary, buildMeasureRequest, campaignTargets, campaignText,
  renderCampaignPlan, campaignResultText, clock, setCoreBase } from './components/lane-capability.js?v=pinned-fit-1130';

const LANES_API = '/benchmark/api/profiler/evidence/lanes';
const MEASURE_API = '/benchmark/api/profiler/evidence/lanes/measure';
const CAMPAIGN_API = '/benchmark/api/profiler/evidence/lanes/campaign';

let current = [];
const fitRequests = new Map();

async function requestFit(lane, button, status, root) {
  const key = `${lane.capability.hostId}:${lane.pinIndex}`;
  // Retain the same intent across clicks, refresh and a lost HTTP reply.
  const storageKey = `profiler-pinned-fit:${key}`;
  let requestId = fitRequests.get(key) || sessionStorage.getItem(storageKey);
  button.disabled = true;
  status.textContent = 'Recording a manual fit request…';
  try {
    const persisted = lane.pinnedFit;
    if (!requestId && persisted?.id && !(persisted.runtimeReleased === true
      && ['completed', 'failed', 'cancelled'].includes(persisted.state))) {
      // Core's persisted intent survives a new tab/device without local cache.
      requestId = persisted.id;
      sessionStorage.setItem(storageKey, requestId);
      fitRequests.set(key, requestId);
    }
    let requestHostId = lane.capability.hostId, requestPinIndex = lane.pinIndex;
    if (requestId) {
      let original = lane.pinnedFit?.id === requestId ? lane.pinnedFit : null;
      if (!original) {
        // Another tab may have completed a newer request. Its receipt says
        // nothing about this tab's original, potentially uncertain intent.
        const response = await fetch(`/benchmark/api/profiler/fit-checks/${encodeURIComponent(requestId)}`, { cache: 'no-store' });
        if (response.ok) {
          const answer = await response.json();
          if (answer.status !== 'success' || answer.data?.id !== requestId) throw new Error('Original fit receipt is incomplete');
          original = answer.data;
        } else if (response.status !== 404) throw new Error('Original fit receipt is unavailable');
        // A missing record does not establish termination. Retry the same UUID.
      }
      if (original?.runtimeReleased === true && ['completed', 'failed', 'cancelled'].includes(original.state)) requestId = null;
      else if (original && !['requested'].includes(original.state)) {
        status.textContent = `Original fit ${requestId} is ${original.state || 'unknown'}; inspect its native receipt in Calendar. No new request was recorded.`;
        button.disabled = false;
        return;
      }
      else if (original?.state === 'requested') {
        if (!original.hostId || !Number.isInteger(original.pinIndex)) {
          status.textContent = `Original fit ${requestId} has incomplete scope; inspect its receipt. No new request was recorded.`;
          button.disabled = false;
          return;
        }
        requestHostId = original.hostId;
        requestPinIndex = original.pinIndex;
      }
    }
    if (!requestId) {
      requestId = crypto.randomUUID();
      sessionStorage.setItem(storageKey, requestId);
      fitRequests.set(key, requestId);
    }
    const response = await fetch('/benchmark/api/profiler/fit-checks/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, hostId: requestHostId, pinIndex: requestPinIndex })
    });
    const answer = await response.json();
    if (!response.ok || answer.status !== 'success') throw new Error(answer.error || `Benchmark answered ${response.status}`);
    status.textContent = answer.data?.state === 'requested'
      ? 'Manual request recorded. Plan its slot and use Run now in Automations → Calendar.'
      : `Original fit receipt: ${answer.data?.state || 'unknown'}. Inspect it in Calendar; no new request was recorded.`;
    await renderLanes(root);
  } catch (error) {
    status.textContent = `Receipt unavailable: ${error.message}. Retry this same request; inspect Calendar before starting anything.`;
    button.disabled = false;
  }
}

function setBusy(grid, busy) {
  grid.setAttribute('aria-busy', busy ? 'true' : 'false');
}

async function submitMeasure(lane, button, status, root) {
  button.disabled = true;
  status.textContent = 'Planning tonight\u2019s measurement…';
  status.className = 'lc-action-status';
  try {
    const response = await fetch(MEASURE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...buildMeasureRequest(lane), autoStart: true })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== 'success') throw new Error(result.error || `Benchmark answered ${response.status}`);
    const slot = result.data?.slot || {};
    status.textContent = slot.planned
      ? `Planned ${clock(slot.start)}–${clock(slot.end)}; Core starts it then.`
      : `Recorded without a slot: ${slot.note || 'plan it in Automations → Calendar.'}`;
    status.className = slot.planned ? 'lc-action-status is-done' : 'lc-action-status is-error';
    if (slot.planned) setTimeout(() => renderLanes(root), 1200);
  } catch (error) {
    status.textContent = `Not recorded: ${error.message}. Nothing was started.`;
    status.className = 'lc-action-status is-error';
    button.disabled = false;
  }
}

export async function renderLanes(root) {
  const grid = root.querySelector('#profiler-lanes-grid');
  const summary = root.querySelector('#profiler-lanes-summary');
  if (!grid) return;
  setBusy(grid, true);
  try {
    const response = await fetch(LANES_API, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || body.status !== 'success') throw new Error(body.error || `Benchmark answered ${response.status}`);
    current = Array.isArray(body.data?.lanes) ? body.data.lanes : [];
    if (summary) summary.innerHTML = renderLaneSummary(current);
    grid.innerHTML = current.length
      ? current.map((lane, index) => renderLaneCard(lane, index)).join('')
      : '<p class="lc-empty">No pinned or routed model was found. Pin a model or route a task to a host first.</p>';
  } catch (error) {
    if (summary) summary.innerHTML = '';
    grid.innerHTML = `<p class="lc-empty lc-empty--error">Lane capabilities are unavailable: ${String(error.message || error).replace(/[<>&]/g, '')}</p>`;
  } finally {
    setBusy(grid, false);
  }
}

function initCampaign(root) {
  const open = root.querySelector('#profiler-lanes-campaign');
  const panel = root.querySelector('#profiler-lanes-campaign-panel');
  const text = root.querySelector('#profiler-lanes-campaign-text');
  const planBox = root.querySelector('#profiler-lanes-campaign-plan');
  const auto = root.querySelector('#profiler-lanes-campaign-auto');
  const confirm = root.querySelector('#profiler-lanes-campaign-confirm');
  const cancel = root.querySelector('#profiler-lanes-campaign-cancel');
  const status = root.querySelector('#profiler-lanes-campaign-status');
  if (!open || !panel) return;
  let night = null;
  const close = () => { panel.hidden = true; open.setAttribute('aria-expanded', 'false'); open.focus(); };
  const setStatus = (message, tone = '') => { status.textContent = message; status.className = `lc-campaign-status${tone ? ` is-${tone}` : ''}`; };
  open.addEventListener('click', async () => {
    const targets = campaignTargets(current);
    text.textContent = campaignText(targets);
    planBox.innerHTML = '';
    confirm.hidden = targets.length === 0;
    auto.closest('label').hidden = targets.length === 0;
    confirm.disabled = true;
    setStatus('');
    panel.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    if (!targets.length) { cancel.focus(); return; }
    night = buildMeasureRequest(targets[0]);
    planBox.innerHTML = '<p class="lc-plan-note">Placing each lane in tonight\u2019s window…</p>';
    try {
      const query = new URLSearchParams({ notBefore: night.notBefore, startBefore: night.startBefore });
      const response = await fetch(`${CAMPAIGN_API}/plan?${query}`, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.status !== 'success') throw new Error(result.error || `Benchmark answered ${response.status}`);
      planBox.innerHTML = renderCampaignPlan(result.data, targets)
        + (result.data.queueRead ? '' : '<p class="lc-plan-note is-warn">The queue could not be read, so other planned work is not shown; Core still refuses an overlapping slot.</p>');
      const fitting = result.data.slots.filter(slot => slot.fits).length;
      confirm.textContent = `Plan ${fitting} ${fitting === 1 ? 'measurement' : 'measurements'}`;
      confirm.disabled = fitting === 0;
      confirm.focus();
    } catch (error) {
      planBox.innerHTML = '';
      setStatus(`The night plan is unavailable: ${error.message}. Nothing was recorded.`, 'error');
    }
  });
  cancel.addEventListener('click', close);
  confirm.addEventListener('click', async () => {
    if (!night) return;
    confirm.disabled = true;
    setStatus('Recording and planning…');
    try {
      const response = await fetch(CAMPAIGN_API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notBefore: night.notBefore, startBefore: night.startBefore, autoStart: auto.checked === true }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.status !== 'success') throw new Error(result.error || `Benchmark answered ${response.status}`);
      const trouble = result.data.results.some(row => row.error || !row.planned);
      setStatus(campaignResultText(result.data), trouble ? 'error' : 'done');
      renderLanes(root);
    } catch (error) {
      setStatus(`Not recorded: ${error.message}. Nothing was started.`, 'error');
      confirm.disabled = false;
    }
  });
}

export function initLanes() {
  const root = document.getElementById('profiler-lanes');
  if (!root) return;
  setCoreBase(root.dataset.corePublicUrl);
  root.addEventListener('click', event => {
    const fitButton = event.target.closest('[data-lane-action="fit"]');
    if (fitButton) {
      const lane = current[Number(fitButton.dataset.laneIndex)];
      const status = fitButton.parentElement.querySelector('.lc-action-status');
      if (lane && status) requestFit(lane, fitButton, status, root);
      return;
    }
    const button = event.target.closest('[data-lane-action="measure"]');
    if (!button) return;
    const lane = current[Number(button.dataset.laneIndex)];
    const status = button.parentElement.querySelector('.lc-action-status');
    if (lane && status) submitMeasure(lane, button, status, root);
  });
  root.querySelector('#profiler-lanes-refresh')?.addEventListener('click', () => renderLanes(root));
  initCampaign(root);
  renderLanes(root);
}
