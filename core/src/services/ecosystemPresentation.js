'use strict';

// An ephemeral browser display observation, not a Core inventory, live health read or action.
// GraphysX owns the scene and descriptions. Core binds the selected card, rejects old
// instances/frames, bounds the data, and makes it readable through its existing reader.
const { createHash } = require('node:crypto');
const { ecosystemPlay } = require('../../public/js/screen-pages');
const FRESH_MS = 30_000;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && value.length <= 40 && Number.isFinite(Date.parse(value));

function project(value, presentationId, now) {
  const fail = reason => ({ reason });
  if (!record(value) || value.application !== 'ecosystem' || !presentationId || value.presentationId !== presentationId) return fail('presentation_instance_mismatch');
  if (!UUID.test(value.instance || '') || !/^[a-f0-9]{64}$/.test(value.version || '')
      || !/^\d{4}-\d\d-\d\d$/.test(value.snapshot || '') || !Number.isFinite(Date.parse(value.snapshot))
      || new Date(value.snapshot).toISOString().slice(0, 10) !== value.snapshot) return fail('invalid_display_version');
  if (!instant(value.mountedAt) || !instant(value.observedAt)
      || Date.parse(value.mountedAt) > Date.parse(value.observedAt) || Date.parse(value.observedAt) > now + 5000
      || now - Date.parse(value.observedAt) > FRESH_MS) return fail('stale_display_observation');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !Number.isSafeInteger(value.documentRevision) || value.documentRevision < 0) return fail('invalid_display_revision');
  const tour = value.tour;
  const script = record(tour) && ecosystemPlay(tour.script);
  if (!script || !Number.isSafeInteger(tour.index) || !Number.isSafeInteger(tour.count)
      || tour.count !== script.split(',').length || tour.index < 0 || tour.index >= tour.count
      || !text(tour.label, 160) || !text(tour.title, 240)) return fail('invalid_display_step');
  const adhoc = tour.adhoc;
  if (adhoc !== null && (typeof adhoc !== 'string' || !adhoc.startsWith('node-') || !ecosystemPlay(adhoc) || adhoc.includes(','))) return fail('invalid_display_selection');
  const step = adhoc || script.split(',')[tour.index];
  if (tour.kind !== (step.startsWith('node-') ? 'node' : step)) return fail('display_step_mismatch');
  if (!Array.isArray(value.focus) || value.focus.length > 32 || !text(value.narration, 4000)) return fail('invalid_display_scope');
  const seen = new Set();
  const focus = [];
  for (const item of value.focus) {
    if (!record(item) || !ID.test(item.id || '') || !text(item.label, 160) || seen.has(item.id)) return fail('invalid_display_scope');
    seen.add(item.id); focus.push({ id: item.id, label: item.label });
  }
  let selection;
  if (value.selection !== null) {
    const item = value.selection;
    if (!record(item) || !ID.test(item.id || '') || !seen.has(item.id) || step !== 'node-' + item.id
        || !text(item.label, 160) || item.label !== focus.find(row => row.id === item.id)?.label
        || !text(item.description, 4000)) return fail('display_selection_mismatch');
    selection = { status: 'selected', basis: 'displayed_node_step', id: item.id, label: item.label, description: item.description };
  } else {
    if (step.startsWith('node-')) return fail('display_selection_missing');
    selection = focus.length === 1 ? { status: 'selected', basis: 'sole_focus', ...focus[0] }
      : { status: focus.length ? 'ambiguous' : 'none', candidates: focus, clarificationRequired: true };
  }
  return { snapshot: { contract: 'agentx.presentation-read/v1', source: 'graphysx.ecosystem', page: 'ecosystem',
    observationOwner: 'browser_after_render', presentationId, instance: value.instance,
    version: value.version, snapshot: value.snapshot, documentRevision: value.documentRevision, sequence: value.sequence,
    mountedAt: new Date(value.mountedAt).toISOString(), observedAt: new Date(value.observedAt).toISOString(),
    expiresAt: new Date(Date.parse(value.observedAt) + FRESH_MS).toISOString(),
    tour: { kind: tour.kind, index: tour.index, count: tour.count, playing: tour.playing === true,
      label: tour.label, title: tour.title, script, adhoc }, focus, selection,
    narration: value.narration, narrationComplete: value.narrationComplete === true,
    limits: ['Browser-reported rendered tour, not pixel verification or a Core inventory.',
      'Dated GraphysX snapshot, not live telemetry, file contents or execution evidence.',
      'Use only this instance and selection; ambiguous or absent selection requires clarification.'] } };
}

function createEcosystemObserver({ now = Date.now, capacity = 128 } = {}) {
  const latest = new Map();
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    accept(value, presentationId) {
      const result = project(value, presentationId, now());
      if (!result.snapshot) return result;
      for (const [id, row] of latest) if (Date.parse(row.snapshot.expiresAt) <= now()) latest.delete(id);
      const snapshot = result.snapshot, previous = latest.get(presentationId)?.snapshot;
      if (previous) {
        if (previous.instance !== snapshot.instance && Date.parse(snapshot.mountedAt) <= Date.parse(previous.mountedAt)) return { reason: 'superseded_display_instance' };
        if (previous.instance === snapshot.instance) {
          if (previous.version !== snapshot.version || previous.snapshot !== snapshot.snapshot || previous.mountedAt !== snapshot.mountedAt) return { reason: 'display_version_mismatch' };
          if (snapshot.sequence < previous.sequence || Date.parse(snapshot.observedAt) < Date.parse(previous.observedAt)
              || snapshot.documentRevision < previous.documentRevision) return { reason: 'superseded_display_observation' };
          if (snapshot.sequence === previous.sequence && digest(snapshot) !== digest(previous)) return { reason: 'display_revision_reused' };
        }
      }
      if (!latest.has(presentationId)) while (latest.size >= capacity) latest.delete(latest.keys().next().value);
      latest.set(presentationId, { snapshot });
      return result;
    },
    current(snapshot) {
      const row = latest.get(snapshot.presentationId)?.snapshot;
      return !!row && row.instance === snapshot.instance && row.sequence === snapshot.sequence && row.version === snapshot.version;
    }
  };
}

module.exports = { FRESH_MS, createEcosystemObserver };
