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
const PENDING_LAUNCH = 'agentx.island.pending-launch';

/** A response can be lost after Core records the request. Keep its identity across retries/reloads. */
export function readPendingLaunch(storage) {
  try {
    const value = JSON.parse(storage.getItem(PENDING_LAUNCH));
    return value && /^[a-f0-9-]{36}$/.test(value.clientKey || '') ? value : null;
  } catch { return null; }
}

export function savePendingLaunch(storage, intent) {
  try {
    if (intent) storage.setItem(PENDING_LAUNCH, JSON.stringify(intent));
    else storage.removeItem(PENDING_LAUNCH);
  } catch { /* The in-page intent still protects retries when storage is disabled. */ }
}

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
  if (queue) return { key: queue, text: STATES[queue] || queue };
  if (run.state) return { key: run.state, text: STATES[run.state] || run.state };
  if (['completed', 'failed', 'cancelled'].includes(run.receipt?.state)) return { key: run.receipt.state, text: STATES[run.receipt.state] };
  if (run.phase === 'running') return { key: 'running', text: PHASES.running };
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

function stateBadge(state) {
  return `<span class="island-state island-state-${escapeHtml(state.key)}">${escapeHtml(state.text)}</span>`;
}

function runButtons(run, state) {
  const id = escapeHtml(run.id);
  const terminal = ['completed', 'failed', 'cancelled'].includes(state.key);
  const view = run.liveView && !terminal ? `<button type="button" data-live="${escapeHtml(run.liveView)}" data-run="${id}" title="Vue en direct, avec le journal">Direct</button>`
    : run.replayable ? `<button type="button" data-replay="${id}" title="Relecture de cette partie">Revoir</button>` : '';
  const memory = run.hasMemory ? `<button type="button" data-memory="${id}">Mémoire</button>` : '';
  return view + memory;
}

/** One played run: when and where, who and how long, its state, its buttons. */
export function runRowHtml(run, worlds) {
  const state = stateLabel(run);
  const id = escapeHtml(run.id);
  const who = [run.agent, HARNESS_LABELS[run.harness] || 'Codex', duration(run)].filter(Boolean).join(' · ');
  return `<tr>
    <td><button type="button" class="island-open" data-detail="${id}" aria-expanded="false" aria-controls="island-detail-${id}">${escapeHtml(when(run.startedAt || run.queue?.reservation?.start || run.requestedAt, run.timeZone))}</button>${Array.isArray(worlds) && worlds.length > 1 ? `<span class="island-terrain">${escapeHtml(terrainLabel(run, worlds))}</span>` : ''}</td>
    <td class="island-who">${escapeHtml(who)}</td>
    <td>${stateBadge(state)}</td>
    <td class="island-actions">${runButtons(run, state)}</td>
  </tr>
  <tr id="island-detail-${id}" class="island-detail-row" hidden><td colspan="4">${runDetailHtml(run, worlds)}</td></tr>`;
}

const UPCOMING = ['requested', 'reserved', 'dispatching', 'running', 'uncertain'];
export const isUpcoming = run => UPCOMING.includes(stateLabel(run).key);

/** Identical requests placed together (a campaign) become one line; everything else stays alone. */
export function groupUpcoming(runs) {
  const groups = [];
  const byKey = new Map();
  for (const run of (Array.isArray(runs) ? runs : []).filter(isUpcoming)) {
    if (stateLabel(run).key !== 'requested') { groups.push({ id: run.id, runs: [run] }); continue; }
    const key = [run.world || '', run.agent || '', run.harness || 'codex', run.minutes || '', run.memoryMode || '', String(run.requestedAt || '').slice(0, 16)].join('|');
    const group = byKey.get(key);
    if (group) group.runs.push(run);
    else { const created = { id: run.id, runs: [run] }; byKey.set(key, created); groups.push(created); }
  }
  return groups;
}

function upcomingTitle(run, state, count) {
  const tz = run.timeZone;
  if (count > 1) return `${count} demandes inscrites le ${when(run.requestedAt, tz)}`;
  if (state.key === 'running') return `Commencée le ${when(run.startedAt, tz)}`;
  if (state.key === 'reserved' && run.queue?.reservation?.start) return `Créneau le ${when(run.queue.reservation.start, tz)}`;
  return `Inscrite le ${when(run.requestedAt || run.startedAt, tz)}`;
}

export function upcomingHtml(groups, worlds, open = new Set()) {
  return (Array.isArray(groups) ? groups : []).map(group => {
    const run = group.runs[0];
    const state = stateLabel(run);
    const count = group.runs.length;
    const id = escapeHtml(group.id);
    const expanded = open.has(group.id);
    const who = [terrainLabel(run, worlds), run.agent, HARNESS_LABELS[run.harness] || 'Codex',
      run.minutes ? `${run.minutes} min${count > 1 ? ' chacune' : ''}` : ''].filter(Boolean).join(' · ');
    const details = group.runs.map(entry => `<li>${runDetailHtml(entry, worlds)}</li>`).join('');
    return `<li>
      <div class="island-upcoming-main">${stateBadge(state)} <span class="island-upcoming-title">${escapeHtml(upcomingTitle(run, state, count))}</span>
        <span class="island-upcoming-sub">${escapeHtml(who)}</span></div>
      <div class="island-upcoming-actions">${count === 1 ? runButtons(run, state) : ''}<button type="button" data-group="${id}" aria-expanded="${expanded}" aria-controls="island-group-${id}">Détails</button></div>
      <ul id="island-group-${id}" class="island-upcoming-detail"${expanded ? '' : ' hidden'}>${details}</ul>
    </li>`;
  }).join('');
}

/** One chip per terrain that has runs, plus "Tous"; none when there is nothing to choose. */
export function filterChipsHtml(runs, worlds, selected) {
  const ids = [...new Set((Array.isArray(runs) ? runs : []).map(run => run.world || 'mesa-island'))];
  if (ids.length < 2) return '';
  const chip = (id, label) => `<button type="button" data-filter="${escapeHtml(id)}" aria-pressed="${id === selected}">${escapeHtml(label)}</button>`;
  return chip('all', 'Tous') + ids.map(id => chip(id, terrainLabel({ world: id }, worlds))).join('');
}

const WHEN_TEXT = { tonight: 'dans un créneau cette nuit', asap: 'dès que possible', none: 'sans créneau réservé' };
/** The launch form read back as one sentence. Plain text: the caller sets textContent. */
export function launchSummary(values, worlds) {
  const terrain = (Array.isArray(worlds) ? worlds : []).find(world => world.id === values.world)?.label || values.world || 'le terrain choisi';
  const minutes = Number(values.minutes);
  return `${values.agent || 'L’agent'} jouera ${Number.isFinite(minutes) && minutes > 0 ? `${minutes} min` : '— min'} sur ${terrain} avec ${HARNESS_LABELS[values.harness] || values.harness || 'Codex'}, mémoire ${values.memory === 'fresh' ? 'neuve' : 'continue'}, ${WHEN_TEXT[values.when] || 'sans créneau réservé'}.`;
}

/** Recording stopped (the world's quota, for example): live still works, new runs cannot be replayed. */
export function recordingAlertText(entries) {
  const names = (Array.isArray(entries) ? entries : [])
    .filter(({ live }) => live?.available && live.selectedActive === true && live.recordingState === 'paused').map(({ world }) => world.label);
  if (!names.length) return '';
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}` : names[0];
  return `Enregistrement suspendu sur ${list} : le direct fonctionne, mais les nouvelles parties ne pourront pas être revues.`;
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

/** Keep the explorer connected to the canonical run/memory page, including in its own tab. */
export function explorerViewUrl(src, runId, dashboardOrigin) {
  const url = new URL(src);
  if (url.searchParams.get('app') !== 'island') return src;
  url.searchParams.set('dashboard', new URL('/benchmark/island', dashboardOrigin).href);
  if (typeof runId === 'string' && /^[a-f0-9-]{36}$/.test(runId)) url.searchParams.set('run', runId);
  return url.href;
}

/** Only the currently displayed viewer may request its own run memory. */
export function isIslandMemoryRequest(event, frame, runId) {
  try {
    return Boolean(runId && event.source === frame.contentWindow && event.origin === new URL(frame.src).origin
      && event.data?.type === 'graphysx:island:memory' && event.data.runId === runId);
  } catch { return false; }
}

function showFrame(src, worldLabel = '', runId = null, title = 'Scène en direct') {
  replayRead++;
  $('island-replay-status').textContent = '';
  src = explorerViewUrl(src, runId, location.origin);
  viewerRun = runId;
  const heading = $('island-viewer-title');
  if (heading) heading.textContent = title;
  $('island-viewer').hidden = false;
  $('island-viewer-memory').hidden = !runId;
  $('island-viewer-memory').dataset.memory = runId || '';
  $('island-viewer-open').textContent = 'Ouvrir dans un onglet';
  $('island-frame').src = src;
  $('island-viewer-open').href = src;
  $('island-viewer-world').hidden = !worldLabel;
  $('island-viewer-world').textContent = worldLabel ? `Monde en direct : ${worldLabel}` : '';
  if (location.protocol === 'https:' && src.startsWith('http:')) {
    $('island-viewer-open').textContent = 'Ouvrir dans un onglet (le navigateur bloque une vue http dans une page https)';
  }
  $('island-viewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// "Pensées en direct": the run's latest entries, refreshed while it plays.
let thoughtsTimer = null;
let viewerRun = null;
let replayRead = 0;
let thoughtsRead = 0;
let thoughtsRecorded = false;
function stopThoughts() { clearInterval(thoughtsTimer); thoughtsTimer = null; thoughtsRead++; }
async function loadThoughts(id, recorded = false) {
  const read = ++thoughtsRead;
  try {
    const run = (await apiFetch(`${API}/runs/${encodeURIComponent(id)}`)).data;
    if (viewerRun !== id || read !== thoughtsRead) return;
    $('island-thoughts').hidden = false;
    $('island-thoughts-list').innerHTML = recorded && !run.agentMessages?.length
      ? '<li class="island-note">Aucune entrée enregistrée pour cette partie.</li>' : thoughtsHtml(run.agentMessages, run.timeZone);
    $('island-thoughts-note').textContent = recorded ? '' : stateLabel(run).key === 'running' ? '· toutes les 15 s' : '· partie terminée';
    $('island-thoughts-retry').hidden = true;
    if (recorded || stateLabel(run).key !== 'running') stopThoughts();
  } catch (err) {
    if (viewerRun !== id || read !== thoughtsRead) return;
    $('island-thoughts-note').textContent = `· lecture impossible : ${err.message}`;
    $('island-thoughts-retry').hidden = false;
  }
}
function followThoughts(id, recorded = false) {
  stopThoughts();
  thoughtsRecorded = recorded;
  $('island-thoughts-list').innerHTML = '';
  $('island-thoughts-retry').hidden = true;
  $('island-thoughts').hidden = !id;
  if (!id) return;
  $('island-thoughts-title').textContent = recorded
    ? 'Journal enregistré — non synchronisé avec la lecture' : 'Journal de l’agent';
  $('island-thoughts-note').textContent = '· chargement…';
  void loadThoughts(id, recorded);
  if (!recorded) thoughtsTimer = setInterval(() => { if (!document.hidden) loadThoughts(id); }, 15000);
}

let memory = null;
let memoryRead = 0;
function showMemoryFile(name) {
  document.querySelectorAll('.island-tabs button').forEach(btn => { btn.setAttribute('aria-selected', String(btn.dataset.file === name)); btn.tabIndex = btn.dataset.file === name ? 0 : -1; });
  $('island-memory-body').setAttribute('aria-labelledby', `memory-tab-${name.replace(/[^a-zA-Z]/g, '')}`);
  const file = memory?.files?.[name];
  const body = $('island-memory-body');
  if (!file || file.missing) { body.innerHTML = '<p class="island-note">Fichier absent pour cette partie.</p>'; return; }
  const note = file.truncated ? `<p class="island-note">Fin du fichier seulement (${escapeHtml(file.bytes)} octets).</p>` : '';
  body.innerHTML = note + (name.endsWith('.jsonl') ? episodesHtml(file.text) : `<pre>${escapeHtml(file.text)}</pre>`);
}
async function openMemory(id) {
  const read = ++memoryRead;
  const received = (await apiFetch(`${API}/runs/${encodeURIComponent(id)}/memory`)).data;
  if (read !== memoryRead) return;
  memory = received;
  $('island-memory-provenance').textContent = `Partie ${id} · capture mémoire de fin de partie. Ces fichiers ne sont pas synchronisés avec l’instant de la scène ou de la relecture.`;
  $('island-memory').hidden = false;
  $('island-memory-run').innerHTML = memory.runs.map(run => `<option value="${escapeHtml(run.id)}"${run.id === id ? ' selected' : ''}>${escapeHtml(when(run.startedAt || run.endedAt, run.timeZone))} · ${run.memoryMode === 'fresh' ? 'neuve' : 'continue'}</option>`).join('');
  showMemoryFile('SEMANTIC_MEMORY.md');
  $('island-memory').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// The next run's terrain and the currently active world are separate choices.
let worlds = [];
let liveRead = 0;
let watchedTerrain = null;
let worldCardRead = 0;
let latestRuns = [];
let queueReadable = false;

export function worldCardHtml(world, live, runs, queueRead, watching = watchedTerrain) {
  const verified = live?.available && live.selectedActive === true;
  const playing = verified ? runs.filter(run => run.world === world.id && stateLabel(run).key === 'running'
    && run.worldView?.instanceId === live.instanceId) : [];
  const archives = runs.filter(run => run.world === world.id && run.replayable);
  const pending = runs.filter(run => run.world === world.id && ['requested', 'reserved'].includes(stateLabel(run).key)).length;
  const presence = !queueRead ? 'État des parties indisponible' : playing.length
    ? `${playing.map(run => run.agent || 'Agent').join(', ')} joue${playing.length > 1 ? 'nt' : ''} ici` : 'Aucune partie en cours';
  const note = verified ? '' : live?.available
    ? `Ce service héberge ${live.activeWorld?.label || 'un autre terrain'}.` : 'Connexion indisponible. Nouvelle vérification automatique.';
  const meta = [pending ? `${pending} demande${pending > 1 ? 's' : ''} en attente` : '',
    archives.length ? `${archives.length} partie${archives.length > 1 ? 's' : ''} à revoir` : 'Aucune partie à revoir'].filter(Boolean).join(' · ');
  const living = /living|vivante/i.test(world.id + world.label);
  const onScreen = Boolean(verified) && watching === world.id;
  const label = escapeHtml(world.label);
  return `<article class="island-world-card" data-world-card="${escapeHtml(world.id)}" data-online="${Boolean(verified)}" data-watching="${onScreen}">
    <button type="button" class="island-world-poster ${living ? 'is-living' : 'is-mesa'}" data-world-watch="${escapeHtml(world.id)}" aria-label="Regarder ${label} en direct"${verified ? '' : ' disabled'}><span class="island-play" aria-hidden="true">${onScreen ? '● À l’écran' : verified ? '▶ Regarder' : 'Hors ligne'}</span></button>
    <div class="island-world-card-body">
      <div class="island-world-top"><h3>${label}</h3><p class="island-world-badge">${verified ? 'En direct' : 'Indisponible'}</p></div>
      <p class="island-world-presence${playing.length ? ' is-playing' : ''}">${escapeHtml(presence)}</p>
      ${note ? `<p class="island-note">${escapeHtml(note)}</p>` : ''}
      <p class="island-world-meta">${escapeHtml(meta)}</p>
      ${archives[0] ? `<button type="button" class="island-btn" data-world-archive="${escapeHtml(archives[0].id)}">Revoir la dernière partie</button>` : ''}
    </div></article>`;
}

async function refreshWorldCards() {
  const container = $('island-world-cards');
  if (!container) return;
  const read = ++worldCardRead;
  const remote = worlds.filter(world => world.liveUrl);
  const entries = await Promise.all(remote.map(async world => {
    let live;
    try { live = (await apiFetch(`${API}/worlds/${encodeURIComponent(world.id)}/live`)).data; } catch { /* Unavailable card stays visible. */ }
    return { world, live };
  }));
  const cards = entries.map(({ world, live }) => worldCardHtml(world, live, latestRuns, queueReadable));
  if (read === worldCardRead) {
    const alert = $('island-alert');
    if (alert) { alert.textContent = recordingAlertText(entries); alert.hidden = !alert.textContent; }
    const focus = container.contains(document.activeElement) ? document.activeElement.dataset : null;
    container.innerHTML = cards.join('');
    if (focus?.worldWatch) container.querySelector(`[data-world-watch="${CSS.escape(focus.worldWatch)}"]`)?.focus({ preventScroll: true });
    if (focus?.worldArchive) container.querySelector(`[data-world-archive="${CSS.escape(focus.worldArchive)}"]`)?.focus({ preventScroll: true });
  }
}

async function watchWorld(id, button) {
  const world = worlds.find(entry => entry.id === id);
  if (!world) return;
  button.disabled = true;
  try {
    const live = (await apiFetch(`${API}/worlds/${encodeURIComponent(id)}/live`)).data;
    if (!live.available || !live.selectedActive || !live.liveUrl) throw new Error('Ce terrain n’est plus disponible.');
    watchedTerrain = id;
    const run = latestRuns.find(entry => entry.world === id && stateLabel(entry).key === 'running' && entry.worldView?.instanceId === live.instanceId);
    showFrame(live.liveUrl, live.activeWorld.label, run?.id, run ? 'Partie en direct' : 'Scène en direct');
    followThoughts(run?.id || null);
  } catch (err) { $('island-worlds-note').textContent = err.message; }
  finally { button.disabled = false; void refreshWorldCards(); }
}

export function liveWorldPresentation(world, live) {
  if (!live?.available || !live.activeWorld || !live.liveUrl) {
    return { available: false, label: 'le monde actif', note: 'Le monde en direct est indisponible ou son identité ne peut pas être vérifiée.' };
  }
  const label = live.activeWorld.label;
  const note = live.selectedActive ? `Monde actif : ${label}.`
    : `Le terrain « ${world.label} » n’est pas actif sur ce service. Monde actif : ${label}. Le terrain choisi s’applique à la prochaine partie.`;
  return { available: true, label, note: note + (live.recordingState === 'paused'
    ? ' Enregistrement suspendu : archives conservées, direct disponible.' : '') };
}

function showLiveCaption(presentation) {
  $('island-viewer-world').hidden = false;
  $('island-viewer-world').textContent = presentation.available
    ? `Monde en direct : ${presentation.label}` : presentation.note;
}

// Keep identifying the displayed feed if the next run's terrain is changed.
async function refreshDisplayedWorld() {
  const id = watchedTerrain;
  if (!id || id === $('island-world').value) return;
  let live;
  try { live = (await apiFetch(`${API}/worlds/${encodeURIComponent(id)}/live`)).data; } catch { /* Unavailable. */ }
  if (id === watchedTerrain) showLiveCaption(liveWorldPresentation({ label: id }, live));
}

async function refreshLiveWorld(open = false) {
  const read = ++liveRead;
  const selection = $('island-world').value;
  const selected = worlds.find(entry => entry.id === selection);
  const world = selected?.liveUrl ? selected : worlds.find(entry => entry.liveUrl);
  const section = $('island-live');
  const watch = $('island-watch');
  section.hidden = !world?.liveUrl;
  watch.disabled = true;
  $('island-watch-label').textContent = 'le monde actif';
  if (!world?.liveUrl) return;
  $('island-live-status').textContent = 'Vérification du monde actif…';
  let live;
  try { live = (await apiFetch(`${API}/worlds/${encodeURIComponent(world.id)}/live`)).data; }
  catch { /* An unreadable identity must never be presented as the selected terrain. */ }
  if (read !== liveRead || selection !== $('island-world').value) return;
  const presentation = liveWorldPresentation(world, live);
  watch.disabled = !presentation.available;
  $('island-watch-label').textContent = presentation.label;
  $('island-live-status').textContent = presentation.note;
  if (watchedTerrain === world.id) showLiveCaption(presentation);
  if (open && presentation.available) {
    watchedTerrain = world.id;
    followThoughts(null);
    showFrame(live.liveUrl, presentation.label);
  }
}

let refreshSummary = () => {};
function showWorldChoice() {
  const select = $('island-world');
  const current = select.dataset.pendingWorld || select.value;
  if (worlds.length) select.innerHTML = worldOptionsHtml(worlds, current);
  refreshSummary();
  void refreshLiveWorld();
}

const openDetails = new Set();
let memoryLinkOpened = false;
function toggleDetail(id) {
  const row = $(`island-detail-${id}`);
  if (!row) return;
  row.hidden = !row.hidden;
  document.querySelector(`[data-detail="${CSS.escape(id)}"]`)?.setAttribute('aria-expanded', String(!row.hidden));
  if (row.hidden) openDetails.delete(id); else openDetails.add(id);
}

// Runs: what is playing or waiting, then what was played, filtered by terrain.
const HISTORY_PAGE = 10;
const openGroups = new Set();
let runFilter = 'all';
let historyLimit = HISTORY_PAGE;
function setHtml(id, html) { const node = $(id); if (node) node.innerHTML = html; return node; }

function renderRuns() {
  const runs = Array.isArray(latestRuns) ? latestRuns : [];
  const known = new Set(runs.map(run => run.world || 'mesa-island'));
  if (runFilter !== 'all' && !known.has(runFilter)) runFilter = 'all';
  const shown = runFilter === 'all' ? runs : runs.filter(run => (run.world || 'mesa-island') === runFilter);
  setHtml('island-run-filter', filterChipsHtml(runs, worlds, runFilter));
  const groups = groupUpcoming(shown);
  const wrap = $('island-upcoming-wrap');
  if (wrap) wrap.hidden = !groups.length;
  setHtml('island-upcoming', upcomingHtml(groups, worlds, openGroups));
  const played = shown.filter(run => !isUpcoming(run));
  $('island-runs').innerHTML = played.slice(0, historyLimit).map(run => runRowHtml(run, worlds)).join('')
    || `<tr><td colspan="4" class="island-note">Aucune partie jouée${runFilter === 'all' ? '' : ' sur ce terrain'}.</td></tr>`;
  const more = $('island-runs-more');
  if (more) {
    const left = played.length - historyLimit;
    more.hidden = left <= 0;
    more.textContent = `Afficher plus (${Math.max(0, left)} de plus)`;
  }
  // A refresh keeps the rows the owner opened.
  for (const id of [...openDetails]) { openDetails.delete(id); toggleDetail(id); }
}

function toggleGroup(id) {
  const list = $(`island-group-${id}`);
  if (!list) return;
  list.hidden = !list.hidden;
  document.querySelector(`[data-group="${CSS.escape(id)}"]`)?.setAttribute('aria-expanded', String(!list.hidden));
  if (list.hidden) openGroups.delete(id); else openGroups.add(id);
}

async function openReplay(id, button) {
  followThoughts(null);
  watchedTerrain = null;
  void refreshWorldCards();
  const read = ++replayRead;
  viewerRun = null;
  const run = latestRuns.find(entry => entry.id === id);
  const title = run ? `Relecture · ${when(run.startedAt || run.requestedAt, run.timeZone)}` : 'Relecture';
  const heading = $('island-viewer-title');
  if (heading) heading.textContent = title;
  $('island-viewer').hidden = false;
  $('island-viewer-memory').hidden = true;
  $('island-frame').src = 'about:blank';
  $('island-viewer-open').removeAttribute('href');
  $('island-viewer-world').hidden = true;
  $('island-replay-status').textContent = 'Ouverture de l’archive de cette partie…';
  $('island-viewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (button) button.disabled = true;
  try {
    const opened = (await apiFetch(`${API}/runs/${encodeURIComponent(id)}/replay`, { method: 'POST', body: {} })).data;
    if (read !== replayRead) return;
    showFrame(opened.src, '', id, title);
    followThoughts(id, true);
    $('island-replay-status').textContent = 'Lecture partagée de l’archive. Fermer la vue libère son flux.';
  } catch (err) {
    if (read === replayRead) $('island-replay-status').textContent = `Relecture indisponible : ${err.message}. Tu peux réessayer avec Revoir.`;
  } finally { if (button) button.disabled = false; }
}

async function onRunAction(event) {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.detail) toggleDetail(button.dataset.detail);
    if (button.dataset.group) toggleGroup(button.dataset.group);
    if (button.dataset.live) {
      watchedTerrain = null;
      showFrame(button.dataset.live, '', button.dataset.run, 'Partie en direct');
      followThoughts(button.dataset.run);
      void refreshWorldCards();
    }
    if (button.dataset.replay) await openReplay(button.dataset.replay, button);
    if (button.dataset.memory) await openMemory(button.dataset.memory);
  } catch (err) {
    $('island-runs-status').textContent = err.message;
  }
}

async function loadRuns() {
  const status = $('island-runs-status');
  try {
    const data = (await apiFetch(`${API}/runs`)).data;
    worlds = Array.isArray(data.worlds) ? data.worlds : [];
    latestRuns = data.runs;
    queueReadable = data.queueRead;
    void refreshWorldCards();
    showWorldChoice();
    void refreshDisplayedWorld();
    renderRuns();
    const notes = [];
    if (!data.queueRead) notes.push('File de Core illisible : états tirés des derniers rapports.');
    if (!data.view.live && !data.view.replay) notes.push('Vue 3D non configurée.');
    if (data.worldsError) notes.push(`Terrains : réglage refusé (${data.worldsError}).`);
    status.textContent = notes.join(' ');
    if (!memoryLinkOpened) {
      memoryLinkOpened = true;
      const memoryId = typeof location === 'undefined' ? null : new URLSearchParams(location.hash?.slice(1) || '').get('memory');
      if (memoryId && data.runs.some(run => run.id === memoryId && run.hasMemory)) await openMemory(memoryId);
    }
  } catch (err) {
    status.textContent = `Lecture impossible : ${err.message}`;
  }
}

function bind() {
  $('island-world-cards')?.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.dataset.worldWatch) void watchWorld(button.dataset.worldWatch, button);
    if (button?.dataset.worldArchive) void openReplay(button.dataset.worldArchive, button);
  });
  const launchForm = $('island-launch-form');
  const launchPanel = $('island-launch');
  const launchToggle = $('island-launch-toggle');
  const updateSummary = refreshSummary = () => {
    const summary = $('island-launch-summary');
    if (!summary) return;
    const value = name => launchForm.elements.namedItem(name)?.value;
    summary.textContent = launchSummary({ agent: value('agent'), minutes: value('minutes'), world: value('world'),
      harness: value('harness'), memory: value('memory'), when: value('when') }, worlds);
  };
  const setLaunchOpen = open => {
    if (!launchPanel) return;
    launchPanel.hidden = !open;
    launchToggle?.setAttribute('aria-expanded', String(open));
    if (open) { updateSummary(); launchPanel.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }
    else launchToggle?.focus?.();
  };
  launchToggle?.addEventListener('click', () => setLaunchOpen(launchPanel.hidden));
  $('island-launch-close')?.addEventListener('click', () => setLaunchOpen(false));
  launchForm.addEventListener('input', updateSummary);
  launchForm.addEventListener('change', updateSummary);
  let storage;
  try { storage = window.sessionStorage; } catch { /* Private browsing may refuse storage. */ }
  let pending = readPendingLaunch(storage);
  let submitting = false;
  const syncForm = () => {
    $('island-world').dataset.pendingWorld = pending?.world || '';
    for (const name of ['agent', 'minutes', 'memory', 'harness', 'world', 'when']) {
      const field = launchForm.elements.namedItem(name);
      if (!field) continue;
      if (pending && pending[name] !== undefined) field.value = String(pending[name]);
      field.disabled = Boolean(pending);
    }
    launchForm.querySelector('[type="submit"]').disabled = submitting;
  };
  syncForm();
  if (pending) {
    $('island-launch-result').textContent = 'Une inscription attend confirmation. Réessaie pour retrouver la même demande.';
    setLaunchOpen(true);
  }
  launchForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const form = new FormData(event.target);
    const result = $('island-launch-result');
    result.classList.remove('is-error');
    result.textContent = 'Inscription…';
    pending ||= {
      clientKey: crypto.randomUUID(), agent: form.get('agent'), minutes: Number(form.get('minutes')),
      memory: form.get('memory'), harness: form.get('harness') || 'codex', world: form.get('world') || 'mesa-island', when: form.get('when')
    };
    savePendingLaunch(storage, pending);
    submitting = true;
    syncForm();
    try {
      const data = (await apiFetch(`${API}/launch`, { method: 'POST', body: pending })).data;
      pending = null;
      savePendingLaunch(storage, null);

      result.textContent = data.placed
        ? `Demande ${data.id} inscrite, créneau ${when(data.placed.start)}. Le départ attend ton approbation et l’admission de Core.`
        : `Demande ${data.id} inscrite (${STATES[data.state] || data.state}). ${data.note || ''}`;
      loadRuns();
    } catch (err) {
      result.classList.add('is-error');
      if (err.status === 400) {
        pending = null; // Validation refused before any native submission.
        savePendingLaunch(storage, null);
        result.textContent = `Demande invalide : ${err.message}`;
      } else result.textContent = `Inscription non confirmée : ${err.message}. Réessaie pour retrouver la même demande.`;
    } finally {
      submitting = false;
      syncForm();
    }
  });
  $('island-world').addEventListener('change', showWorldChoice);
  // Recheck on click: another run may have changed the shared world meanwhile.
  $('island-watch').addEventListener('click', () => { void refreshLiveWorld(true); });
  $('island-thoughts-retry').addEventListener('click', () => {
    if (viewerRun) followThoughts(viewerRun, thoughtsRecorded);
  });
  $('island-viewer-close')?.addEventListener('click', () => {
    replayRead++; viewerRun = null; watchedTerrain = null; followThoughts(null);
    $('island-frame').src = 'about:blank'; $('island-viewer').hidden = true;
    $('island-thoughts').hidden = true;
    void refreshWorldCards();
  });
  $('island-memory-close')?.addEventListener('click', () => { memoryRead++; $('island-memory').hidden = true; });
  $('island-runs').addEventListener('click', onRunAction);
  $('island-upcoming')?.addEventListener('click', onRunAction);
  $('island-run-filter')?.addEventListener('click', event => {
    const chip = event.target.closest('button');
    if (!chip?.dataset.filter) return;
    runFilter = chip.dataset.filter;
    historyLimit = HISTORY_PAGE;
    renderRuns();
  });
  $('island-runs-more')?.addEventListener('click', () => { historyLimit += HISTORY_PAGE; renderRuns(); });
  document.querySelector('.island-tabs').addEventListener('click', event => {
    if (event.target.dataset.file) showMemoryFile(event.target.dataset.file);
  });
  $('island-memory-run').addEventListener('change', event => { void openMemory(event.target.value).catch(err => { $('island-memory-provenance').textContent = err.message; }); });
  $('island-viewer-memory').addEventListener('click', () => { if (viewerRun) void openMemory(viewerRun).catch(err => { $('island-runs-status').textContent = err.message; }); });
  window.addEventListener('message', event => {
    const frame = $('island-frame');
    if (!isIslandMemoryRequest(event, frame, viewerRun)) return;
    void openMemory(viewerRun).catch(err => { $('island-runs-status').textContent = err.message; });
  });
  document.querySelector('.island-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('.island-tabs button')], at = tabs.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    event.preventDefault(); showMemoryFile(tabs[next].dataset.file); tabs[next].focus();
  });
}

if (typeof document?.getElementById === 'function' && document.getElementById('island-runs')) {
  bind();
  loadRuns();
  setInterval(() => { if (!document.hidden) loadRuns(); }, 30000);
}
