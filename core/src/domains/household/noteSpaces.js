'use strict';

// Storage scopes and legacy pack IDs belong to the note domain. Reading notes
// must work without loading voice personas or their presentation assets.
const noteSpaces = Object.freeze({
  personal: Object.freeze({ audience: 'owner', scopeId: 'personal', packIds: Object.freeze(['personal_operator']) }),
  family: Object.freeze({ audience: 'household', scopeId: 'family', packIds: Object.freeze(['kidx_nestor', 'kidx_reader']) }),
});

function packIdsSharingMemory(pack) {
  if (!pack) return [];
  const ids = noteSpaces[pack.memoryGroup]?.packIds;
  return ids?.includes(pack.id) ? [...ids] : [pack.id];
}

const personalCanReadFamily = () => process.env.HOUSEHOLD_PERSONAL_FAMILY_MEMORY_READ === 'true';

module.exports = { noteSpaces, packIdsSharingMemory, personalCanReadFamily };
