'use strict';

// Optional, explicitly shared details of one mesh. Core treats these as untrusted prompt data,
// never as commands or a replacement scene. Topology authority remains GraphysX's validator.
const FOCUS_BYTES = 16 * 1024;
const TOP = ['id', 'type', 'label', 'vertexCount', 'triangleCount', 'complete', 'transform', 'mesh', 'material'];
const MESH = ['positions', 'indices', 'normals', 'uvs', 'groups', 'materials'];
const MATERIAL = ['color', 'emissive', 'emissiveIntensity', 'roughness', 'metalness', 'opacity', 'wireframe', 'texture', 'normalTexture', 'normalScale', 'shader', 'side'];
function invalid(message) { return Object.assign(new Error(`scene.focus ${message}`), { status: 400, code: 'INVALID_PROPOSAL_REQUEST' }); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid('contains an unsupported object or field');
}
function numbers(value, length, integers = false) {
  if (!Array.isArray(value) || value.length !== length || value.some(n => !Number.isFinite(n) || integers && (!Number.isInteger(n) || n < 0))) throw invalid('contains invalid buffer numbers');
}
function data(value, depth = 0) {
  if (depth > 12) throw invalid('is too deeply nested');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && value.length <= 240 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return;
  if (Array.isArray(value)) { for (const entry of value) data(entry, depth + 1); return; }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid('contains a reserved key');
      data(entry, depth + 1);
    }
    return;
  }
  throw invalid('must contain JSON data only');
}
function checkMeshFocus(focus, entities) {
  record(focus, TOP);
  if (Buffer.byteLength(JSON.stringify(focus)) > FOCUS_BYTES) throw invalid(`exceeds ${FOCUS_BYTES} bytes`);
  data(focus);
  if (focus.type !== 'mesh' || typeof focus.complete !== 'boolean'
    || !entities.some(entity => entity.id === focus.id && entity.type === focus.type && entity.label === focus.label)) throw invalid('must identify one mesh in scene.entities');
  if (!Number.isSafeInteger(focus.vertexCount) || focus.vertexCount < 3
    || !Number.isSafeInteger(focus.triangleCount) || focus.triangleCount < 1) throw invalid('has invalid geometry counts');
  if (focus.transform !== undefined) {
    record(focus.transform, ['position', 'rotationDegrees', 'scale']);
    for (const value of Object.values(focus.transform)) numbers(value, 3);
  }
  if (focus.complete) {
    record(focus.mesh, MESH);
    numbers(focus.mesh.positions, focus.vertexCount * 3);
    numbers(focus.mesh.indices, focus.triangleCount * 3, true);
    if (focus.mesh.indices.some(index => index >= focus.vertexCount)) throw invalid('has out-of-range vertex indices');
    if (focus.mesh.normals !== undefined) numbers(focus.mesh.normals, focus.vertexCount * 3);
    if (focus.mesh.uvs !== undefined) numbers(focus.mesh.uvs, focus.vertexCount * 2);
    if (focus.material !== undefined) record(focus.material, MATERIAL);
    if (focus.mesh.materials !== undefined) {
      if (!Array.isArray(focus.mesh.materials)) throw invalid('has invalid material slots');
      for (const material of focus.mesh.materials) record(material, MATERIAL);
    }
  } else if (focus.mesh !== undefined || focus.material !== undefined) throw invalid('a truncated summary cannot carry partial buffers or materials');
  return JSON.parse(JSON.stringify(focus));
}
module.exports = { checkMeshFocus, FOCUS_BYTES };
