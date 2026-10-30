// Île tab (docs/ISLAND.md): island runs on the configured terrains, "Lancer",
// the 3D view and the agent's memory files. Reads Benchmark's /api/island; starts nothing.
import { apiFetch } from '../utils/api.js';

const API = '/benchmark/api/island';
const STATES = {
  requested: 'en attente d’un créneau', reserved: 'créneau réservé', dispatching: 'au départ', running: 'en cours',
  uncertain: 'incertain', completed: 'terminée', failed: 'échouée', cancelled: 'annulée'
};
const PHASES = { queued: 'dans la file', starting: 'démarrage', running: 'en cours', stopping: 'arrêt', finished: 'terminée', interrupted: 'interrompue' };
const KINDS = { thought: 'pense', say: 'dit', command: 'commande' };
const HARNESS_LABELS = { codex: 'Codex', dsh: 'DSH', pi: 'Pi' };
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

/** A time of day with its time zone (the thoughts panel). */
export function clock(iso, timeZone) {
  const date = new Date(iso || '');
  if (Number.isNaN(date.getTime())) return '—';
  const options = { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  try { return new Intl.DateTimeFormat('fr-CA', { ...options, timeZone: timeZone || undefined }).format(date); }
  catch { return new Intl.DateTimeFormat('fr-CA', options).format(date); }
}

/** The agent's latest thoughts, newest first. Its text is untrusted: always escaped. */
export function thoughtsHtml(messages, timeZone) {
  const items = (Array.isArray(messages) ? messages : []).slice().reverse().map(entry => {
    const body = entry.kind === 'command' ? `<code>${escapeHtml(entry.text)}</code>` : escapeHtml(entry.text);
    return `<li class="island-thought-${escapeHtml(entry.kind)}"><span class="island-thought-meta"><time datetime="${escapeHtml(entry.at)}">${escapeHtml(clock(entry.at, timeZone))}</time> · ${escapeHtml(KINDS[entry.kind] || entry.kind)}</span> ${body}</li>`;
  });
  return items.join('') || '<li class="island-note">Rien pour l’instant.</li>';
}

export function duration(run) {
  if (run.startedAt && run.endedAt) {
    const minutes = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60000);
    if (Number.isFinite(minutes)) return `${minutes} min`;
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

/** The run's terrain label from the configured list; the id when it is no longer listed. */
export function terrainLabel(run, worlds) {
  const id = run.world || 'mesa-island';
  return (Array.isArray(worlds) ? worlds : []).find(world => world.id === id)?.label || id;
}

/** The terrain choice: one option per configured world, keeping the current choice. */
export function worldOptionsHtml(worlds, selected) {
  return (Array.isArray(worlds) ? worlds : []).map(world =>
    `<option value="${escapeHtml(world.id)}"${world.id === selected ? ' selected' : ''}>${escapeHtml(world.label)}</option>`).join('');
}

/** Resumes, receipts and the run record: shown when the row is opened. */
export function runDetailHtml(run, worlds) {
  const items = [
    `${escapeHtml(terrainLabel(run, worlds))} · ${escapeHtml(run.agent || '')} · ${escapeHtml(HARNESS_LABELS[run.harness] || 'Codex')} · mémoire ${run.memoryMode === 'fresh' ? 'neuve' : 'continue'}`,
    `Relances : ${escapeHtml(run.resumeCount ?? 0)}`,
    run.queue?.reservation?.start && !run.startedAt ? `Créneau : ${escapeHtml(when(run.queue.reservation.start, run.timeZone))}` : '',
    run.outcome && run.outcome !== 'completed' ? `Issue : ${escapeHtml(run.outcome)}` : '',
    run.receipt?.sha256 ? `<span title="${escapeHtml(run.receipt.file || '')}">Reçu ${escapeHtml(STATES[run.receipt.state] || run.receipt.state)} · ${escapeHtml(run.receipt.sha256.slice(0, 12))}…${run.receipt.runtimeReleased ? '' : ' · libération non prouvée'}</span>` : '',
    run.queue?.releaseReceipt ? `Core : ${escapeHtml(run.queue.releaseReceipt.authority)}` : '',
    `<a href="${API}/runs/${encodeURIComponent(run.id)}" target="_blank" rel="noopener">Fiche complète</a>`
  ].filter(Boolean);
  return `<ul class="island-detail">${items.map(item => `<li>${item}</li>`).join('')}</ul>`;
}

export function runRowHtml(run, worlds) {
  const state = stateLabel(run);
  const id = escapeHtml(run.id);
  const view = run.liveView ? `<button type="button" data-live="${escapeHtml(run.liveView)}" data-run="${id}" title="Vue en direct, avec les pensées">Voir</button>`
    : run.replayable ? `<button type="button" data-replay="${id}" title="Relecture avec les pensées">Voir</button>` : '';
  const memory = run.hasMemory ? `<button type="button" data-memory="${id}">Mémoire</button>` : '';
  return `<tr>
    <td><button type="button" class="island-open" data-detail="${id}" aria-expanded="false" aria-controls="island-detail-${id}">${escapeHtml(when(run.startedAt || run.queue?.reservation?.start || run.requestedAt, run.timeZone))}</button></td>
    <td>${escapeHtml(duration(run))}${Array.isArray(worlds) && worlds.length > 1 ? `<span class="island-terrain">${escapeHtml(terrainLabel(run, worlds))}</span>` : ''}</td>
    <td class="island-state-${escapeHtml(state.key)}">${escapeHtml(state.text)}</td>
    <td class="island-actions">${view}${memory}</td>
  </tr>
  <tr id="island-detail-${id}" class="island-detail-row" hidden><td colspan="4">${runDetailHtml(run, worlds)}</td></tr>`;
}

export function episodesHtml(text) {
  const items = String(text || '').split('\n').filter(line => line.trim()).map(line => {
    try {
      const entry = JSON.parse(line);
      const at = when(entry.time);
      return `<li><time datetime="${escapeHtml(entry.time || '')}">${escapeHtml(at === '—' ? entry.time || '' : at)}</time><div><b>${escapeHtml(entry.summary || '')}</b></div><div>${escapeHtml(entry.detail || '')}</div></li>`;
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

// "Pensées en direct": the run's latest entries, refreshed while it plays.
let thoughtsTimer = null;
function stopThoughts() { clearInterval(thoughtsTimer); thoughtsTimer = null; }
async function loadThoughts(id) {
  try {
    const run = (await apiFetch(`${API}/runs/${encodeURIComponent(id)}`)).data;
    $('island-thoughts').hidden = false;
    $('island-thoughts-list').innerHTML = thoughtsHtml(run.agentMessages, run.timeZone);
    $('island-thoughts-note').textContent = run.phase === 'running' ? '· toutes les 15 s' : '· partie terminée';
    if (run.phase !== 'running') stopThoughts();
  } catch (err) {
    $('island-thoughts-note').textContent = `· lecture impossible : ${err.message}`;
  }
}
function followThoughts(id) {
  stopThoughts();
  if (!id) { $('island-thoughts').hidden = true; return; }
  loadThoughts(id);
  thoughtsTimer = setInterval(() => { if (!document.hidden) loadThoughts(id); }, 15000);
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

// The terrains from the last read: the choice in "Lancer" and "Regarder … en direct".
let worlds = [];
function showWorldChoice() {
  const select = $('island-world');
  const current = select.value;
  if (worlds.length) select.innerHTML = worldOptionsHtml(worlds, current);
  const world = worlds.find(entry => entry.id === select.value);
  $('island-watch').hidden = !world?.liveUrl;
  $('island-watch-label').textContent = world?.label || '';
}

const openDetails = new Set();
function toggleDetail(id) {
  const row = $(`island-detail-${id}`);
  if (!row) return;
  row.hidden = !row.hidden;
  document.querySelector(`[data-detail="${CSS.escape(id)}"]`)?.setAttribute('aria-expanded', String(!row.hidden));
  if (row.hidden) openDetails.delete(id); else openDetails.add(id);
}

async function loadRuns() {
  const status = $('island-runs-status');
  try {
    const data = (await apiFetch(`${API}/runs`)).data;
    worlds = Array.isArray(data.worlds) ? data.worlds : [];
    showWorldChoice();
    $('island-runs').innerHTML = data.runs.map(run => runRowHtml(run, worlds)).join('') || '<tr><td colspan="4">Aucune partie.</td></tr>';
    // A refresh keeps the rows the owner opened.
    for (const id of [...openDetails]) { openDetails.delete(id); toggleDetail(id); }
    const notes = [];
    if (!data.queueRead) notes.push('File de Core illisible : états tirés des derniers rapports.');
    if (!data.view.live && !data.view.replay) notes.push('Vue 3D non configurée.');
    if (data.worldsError) notes.push(`Terrains : réglage refusé (${data.worldsError}).`);
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
        memory: form.get('memory'), harness: form.get('harness') || 'codex', world: form.get('world') || undefined,
        when: form.get('when') } })).data;
      result.textContent = data.placed
        ? `Demande ${data.id} inscrite, créneau ${when(data.placed.start)}. Le départ attend ton approbation et l’admission de Core.`
        : `Demande ${data.id} inscrite (${STATES[data.state] || data.state}). ${data.note || ''}`;
      loadRuns();
    } catch (err) {
      result.classList.add('is-error');
      result.textContent = `Rien n’a été inscrit : ${err.message}`;
    }
  });
  $('island-world').addEventListener('change', showWorldChoice);
  $('island-watch').addEventListener('click', () => {
    const world = worlds.find(entry => entry.id === $('island-world').value);
    if (world?.liveUrl) { followThoughts(null); showFrame(world.liveUrl); }
  });
  $('island-runs').addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    try {
      if (button.dataset.detail) toggleDetail(button.dataset.detail);
      if (button.dataset.live) { showFrame(button.dataset.live); followThoughts(button.dataset.run); }
      if (button.dataset.replay) followThoughts(null);
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
