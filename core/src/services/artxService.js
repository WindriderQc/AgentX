'use strict';

// ArtX owns silent display tasks and the source snapshots behind browser receipts.
// A browser attests visibility only; positions, names and pictures come from Core.
const { randomUUID } = require('node:crypto');
const Choice = require('../../surfaces/household/public/nestor-ambient-choice');

const ID = /^[a-zA-Z0-9-]{8,80}$/;
const IDLE_MS = 120000, COOLDOWN_MS = 900000, SNAPSHOT_MS = 1200000, RECEIPT_MS = 180000;
const MODES = ['sky', 'paint', 'weather', 'rest'];
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, message, status });
const directions = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
const direction = az => directions[Math.round(az / 45) % 8];

function describe(snapshot, receipt, task) {
  const background = Choice.background(snapshot);
  if (['weather', 'rest'].includes(task?.mode) || receipt.moment?.kind === 'iss') background.sky = null;
  const sky = snapshot.sky, frame = Choice.skyFrame(sky);
  const bodies = Choice.skyBodies(sky, background);
  const planets = (sky?.planets || []).map(planet => {
    const rendered = receipt.visible && bodies.planets.some(body => body.id === planet.id);
    const p = frame.project(planet);
    return { id: planet.id, name: planet.name, altitudeDeg: planet.altDeg, azimuthDeg: planet.azDeg,
      direction: direction(planet.azDeg), rendered,
      ...(rendered ? { screen: { x: +p.x.toFixed(3), y: +p.y.toFixed(3),
        side: p.x < 0.4 ? 'gauche' : p.x > 0.6 ? 'droite' : 'centre' } }
        : { reason: !receipt.visible ? 'display_hidden' : !background.sky ? 'sky_hidden' : !frame.visible(planet) ? 'outside_panorama' : 'too_close_to_sun' }) };
  });
  const picture = receipt.moment?.kind === 'paint'
    ? snapshot.paintings?.find(item => item.id === receipt.moment.id) : null;
  return { source: 'agentx.artx/v1', snapshotId: receipt.snapshotId, observedAt: receipt.at, computedAt: snapshot.at,
    visibility: receipt.visible ? 'reported_visible' : 'hidden', mode: task?.mode || 'automatic',
    background: { kind: background.kind, light: background.light, sky: background.sky },
    panorama: { centerAzimuthDeg: frame.center, direction: direction(frame.center), eastNormallyLeft: true },
    paintings: (snapshot.paintings || []).slice(0, 12), planets, moon: receipt.visible && bodies.moon ? { phase: sky.moon.name, altitudeDeg: sky.moon.altDeg,
      direction: direction(sky.moon.azDeg), screen: frame.project(sky.moon) } : null,
    moment: picture ? { kind: 'paint', id: picture.id, source: picture.source,
      description: picture.source === 'family' ? 'dessin de la famille' : 'création de l’atelier' }
      : ['iss', 'visit'].includes(receipt.moment?.kind) ? { kind: receipt.moment.kind } : null,
    task: task ? { id: task.id, state: 'selected', mode: task.mode } : null };
}

function createArtxService({ ambient, decide = null, now = () => Date.now(), householdActive = () => false } = {}) {
  const snapshots = new Map(), displays = new Map();
  let activeDecision = null, lastDecisionAt = -Infinity;

  function display(id) {
    if (!ID.test(id || '')) throw failure('ARTX_DISPLAY_INVALID', 'A display reference is required.', 400);
    if (!displays.has(id)) {
      if (displays.size >= 100) {
        const old = [...displays].find(([, state]) => !state.pending && now() - state.touched > SNAPSHOT_MS);
        if (!old) throw failure('ARTX_BUSY', 'The display registry is full.', 503);
        displays.delete(old[0]);
      }
      displays.set(id, { touched: now(), quietSince: now(), requests: new Map(), task: null, observation: null });
    }
    const state = displays.get(id); state.touched = now(); return state;
  }

  function source(id) {
    const hit = snapshots.get(id);
    return hit && now() - hit.createdAt <= SNAPSHOT_MS ? hit.data : null;
  }

  async function snapshot(displayId) {
    const state = displayId ? display(displayId) : null;
    const data = await ambient.snapshot(), id = randomUUID();
    for (const [key, value] of snapshots) if (now() - value.createdAt > SNAPSHOT_MS) snapshots.delete(key);
    if (snapshots.size >= 2000) snapshots.delete(snapshots.keys().next().value);
    snapshots.set(id, { data, createdAt: now() });
    return { ...data, snapshotId: id, artx: { idleMs: IDLE_MS, cooldownMs: COOLDOWN_MS,
      task: state?.task || null } };
  }

  function receipt(value) {
    if (!value || !ID.test(value.snapshotId || '') || !source(value.snapshotId)
      || typeof value.visible !== 'boolean' || !Number.isFinite(Date.parse(value.at))
      || Math.abs(now() - Date.parse(value.at)) > RECEIPT_MS) return null;
    return { snapshotId: value.snapshotId, at: value.at, visible: value.visible,
      ...(ID.test(value.taskId || '') ? { taskId: value.taskId } : {}),
      ...(['paint', 'iss', 'visit'].includes(value.moment?.kind) ? { moment: { kind: value.moment.kind,
        ...(ID.test(value.moment.id || '') ? { id: value.moment.id } : {}) } } : {}) };
  }

  function observe(value) {
    if (!ID.test(value?.displayId || '')) return null;
    const state = display(value.displayId);
    const current = receipt(value.current), previous = receipt(value.previous);
    state.observation = { current, previous };
    return read({ displayId: value.displayId });
  }

  function read({ displayId } = {}) {
    const state = displays.get(displayId);
    const view = value => {
      const accepted = receipt(value), data = accepted && source(accepted.snapshotId);
      if (!data) return null;
      const task = accepted.taskId ? state?.requests.get(accepted.taskId)?.task : null;
      if (accepted.taskId && !task) return null;
      return describe(data, accepted, task);
    };
    const current = view(state?.observation?.current), previous = view(state?.observation?.previous);
    return { displayId, current, previous, status: current ? 'available' : state?.observation?.current ? 'expired' : 'unavailable' };
  }

  function present({ displayId, requestId, snapshotId, mode, paintingId } = {}) {
    const state = display(displayId);
    if (!ID.test(requestId || '') || !MODES.includes(mode)) throw failure('ARTX_SELECTION_INVALID', 'Choose an ArtX scene.', 400);
    if (paintingId !== undefined && (mode !== 'paint' || !ID.test(paintingId))) throw failure('ARTX_SELECTION_INVALID', 'A listed picture is required for painting.', 400);
    const existing = state.requests.get(requestId);
    if (existing?.task) {
      if (existing.task.mode !== mode || existing.task.paintingId !== paintingId) throw failure('ARTX_REQUEST_CONFLICT', 'This request already selected a different scene.');
      return existing.task;
    }
    const data = source(snapshotId);
    if (!data) throw failure('ARTX_SNAPSHOT_EXPIRED', 'Refresh the display before choosing a scene.');
    if (mode === 'paint' && (!data.paintings?.some(item => item.id === paintingId)
      || Choice.background(data).light === 'night')) throw failure('ARTX_PAINTING_UNAVAILABLE', 'This picture cannot be painted now.');
    const task = { id: requestId, mode, ...(paintingId ? { paintingId } : {}), selectedAt: new Date(now()).toISOString() };
    if (state.pendingRequestId !== requestId) state.pending?.abort();
    state.task = task;
    const record = existing || {}; record.task = task; state.requests.set(requestId, record);
    while (state.requests.size > 100) state.requests.delete(state.requests.keys().next().value);
    return task;
  }

  function activity(displayId) {
    const state = display(displayId);
    state.quietSince = now();
    state.pending?.abort();
    return { status: 'quiet_reset' };
  }

  async function idle({ displayId, requestId, snapshotId, observation } = {}) {
    const state = display(displayId);
    if (!ID.test(requestId || '')) throw failure('ARTX_REQUEST_INVALID', 'A task reference is required.', 400);
    if (state.requests.has(requestId)) {
      const record = state.requests.get(requestId);
      if (record.snapshotId !== snapshotId) throw failure('ARTX_REQUEST_CONFLICT', 'Reconcile the original ArtX task without changing its source.');
      return record.promise || record.result;
    }
    const data = source(snapshotId);
    if (!data) throw failure('ARTX_SNAPSHOT_EXPIRED', 'Refresh the display before starting ArtX.');
    if (!decide || householdActive() || now() - state.quietSince < IDLE_MS || activeDecision
      || now() - lastDecisionAt < COOLDOWN_MS) return { status: 'deferred' };
    if (observation) observe({ ...observation, displayId });
    const controller = new AbortController();
    state.pending = controller; state.pendingRequestId = requestId; activeDecision = controller; lastDecisionAt = now();
    // Keep a lost result under its original identity, including refusals and errors.
    const record = { snapshotId };
    state.requests.set(requestId, record);
    while (state.requests.size > 100) state.requests.delete(state.requests.keys().next().value);
    record.promise = (async () => {
      try {
        const selected = await decide({ snapshot: data, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (householdActive()) throw failure('ARTX_INTERRUPTED', 'Conversation has priority.');
        const task = present({ displayId, requestId, snapshotId, ...selected });
        return record.result = { status: 'selected', task };
      } catch (error) {
        return record.result = { status: controller.signal.aborted ? 'interrupted' : 'unavailable', code: error.code || 'ARTX_DECISION_FAILED' };
      } finally {
        record.promise = null; state.pending = null; state.pendingRequestId = null;
        if (activeDecision === controller) activeDecision = null;
      }
    })();
    return record.promise;
  }

  return { snapshot, observe, read, present, activity, idle, painting: id => ambient.painting(id) };
}

let installed = null;
function configureArtx(service) { installed = service; return service; }
function getArtx() {
  if (!installed) throw failure('ARTX_UNAVAILABLE', 'ArtX is not installed in this Core instance.', 503);
  return installed;
}

module.exports = { createArtxService, configureArtx, getArtx, IDLE_MS, COOLDOWN_MS, MODES };
