'use strict';

function bytes(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function gpuResidency(model) {
  const size = bytes(model?.size);
  const sizeVram = bytes(model?.size_vram);
  if (size == null || size <= 0 || sizeVram == null) return { status: 'unknown', size, sizeVram, ratio: null };
  return { status: sizeVram >= size ? 'full' : sizeVram === 0 ? 'cpu' : 'partial',
    size, sizeVram, ratio: Math.min(1, sizeVram / size) };
}

// Does an observed placement match the host's declared residency?
// A GPU host needs every byte in VRAM. A CPU host needs none: any VRAM use
// means the instance still sees a GPU. A partial spill never matches.
function placementMatches(model, residency = 'gpu') {
  const { status } = gpuResidency(model);
  return residency === 'cpu' ? status === 'cpu' : status === 'full';
}

function expectedStatus(residency = 'gpu') {
  return residency === 'cpu' ? 'cpu' : 'full';
}

module.exports = { gpuResidency, placementMatches, expectedStatus };
