'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../../src/services/ecosystemLiveState');

const NODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,32}$/;
const COLOR = /^#[a-f0-9]{6}$/i;
const identity = row => row && typeof row.id === 'string' && NODE.test(row.id)
  && typeof row.label === 'string' && LABEL.test(row.label);

function readHouseEcosystem(env) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  try {
    const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config/housex-ecosystem.json');
    if (fs.statSync(file).size > 4096) return null;
    const { version, hub, towers } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (version !== 1 || !identity(hub) || !Array.isArray(towers) || towers.length < 2 || towers.length > 4
        || !towers.every(row => identity(row) && typeof row.color === 'string' && COLOR.test(row.color)
          && Number.isInteger(row.gpus) && row.gpus >= 1 && row.gpus <= 3)) return null;
    const nodes = new Map(loadConfig(env).nodes.map(row => [row.id, row]));
    if (!nodes.get(hub.id)?.services || !towers.every(row => nodes.get(row.id)?.hosts)
        || new Set([hub.id, ...towers.map(row => row.id)]).size !== towers.length + 1) return null;
    return {
      hub: { id: hub.id, label: hub.label },
      towers: towers.map(({ id, label, color, gpus }) => ({ id, label, color, gpus }))
    };
  } catch {
    return null;
  }
}

function ecosystemScene({ hub, towers }) {
  const boxes = [], discs = [], paths = [], pins = [];
  const box = (position, size, color, layer = 2, statusFor) => boxes.push({ position, size, color, layer, statusFor });
  const span = (towers.length - 1) * 3.15;
  box([0,-.25,0], [span+3.5,.24,7.7], '#223344', 0);
  box([0,-.015,0], [span+3.34,.08,7.55], '#304858', 1);
  box([0,.08,-2.7], [2.36,.42,1.18], '#1b2c3d');
  box([0,.50,-2.7], [2.15,.045,1.02], '#6babcc');
  box([0,.20,-2.1], [1.38,.115,.048], '#718899', 2, hub.id);
  pins.push({ ...hub, position:[0,.56,-2.67], labelLift:18 });
  for (const [index, tower] of towers.entries()) {
    const x = index*3.15 - span/2;
    const z = 1.5;
    const { color, gpus, id, label } = tower;
    box([x,.07,z], [2.46,.18,2.47], '#253748');
    box([x,.23,z], [1.96,2.66,1.93], '#172433');
    box([x,2.89,z], [1.82,.07,1.76], '#435769');
    box([x,.36,z+.97], [1.78,2.32,.07], '#243745');
    box([x-.86,.38,z+1.02], [.06,2.29,.06], color);
    box([x+.86,.38,z+1.02], [.06,2.29,.06], color);
    box([x,2.60,z+1.02], [1.77,.072,.055], color);
    box([x,.40,z+1.02], [1.77,.064,.056], color);
    for (let slot = 0; slot < gpus; slot++) {
      const y = .63 + slot*.32;
      box([x-.22,y,z+1.035], [1.08,.225,.074], color, 3);
      discs.push({ position:[x-.55,y+.113,z+1.076], radius:.077, color:'#192633' },
        { position:[x+.10,y+.113,z+1.076], radius:.077, color:'#192633' });
    }
    for (const y of [1.91,2.35]) {
      discs.push({ position:[x+.32,y,z+1.061], radius:.204, color },
        { position:[x+.32,y,z+1.067], radius:.157, color:'#172535' });
    }
    for (const offset of [-.6,-.44,-.28]) box([x+offset,1.80,z+1.02], [.065,.69,.047], color);
    box([x-.29,.49,z+1.066], [1.02,.082,.041], '#718899', 3, id);
    paths.push({ points:[[0,.095,-2.07],[0,.095,-1.25],[x,.095,-1.25],[x,.095,z-1.22]], color });
    pins.push({ id, label, position:[x,2.96,z+.58] });
  }
  return { boxes, discs, paths, pins, rooms: [], camera: { rotation: -.26, elevation: .54 } };
}

module.exports = { readHouseEcosystem, ecosystemScene };
