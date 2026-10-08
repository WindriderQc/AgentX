/* Family review: actions first, optional setup and history in disclosures. */
window.HouseholdParents = { async load({ app, api, esc, setRuntime, toast }) {
    const ageLabel = { little: 'Petite enfance', school: 'Âge scolaire', teen: 'Adolescence' };
    const cadenceLabel = { once: 'Ponctuelle', daily: 'Chaque jour', weekly: 'Chaque semaine' };
    app.innerHTML = `<section class="family-overview"><div><h1>Suivi familial</h1><p class="muted">Les tâches de la maison et les échanges des enfants.</p></div><div class="row wrap"><span id="parentSummary" class="pill">Chargement…</span><button id="familyPerformance" type="button" class="compact">Contexte et performance</button></div></section>
    <section class="parent-grid">
      <article id="familyLaunchCard" class="card full family-launch"><h2>Un premier profil</h2><p class="muted">Choisis les tâches utiles pour commencer. Tu peux modifier ou décocher chaque proposition.</p>
        <form id="familyLaunchForm" class="stack"><div class="parent-profile-form"><label><span>Prénom</span><input id="launchProfileName" maxlength="80" required placeholder="Prénom de l’enfant"></label><label><span>Avatar</span><input id="launchProfileAvatar" maxlength="8" value="⭐" aria-label="Avatar du premier profil"></label><label><span>Groupe d’âge</span><select id="launchProfileAge"><option value="little">Petite enfance</option><option value="school" selected>Âge scolaire</option><option value="teen">Adolescence</option></select></label></div>
        <fieldset class="launch-routines"><legend>Pour commencer · 1 à 5 tâches</legend>${[
          ['Remettre tes choses à leur place', 'daily', 2, 'Commence par ce que tu as utilisé en dernier.'],
          ['Préparer tes choses pour demain', 'daily', 3, 'Sac, vêtements ou tout ce dont tu auras besoin.'],
          ['Aider à ranger un espace commun', 'weekly', 4, 'Demande à un parent quel espace a besoin d’aide.']
        ].map(([title, cadence, stars, note], i) => `<div class="launch-routine"><input type="checkbox" checked aria-label="Inclure la tâche ${i + 1}"><input data-launch-title maxlength="160" value="${esc(title)}" aria-label="Titre de la tâche ${i + 1}"><select data-launch-cadence aria-label="Fréquence de la tâche ${i + 1}">${Object.entries(cadenceLabel).map(([value, label]) => `<option value="${value}" ${value === cadence ? 'selected' : ''}>${label}</option>`).join('')}</select><select data-launch-stars aria-label="Étoiles de la tâche ${i + 1}">${[1,2,3,4,5].map(value => `<option ${value === stars ? 'selected' : ''}>${value}</option>`).join('')}</select><input class="launch-note" data-launch-note maxlength="1000" value="${esc(note)}" aria-label="Aide pour la tâche ${i + 1}"></div>`).join('')}</fieldset><div class="row wrap"><button id="familyLaunchButton" class="primary">Créer le profil et les tâches</button><a class="button" href="/kids">Voir l’espace Enfants</a></div></form>
      </article>
      <article class="card full family-tasks"><div class="row"><h2 class="grow">Tâches</h2><span id="parentPending" class="pill family-attention" hidden></span></div><div id="chores" class="stack"></div>
        <details id="choreCreate" class="family-disclosure"><summary>Ajouter une tâche</summary><form id="choreForm" class="parent-chore-form"><label><span>Pour</span><select id="choreProfile" required></select></label><label class="wide-field"><span>Tâche</span><input id="choreTitle" maxlength="160" required placeholder="Préparer le sac d’école"></label><label><span>Date</span><input id="choreDue" type="date"></label><label><span>Fréquence</span><select id="choreCadence"><option value="once">Ponctuelle</option><option value="daily">Chaque jour</option><option value="weekly">Chaque semaine</option></select></label><label><span>Étoiles</span><select id="choreStars"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label><label class="wide-field"><span>Aide facultative</span><input id="choreNote" maxlength="1000" placeholder="Un petit indice pour réussir"></label><button class="primary">Ajouter la tâche</button></form></details><div id="choreSetupEmpty" class="empty" hidden>Crée un profil pour ajouter des tâches.</div>
      </article>
      <article class="card full"><details class="family-disclosure" id="profileDetails"><summary>Profils des enfants <span id="profilesCount" class="pill">0</span></summary><div id="profiles" class="profile-list"></div><details id="profileCreate" class="family-disclosure"><summary>Ajouter un profil</summary><form id="profileForm" class="parent-profile-form"><label><span>Prénom</span><input id="profileName" maxlength="80" required placeholder="Prénom de l’enfant"></label><label><span>Avatar</span><input id="profileAvatar" maxlength="8" value="⭐" aria-label="Avatar du profil"></label><label><span>Groupe d’âge</span><select id="profileAge"><option value="little">Petite enfance</option><option value="school" selected>Âge scolaire</option><option value="teen">Adolescence</option></select></label><button class="primary">Créer le profil</button></form></details></details></article>
      <article class="card full"><details class="family-disclosure" id="familyJournal"><summary>Échanges avec Nestor <span id="journalAlert" class="pill family-attention" hidden></span></summary><div class="row wrap journal-toolbar"><div class="row wrap journal-filters" role="group" aria-label="Afficher les échanges"><button type="button" class="compact journal-filter" data-journal-view="recent" aria-pressed="true">Récents</button><button type="button" class="compact journal-filter" data-journal-view="safety" aria-pressed="false">À consulter</button><button type="button" class="compact journal-filter" data-journal-view="all" aria-pressed="false">Tout afficher</button></div><span id="journalCount" class="pill">Chargement…</span><button id="refreshJournal" type="button">Actualiser</button></div><div id="journal" class="stack"></div></details></article>
    </section>`;
    const preferences = window.ConversationPreferences.mount({ button: document.getElementById('familyPerformance'), api,
      endpoint: '/api/voice-personas/preferences?space=family', title: 'Famille · Contexte et performance' });
    window.addEventListener('pagehide', () => preferences.clear(), { once: true });
    document.getElementById('profileForm').closest('article').hidden = true;
    document.getElementById('choreForm').closest('article').hidden = true;
    let profiles = [];
    let journalRows = [];
    let journalView = 'recent';
    // Names the clip a turn offered; an unknown id still shows as its raw id
    // rather than disappearing from the parent's view.
    const soundsById = new Map();
    const journalRecentLimit = 8;
    async function refreshFamily() {
      try {
        const [profileData, choreData] = await Promise.all([api('/api/family/profiles'), api('/api/family/chores')]);
        profiles = profileData.profiles;
        const hasProfiles = profiles.length > 0;
        document.getElementById('familyLaunchCard').hidden = hasProfiles;
        if (!hasProfiles) document.getElementById('familyLaunchButton').disabled = false;
        document.getElementById('profileForm').closest('article').hidden = !hasProfiles;
        document.getElementById('choreForm').closest('article').hidden = !hasProfiles;
        document.getElementById('profiles').innerHTML = profiles.length ? profiles.map((profile) => `<div class="profile-chip"><span class="kid-avatar">${esc(profile.avatar)}</span><div class="grow"><strong>${esc(profile.displayName)}</strong><small>${esc(ageLabel[profile.ageBand] || profile.ageBand)}</small></div><button class="compact danger archive-profile" data-id="${esc(profile.id)}">Archiver</button></div>`).join('') : '<div class="empty">Aucun profil pour le moment.</div>';
        document.getElementById('choreProfile').innerHTML = profiles.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.avatar)} ${esc(profile.displayName)}</option>`).join('');
        document.getElementById('choreForm').hidden = !profiles.length;
        document.getElementById('choreSetupEmpty').hidden = Boolean(profiles.length);
        const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
        document.getElementById('chores').innerHTML = choreData.chores.length ? [...choreData.chores].sort((a, b) => Number(b.status === 'review') - Number(a.status === 'review')).map((chore) => {
          const profile = profileMap.get(chore.profileId);
          const waiting = chore.status === 'review';
          return `<div class="parent-chore ${waiting ? 'warning' : ''}"><div class="grow"><strong>${esc(profile?.avatar || '⭐')} ${esc(chore.title)}</strong><small>${esc(profile?.displayName || chore.profileId)} · ${esc(cadenceLabel[chore.cadence] || chore.cadence)} · ${'★'.repeat(chore.stars)}${chore.dueAt ? ` · ${esc(new Date(chore.dueAt).toLocaleDateString())}` : ''}${waiting ? ' · à valider' : ''}</small></div><div class="row wrap">${waiting ? `<button class="compact primary chore-action" data-action="approve" data-ref="${esc(chore.id)}">Valider</button><button class="compact chore-action" data-action="reopen" data-ref="${esc(chore.id)}">À refaire</button>` : ''}<button class="compact danger chore-action" data-action="cancel" data-ref="${esc(chore.id)}">Annuler</button></div></div>`;
        }).join('') : '<div class="empty">Aucune tâche active. Tout est à jour.</div>';
        document.getElementById('parentSummary').textContent = choreData.chores.length ? `${choreData.chores.length} tâche${choreData.chores.length > 1 ? 's' : ''} active${choreData.chores.length > 1 ? 's' : ''}` : 'Tout est à jour';
        document.getElementById('profilesCount').textContent = profiles.length;
        const pending = choreData.chores.filter(chore => chore.status === 'review').length;
        document.getElementById('parentPending').hidden = !pending;
        document.getElementById('parentPending').textContent = `${pending} à valider`;
        document.querySelectorAll('.archive-profile').forEach((button) => button.addEventListener('click', async () => {
          if (!window.confirm('Archiver ce profil ? Ses tâches restent dans l’historique.')) return;
          button.disabled = true;
          try { await api('/api/family/profiles/archive', { method: 'POST', body: JSON.stringify({ profileId: button.dataset.id }) }); await refreshFamily(); }
          catch (error) { toast(error.message); button.disabled = false; }
        }));
        document.querySelectorAll('.chore-action').forEach((button) => button.addEventListener('click', async () => {
          if (button.dataset.action === 'cancel' && !window.confirm('Annuler cette tâche ?')) return;
          button.disabled = true;
          try { await api(`/api/family/chores/${button.dataset.action}`, { method: 'POST', body: JSON.stringify({ ref: button.dataset.ref }) }); await refreshFamily(); }
          catch (error) { toast(error.message); button.disabled = false; }
        }));
        setRuntime(true, 'suivi familial prêt');
      } catch (error) {
        setRuntime(false, 'suivi familial indisponible');
        document.getElementById('chores').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
      }
    }
    function renderJournal() {
      const safetyRows = journalRows.filter((row) => row.parentAttention || (Array.isArray(row.safetyFlags) && row.safetyFlags.length));
      const visibleRows = journalView === 'all'
        ? journalRows
        : journalView === 'safety' ? safetyRows : journalRows.slice(0, journalRecentLimit);
      const count = journalView === 'recent'
        ? `${visibleRows.length} sur ${journalRows.length} échanges`
        : journalView === 'safety' ? `${visibleRows.length} à consulter` : `${visibleRows.length} échanges`;
      document.getElementById('journalCount').textContent = count;
      const alert = document.getElementById('journalAlert');
      alert.hidden = !safetyRows.length; alert.textContent = `${safetyRows.length} à consulter`;
      document.querySelectorAll('.journal-filter').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.journalView === journalView));
      });
      document.getElementById('journal').innerHTML = visibleRows.length ? visibleRows.map((row) => {
        return window.JournalDisplay.row(row, { esc, sound: row.soundId ? soundsById.get(row.soundId) : null });
      }).join('') : `<div class="empty">${journalRows.length ? 'Aucun échange à consulter dans cette période.' : 'Aucun échange pour le moment.'}</div>`;
    }
    async function refreshJournal() {
      try {
        if (!soundsById.size) {
          const catalog = await api('/api/voice-personas/sounds').catch(() => ({ sounds: [] }));
          (catalog.sounds || []).forEach((sound) => soundsById.set(sound.id, sound));
        }
        const data = await api('/api/voice-personas/audit/recent?childSafe=true&limit=80');
        journalRows = Array.isArray(data.audit) ? data.audit : [];
        renderJournal();
      } catch (error) { document.getElementById('journal').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
    }
    document.getElementById('familyLaunchForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('familyLaunchButton');
      const routines = [...document.querySelectorAll('.launch-routine')]
        .filter((row) => row.querySelector('input[type="checkbox"]').checked)
        .map((row) => ({
          title: row.querySelector('[data-launch-title]').value,
          note: row.querySelector('[data-launch-note]').value,
          cadence: row.querySelector('[data-launch-cadence]').value,
          stars: Number(row.querySelector('[data-launch-stars]').value)
        }));
      if (!routines.length) { toast('Choisis au moins une tâche pour commencer.'); return; }
      button.disabled = true;
      try {
        await api('/api/family/launch', {
          method: 'POST',
          body: JSON.stringify({
            profile: {
              displayName: document.getElementById('launchProfileName').value,
              avatar: document.getElementById('launchProfileAvatar').value,
              ageBand: document.getElementById('launchProfileAge').value
            },
            routines
          })
        });
        toast('Le profil et ses tâches sont prêts.');
        await refreshFamily();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
    document.getElementById('profileForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/family/profiles', { method: 'POST', body: JSON.stringify({ displayName: document.getElementById('profileName').value, avatar: document.getElementById('profileAvatar').value, ageBand: document.getElementById('profileAge').value }) });
        document.getElementById('profileName').value = '';
        document.getElementById('profileCreate').open = false;
        await refreshFamily();
      } catch (error) { toast(error.message); }
    });
    document.getElementById('choreForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const due = document.getElementById('choreDue').value;
      try {
        await api('/api/family/chores', { method: 'POST', body: JSON.stringify({ profileId: document.getElementById('choreProfile').value, title: document.getElementById('choreTitle').value, note: document.getElementById('choreNote').value, cadence: document.getElementById('choreCadence').value, stars: Number(document.getElementById('choreStars').value), dueAt: due ? new Date(`${due}T12:00:00`).toISOString() : null }) });
        document.getElementById('choreTitle').value = '';
        document.getElementById('choreNote').value = '';
        document.getElementById('choreCreate').open = false;
        await refreshFamily();
      } catch (error) { toast(error.message); }
    });
    document.querySelectorAll('.journal-filter').forEach((button) => button.addEventListener('click', () => {
      journalView = button.dataset.journalView;
      renderJournal();
    }));
    document.getElementById('refreshJournal').addEventListener('click', refreshJournal);
    await Promise.all([refreshFamily(), refreshJournal()]);
} };
