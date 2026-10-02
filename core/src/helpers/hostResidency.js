'use strict';

const hostConfig = require('./ollamaHostConfig');

// Declared residency of a configured host: 'gpu' (every pin fully in VRAM) or
// 'cpu' (no pin uses VRAM). Unknown hosts are held to the GPU contract.
function hostResidency(hostUrl) {
  return typeof hostConfig.getHostResidency === 'function' ? hostConfig.getHostResidency(hostUrl) : 'gpu';
}

module.exports = { hostResidency };
