'use strict';

// Reviewed instance composition, distinct from collected live health. The private
// manifest is data only; scene code, transport and business authority remain shared.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const SOURCE = 'core.ecosystem.composition';
const MAX_BYTES = 65536;
const ID = /^[a-z0-9][a-z0-9-]{1,23}$/;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every(key => allowed.includes(key));
const fail = () => Object.assign(new Error('Reviewed ecosystem composition is unavailable.'), { status: 503, code: 'ECOSYSTEM_COMPOSITION_INVALID' });
function validateComposition(raw) {
  const check = condition => { if (!condition) throw fail(); };
  check(keys(raw, ['version', 'reviewedAt', 'source', 'nodes', 'links', 'workflows', 'placements']));
  check(raw.version === 1 && text(raw.source, 240) && typeof raw.reviewedAt === 'string'
    && /^\d{4}-\d\d-\d\d$/.test(raw.reviewedAt) && Number.isFinite(Date.parse(raw.reviewedAt))
    && new Date(raw.reviewedAt).toISOString().slice(0, 10) === raw.reviewedAt);
  check(Array.isArray(raw.nodes) && raw.nodes.length > 0 && raw.nodes.length <= 64
    && Array.isArray(raw.links) && raw.links.length <= 128 && Array.isArray(raw.workflows) && raw.workflows.length <= 16 && object(raw.placements));
  const ids = new Set();
  for (const node of raw.nodes) {
    check(keys(node, ['id', 'name', 'subtitle', 'kind', 'status', 'host', 'specs', 'roles', 'attention', 'planned', 'evidence']));
    check(typeof node.id === 'string' && ID.test(node.id) && !ids.has(node.id) && text(node.name, 100) && text(node.subtitle, 180)
      && ['host', 'vm', 'service', 'storage', 'edge', 'network', 'spare', 'client', 'external'].includes(node.kind)
      && ['installed', 'planned', 'attention'].includes(node.status));
    check(node.host === undefined || (typeof node.host === 'string' && ID.test(node.host)));
    for (const key of ['specs', 'roles']) check(node[key] === undefined || (Array.isArray(node[key]) && node[key].length <= 12 && node[key].every(v => text(v, 240))));
    for (const key of ['attention', 'planned', 'evidence']) check(node[key] === undefined || text(node[key], 500));
    check(node.status !== 'attention' || Boolean(node.attention));
    check(JSON.stringify(node).length <= 3000);
    const place = raw.placements[node.id];
    check(keys(place, ['x', 'z', 'width', 'height', 'depth', 'y']));
    check(['x', 'z', 'width', 'height', 'depth'].every(key => typeof place[key] === 'number' && Number.isFinite(place[key]))
      && Math.abs(place.x) <= 23 && Math.abs(place.z) <= 23
      && ['width', 'height', 'depth'].every(key => place[key] >= 0.3 && place[key] <= 10)
      && (place.y === undefined || (typeof place.y === 'number' && Number.isFinite(place.y) && place.y >= 0 && place.y <= 10)));
    ids.add(node.id);
  }
  check(Object.keys(raw.placements).every(id => ids.has(id)));
  const byId = new Map(raw.nodes.map(node => [node.id, node]));
  for (const node of raw.nodes) {
    check(!node.host || (node.host !== node.id && byId.get(node.host)?.kind === 'host'));
  }
  const links = new Set();
  for (const link of raw.links) {
    check(keys(link, ['from', 'to', 'kind', 'label']) && ids.has(link.from) && ids.has(link.to) && link.from !== link.to
      && ['lan', 'dns', 'storage', 'media', 'audio', 'compute', 'metrics'].includes(link.kind) && (link.label === undefined || text(link.label, 160)));
    const key = JSON.stringify([link.from, link.to, link.kind]); check(!links.has(key)); links.add(key);
  }
  const flows = new Set();
  for (const flow of raw.workflows) {
    check(keys(flow, ['id', 'title', 'stops', 'branches', 'note']) && typeof flow.id === 'string' && ID.test(flow.id) && !flows.has(flow.id)
      && text(flow.title, 160) && (flow.note === undefined || text(flow.note, 1000))
      && Array.isArray(flow.stops) && flow.stops.length >= 2 && flow.stops.length <= 12
      && (flow.branches === undefined || (Array.isArray(flow.branches) && flow.branches.length <= 4 && flow.branches.every(row => Array.isArray(row) && row.length >= 2 && row.length <= 12))));
    for (const stop of [...flow.stops, ...(flow.branches || []).flat()]) check(keys(stop, ['node', 'label', 'note']) && ids.has(stop.node) && text(stop.label, 160) && (stop.note === undefined || text(stop.note, 500)));
    flows.add(flow.id);
  }
  const json = JSON.stringify(raw); check(Buffer.byteLength(json) <= MAX_BYTES - 2048);
  return JSON.parse(json);
}
function loadComposition(env = process.env) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config/ecosystem-composition.json');
  let data;
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw fail();
    data = validateComposition(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) { if (error.code === 'ENOENT') return null; throw fail(); }
  return { contentRevision: createHash('sha256').update(JSON.stringify(data)).digest('hex'), data };
}
function compositionView({ env = process.env, reader, now = Date.now } = {}) {
  const view = loadComposition(env);
  if (!view) return null;
  const at = now(), observedAt = new Date(at).toISOString(), expiresAt = new Date(at + 5 * 60000).toISOString();
  const read = reader.publishEcosystemComposition({ contract: 'agentx.presentation-read/v1', source: SOURCE,
    ...view.data, page: 'ecosystem', contentRevision: view.contentRevision, observedAt, expiresAt, compositionSource: view.data.source, source: SOURCE });
  if (!read) throw fail();
  return { ...view, read };
}
module.exports = { SOURCE, MAX_BYTES, validateComposition, loadComposition, compositionView };
