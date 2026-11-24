'use strict';

// The verified instance pin is a server request property, never a body field.
// Owner-unlocked/unverified devices never exercise the new Family lane.
function pinnedFamilyDevice(device) {
  return Boolean(device?.tokenHash && !device.unverified && !device.unlockedUntil);
}
function familyAlbumTurn(device, packId, scopeId) {
  return pinnedFamilyDevice(device) && packId === 'kidx_nestor' && scopeId === 'family';
}
module.exports = { pinnedFamilyDevice, familyAlbumTurn };
