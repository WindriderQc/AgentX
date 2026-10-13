'use strict';

// The user's own description of himself and of what he wants from PsyX. It is
// read at every reply and never rewritten by PsyX. Loaded before app.js, whose
// shared state and helpers these functions use at call time.

let profileDirty = false;

function renderProfile() {
  const profile = state.psyxState?.profile || { about: '', expectations: '' };
  // Never overwrite what the user is typing with a refresh from the server.
  if (profileDirty) return;
  $('profileAbout').value = profile.about || '';
  $('profileExpectations').value = profile.expectations || '';
  $('profileStatus').textContent = profile.about || profile.expectations ? '' : 'Empty for now: PsyX only knows what memory has kept about you.';
}

async function saveProfile() {
  $('profileStatus').textContent = 'Saving…';
  try {
    const result = await api('/api/psyx/state/profile', { method: 'PUT',
      body: JSON.stringify({ about: $('profileAbout').value, expectations: $('profileExpectations').value }) });
    profileDirty = false;
    state.psyxState = result.state;
    renderPsyXState();
    $('profileStatus').textContent = 'Saved. PsyX reads it for every reply.';
  } catch (error) {
    $('profileStatus').textContent = 'The profile was not saved.';
  }
}

function resetProfileDraft() {
  profileDirty = false;
}

function wireProfile() {
  for (const id of ['profileAbout', 'profileExpectations']) $(id).addEventListener('input', () => { profileDirty = true; });
  $('profileForm').addEventListener('submit', (event) => { event.preventDefault(); void saveProfile(); });
}
