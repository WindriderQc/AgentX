'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { checkMeshFocus, FOCUS_BYTES } = require('../mesh-focus');
const { checkScene, buildUserPrompt } = require('..');
const entities = [{ id: 'sail', type: 'mesh', label: 'Sail' }];
const source = () => ({ id: 'sail', type: 'mesh', label: 'Sail', complete: true, vertexCount: 3, triangleCount: 1,
  mesh: { positions: [0,0,0, 1,0,0, 0,1,0], indices: [0,1,2], uvs: [0,0, 1,0, 0,1] }, material: { color: '#ffffff' } });
describe('explicit GraphysX mesh focus', () => {
  test('legacy scenes remain unchanged and selected details survive the prompt as data', () => {
    const plain = { id: 'world', label: 'World', entities };
    assert.deepEqual(checkScene(plain), plain);
    const focus = source(), scene = checkScene({ ...plain, focus });
    assert.deepEqual(scene.focus, focus);
    focus.mesh.positions[0] = 20;
    assert.equal(scene.focus.mesh.positions[0], 0);
    assert.deepEqual(JSON.parse(buildUserPrompt({ request: 'Raise vertex 2', revision: 1, scene })).scene.focus, scene.focus);
  });
  test('large meshes can be reported honestly as summary only', () => {
    const focus = { id: 'sail', type: 'mesh', label: 'Sail', complete: false, vertexCount: 4000, triangleCount: 8000 };
    assert.deepEqual(checkMeshFocus(focus, entities), focus);
    assert.throws(() => checkMeshFocus({ ...focus, mesh: source().mesh }, entities), /truncated/);
  });
  for (const [index, change] of [
    focus => { focus.id = 'absent'; },
    focus => { focus.type = 'box'; },
    focus => { focus.label = 'different'; },
    focus => { focus.transcript = 'private'; },
    focus => { focus.mesh.indices[0] = 99; },
    focus => { focus.mesh.positions[0] = NaN; },
    focus => { focus.mesh.uvs.pop(); },
    focus => { focus.material.secret = 'private'; },
  ].entries()) test(`refuses invalid focus case ${index}`, () => {
    const focus = source(); change(focus);
    assert.throws(() => checkMeshFocus(focus, entities));
  });
  test('enforces the serialized budget before detailed traversal', () => {
    const focus = source(); focus.mesh.positions = Array(FOCUS_BYTES).fill(0);
    assert.throws(() => checkMeshFocus(focus, entities), /exceeds/);
  });
});
