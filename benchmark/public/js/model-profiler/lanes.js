// public/js/model-profiler/lanes.js
/**
 * Lane capability section of the Profiler page (#832). Reads Benchmark
 * evidence and, on request, records a Full-profile request in Core's
 * heavy-work queue. Nothing here runs a model.
 */

import { renderLaneCard, renderLaneSummary, buildMeasureRequest, campaignTargets, campaignText } from './components/lane-capability.js';

const LANES_API = '/benchmark/api/profiler/evidence/lanes';
const MEASURE_API = '/benchmark/api/profiler/evidence/lanes/measure';
const CAMPAIGN_API = '/benchmark/api/profiler/evidence/lanes/campaign';

let current = [];

function setBusy(grid, busy) {
  grid.setAttribute('aria-busy', busy ? 'true' : 'false');
}

async function submitMeasure(lane, button, status) {
  button.disabled = true;
  status.textContent = 'Recording the request…';
  status.className = 'lc-action-status';
  try {
    const response = await fetch(MEASURE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMeasureRequest(lane))
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== 'success') throw new Error(result.error || `Benchmark answered ${response.status}`);
    status.textContent = 'Requested for tonight. Reserve it in Automations → Calendar to run it.';
    status.className = 'lc-action-status is-done';
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
  const confirm = root.querySelector('#profiler-lanes-campaign-confirm');
  const cancel = root.querySelector('#profiler-lanes-campaign-cancel');
  const status = root.querySelector('#profiler-lanes-campaign-status');
  if (!open || !panel) return;
  const close = () => { panel.hidden = true; open.setAttribute('aria-expanded', 'false'); open.focus(); };
  open.addEventListener('click', () => {
    const targets = campaignTargets(current);
    text.textContent = campaignText(targets);
    confirm.hidden = targets.length === 0;
    confirm.disabled = false;
    confirm.textContent = `Queue ${targets.length} ${targets.length === 1 ? 'request' : 'requests'}`;
    status.textContent = '';
    status.className = 'lc-campaign-status';
    panel.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    (targets.length ? confirm : cancel).focus();
  });
  cancel.addEventListener('click', close);
  confirm.addEventListener('click', async () => {
    const targets = campaignTargets(current);
    if (!targets.length) return;
    confirm.disabled = true;
    status.textContent = 'Recording the requests…';
    try {
      const window = buildMeasureRequest(targets[0]);
      const response = await fetch(CAMPAIGN_API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notBefore: window.notBefore, startBefore: window.startBefore }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.status !== 'success') throw new Error(result.error || `Benchmark answered ${response.status}`);
      const failed = result.data.results.filter(row => row.error).length;
      status.textContent = `${result.data.requested} recorded for tonight${failed ? `, ${failed} not recorded` : ''}. Reserve them in Automations → Calendar to run them.`;
      status.className = failed ? 'lc-campaign-status is-error' : 'lc-campaign-status is-done';
    } catch (error) {
      status.textContent = `Not recorded: ${error.message}. Nothing was started.`;
      status.className = 'lc-campaign-status is-error';
      confirm.disabled = false;
    }
  });
}

export function initLanes() {
  const root = document.getElementById('profiler-lanes');
  if (!root) return;
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-lane-action="measure"]');
    if (!button) return;
    const lane = current[Number(button.dataset.laneIndex)];
    const status = button.parentElement.querySelector('.lc-action-status');
    if (lane && status) submitMeasure(lane, button, status);
  });
  root.querySelector('#profiler-lanes-refresh')?.addEventListener('click', () => renderLanes(root));
  initCampaign(root);
  renderLanes(root);
}
