'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LABEL = /^[^\u0000-\u001f\u007f]{1,48}$/;
const DEVICE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const vector = (value, length) => Array.isArray(value) && value.length === length
  && value.every(number => Number.isFinite(number) && Math.abs(number) <= 25);

function readHouseLayout(env) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  try {
    const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config/housex-layout.json');
    if (fs.statSync(file).size > 32768) return null;
    const { version, approximate, boxes, rooms, pins } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (version !== 1 || !Array.isArray(boxes) || !boxes.length || boxes.length > 120
        || !Array.isArray(rooms) || rooms.length > 10 || !Array.isArray(pins) || pins.length > 14) return null;
    if (!boxes.every(row => row && vector(row.position, 3) && vector(row.size, 3) && row.size.every(n => n > 0)
        && typeof row.color === 'string' && COLOR.test(row.color) && [0, 1, 2].includes(row.layer))) return null;
    if (!rooms.every(row => row && typeof row.label === 'string' && LABEL.test(row.label)
        && vector(row.position, 3))) return null;
    if (!pins.every(row => row && typeof row.id === 'string' && DEVICE.test(row.id)
        && vector(row.position, 3)) || new Set(pins.map(pin => pin.id)).size !== pins.length) return null;
    return { approximate: approximate === true,
      boxes: boxes.map(({ position, size, color, layer }) => ({ position, size, color, layer })),
      rooms: rooms.map(({ label, position }) => ({ label, position })),
      pins: pins.map(({ id, position }) => ({ id, position })) };
  } catch {
    return null;
  }
}

module.exports = { readHouseLayout };
