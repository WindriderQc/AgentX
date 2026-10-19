// public/js/model-profiler/lanes.js
/**
 * Lane capability section of the Profiler page (#832). Reads Benchmark
 * evidence and, on request, records Full-profile requests in Core's
 * heavy-work queue and plans their night slots. Nothing here runs a model;
 * Core starts a planned measurement at its time only when the owner chose so.
 */

import { renderLaneCard, renderLaneSummary, buildMeasureRequest, campaignTargets, campaignText,
  renderCampaignPlan, campaignResultText, clock, setCoreBase } from './components/lane-capability.js?v=lane-auto-start-20261019';

const LANES_API = '/benchmark/api/profiler/evidence/lanes';
const MEASURE_API = '/benchmark/api/profiler/evidence/lanes/measure';
const CAMPAIGN_API = '/benchmark/api/profiler/evidence/lanes/campaign';

let current = [];

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
