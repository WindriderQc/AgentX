// Île tab (docs/ISLAND.md): island runs, "Lancer", the Clawblox 3D view and
// the agent's memory files. Reads Benchmark's /api/island; starts nothing.
import { apiFetch } from '../utils/api.js';

const API = '/benchmark/api/island';
const STATES = {
  requested: 'en attente d’un créneau', reserved: 'créneau réservé', dispatching: 'au départ', running: 'en cours',
  uncertain: 'incertain', completed: 'terminée', failed: 'échouée', cancelled: 'annulée'
};
const PHASES = { queued: 'dans la file', starting: 'démarrage', running: 'en cours', stopping: 'arrêt', finished: 'terminée', interrupted: 'interrompue' };
const $ = id => document.getElementById(id);

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** A date with its time zone, never a bare hour. */
export function when(iso, timeZone) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const options = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  try { return new Intl.DateTimeFormat('fr-CA', { ...options, timeZone: timeZone || undefined }).format(date); }
  catch { return new Intl.DateTimeFormat('fr-CA', options).format(date); }
}

export function duration(run) {
  if (run.startedAt && run.endedAt) {
    const minutes = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60000);
    if (Number.isFinite(minutes)) return `${minutes} min (prévu ${run.minutes ?? '?'})`;
  }
  return run.minutes ? `${run.minutes} min prévues` : '—';
}

export function stateLabel(run) {
  const queue = run.queue?.state;
  if (queue && !['completed', 'failed', 'cancelled'].includes(queue)) return { key: queue, text: STATES[queue] || queue };
  if (run.phase === 'running') return { key: 'running', text: PHASES.running };
  if (queue) return { key: queue, text: STATES[queue] };
  if (run.receipt?.state) return { key: run.receipt.state, text: STATES[run.receipt.state] || run.receipt.state };
  return { key: run.phase || 'unknown', text: PHASES[run.phase] || run.phase || 'inconnu' };
}

export function runRowHtml(run) {
  const state = stateLabel(run);
  const slot = run.queue?.reservation?.start && !run.startedAt ? `<small>créneau ${escapeHtml(when(run.queue.reservation.start, run.timeZone))}</small>` : '';
  const outcome = run.outcome && run.outcome !== 'completed' ? `<small>${escapeHtml(run.outcome)}</small>` : '';
  const receipts = [
    `<a href="${API}/runs/${encodeURIComponent(run.id)}" target="_blank" rel="noopener">fiche</a>`,
    run.receipt?.sha256 ? `<small title="${escapeHtml(run.receipt.file || '')}">reçu ${escapeHtml(run.receipt.state)} · ${escapeHtml(run.receipt.sha256.slice(0, 12))}…${run.receipt.runtimeReleased ? '' : ' · libération non prouvée'}</small>` : '',
    run.queue?.releaseReceipt ? `<small>Core : ${escapeHtml(run.queue.releaseReceipt.authority)}</small>` : ''
  ].join('');
  const actions = [
    run.liveView ? `<button type="button" data-live="${escapeHtml(run.liveView)}">Direct</button>` : '',
    run.replayable ? `<button type="button" data-replay="${escapeHtml(run.id)}">Revoir</button>` : '',
    run.hasMemory ? `<button type="button" data-memory="${escapeHtml(run.id)}">Mémoire</button>` : ''
  ].join('');
  return `<tr>
    <td>${escapeHtml(when(run.startedAt || run.requestedAt, run.timeZone))}<small>${escapeHtml(run.agent || '')} · mémoire ${run.memoryMode === 'fresh' ? 'neuve' : 'continue'}</small>${slot}</td>
    <td>${escapeHtml(duration(run))}</td>
    <td class="island-state-${escapeHtml(state.key)}">${escapeHtml(state.text)}${outcome}</td>
    <td><code>${escapeHtml(run.model)}</code></td>
    <td>${escapeHtml(run.resumeCount)}</td>
    <td>${receipts}</td>
    <td>${actions || '—'}</td>
  </tr>`;
}

export function episodesHtml(text) {
  const items = String(text || '').split('\n').filter(line => line.trim()).map(line => {
    try {
      const entry = JSON.parse(line);
      return `<li><time>${escapeHtml(entry.time || '')}</time><div><b>${escapeHtml(entry.summary || '')}</b></div><div>${escapeHtml(entry.detail || '')}</div></li>`;
    } catch { return `<li><pre>${escapeHtml(line)}</pre></li>`; }
  });
  return items.length ? `<ol class="island-episodes">${items.join('')}</ol>` : '<p class="island-note">Aucun épisode.</p>';
}

function showFrame(src) {
  $('island-viewer').hidden = false;
  $('island-frame').src = src;
  $('island-viewer-open').href = src;
  if (location.protocol === 'https:' && src.startsWith('http:')) {
    $('island-viewer-open').textContent = 'Ouvrir dans un nouvel onglet (le navigateur bloque une vue http dans une page https)';
  }
  $('island-viewer').scrollIntoView({ behavior: 'smooth' });
}

let memory = null;
function showMemoryFile(name) {
  document.querySelectorAll('.island-tabs button').forEach(btn => btn.setAttribute('aria-selected', String(btn.dataset.file === name)));
  const file = memory?.files?.[name];
  const body = $('island-memory-body');
  if (!file) { body.innerHTML = '<p class="island-note">Fichier absent pour cette partie.</p>'; return; }
  const note = file.truncated ? `<p class="island-note">Fin du fichier seulement (${file.bytes} octets).</p>` : '';
  body.innerHTML = note + (name.endsWith('.jsonl') ? episodesHtml(file.text) : `<pre>${escapeHtml(file.text)}</pre>`);
}
async function openMemory(id) {
  memory = (await apiFetch(`${API}/runs/${encodeURIComponent(id)}/memory`)).data;
  $('island-memory').hidden = false;
  $('island-memory-run').innerHTML = memory.runs.map(run => `<option value="${escapeHtml(run.id)}"${run.id === id ? ' selected' : ''}>${escapeHtml(when(run.startedAt || run.endedAt, run.timeZone))} · ${run.memoryMode === 'fresh' ? 'neuve' : 'continue'}</option>`).join('');
  showMemoryFile('SEMANTIC_MEMORY.md');
  $('island-memory').scrollIntoView({ behavior: 'smooth' });
}

async function loadRuns() {
  const status = $('island-runs-status');
  try {
    const data = (await apiFetch(`${API}/runs`)).data;
    $('island-runs').innerHTML = data.runs.map(runRowHtml).join('') || '<tr><td colspan="7">Aucune partie.</td></tr>';
    const notes = [];
    if (!data.queueRead) notes.push('La file de Core est illisible : les états affichés viennent des derniers rapports.');
    if (!data.view.live) notes.push('Vue en direct non configurée (AGENTX_ISLAND_VIEW_ORIGIN).');
    if (!data.view.replay) notes.push('Serveur de relecture non configuré (AGENTX_ISLAND_REPLAY_URL).');
    status.textContent = notes.join(' ');
  } catch (err) {
    status.textContent = `Lecture impossible : ${err.message}`;
  }
}

function bind() {
  $('island-launch-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const result = $('island-launch-result');
    result.classList.remove('is-error');
    result.textContent = 'Inscription…';
    try {
      const data = (await apiFetch(`${API}/launch`, { method: 'POST', body: {
        clientKey: crypto.randomUUID(), agent: form.get('agent'), minutes: Number(form.get('minutes')),
        memory: form.get('memory'), when: form.get('when') } })).data;
      result.textContent = data.placed
        ? `Demande ${data.id} inscrite, créneau ${when(data.placed.start)}. Le départ attend ton approbation et l’admission de Core.`
        : `Demande ${data.id} inscrite (${STATES[data.state] || data.state}). ${data.note || ''}`;
      loadRuns();
    } catch (err) {
      result.classList.add('is-error');
      result.textContent = `Rien n’a été inscrit : ${err.message}`;
    }
  });
  $('island-runs').addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    try {
      if (button.dataset.live) showFrame(button.dataset.live);
      if (button.dataset.replay) showFrame((await apiFetch(`${API}/runs/${encodeURIComponent(button.dataset.replay)}/replay`, { method: 'POST', body: {} })).data.src);
      if (button.dataset.memory) await openMemory(button.dataset.memory);
    } catch (err) {
      $('island-runs-status').textContent = err.message;
    }
  });
  document.querySelector('.island-tabs').addEventListener('click', event => {
    if (event.target.dataset.file) showMemoryFile(event.target.dataset.file);
  });
  $('island-memory-run').addEventListener('change', event => openMemory(event.target.value));
}

if (typeof document?.getElementById === 'function' && document.getElementById('island-runs')) {
  bind();
  loadRuns();
  setInterval(() => { if (!document.hidden) loadRuns(); }, 30000);
}
