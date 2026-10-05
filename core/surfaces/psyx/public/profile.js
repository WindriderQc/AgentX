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
  $('profileStatus').textContent = profile.about || profile.expectations ? '' : 'Vide pour l’instant : PsyX ne sait de toi que ce que la mémoire a retenu.';
}

async function saveProfile() {
  $('profileStatus').textContent = 'Enregistrement…';
  try {
    const result = await api('/api/psyx/state/profile', { method: 'PUT',
      body: JSON.stringify({ about: $('profileAbout').value, expectations: $('profileExpectations').value }) });
    profileDirty = false;
    state.psyxState = result.state;
    renderPsyXState();
    $('profileStatus').textContent = 'Enregistré. PsyX le lit à chaque réponse.';
  } catch (error) {
    $('profileStatus').textContent = 'Le profil n’a pas été enregistré.';
  }
}

function resetProfileDraft() {
  profileDirty = false;
}

function wireProfile() {
  for (const id of ['profileAbout', 'profileExpectations']) $(id).addEventListener('input', () => { profileDirty = true; });
  $('profileForm').addEventListener('submit', (event) => { event.preventDefault(); void saveProfile(); });
}
