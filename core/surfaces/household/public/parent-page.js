/* Family review: actions first, optional setup and history in disclosures. */
window.HouseholdParents = { async load({ app, api, esc, setRuntime, toast }) {
    const ageLabel = { little: 'Early childhood', school: 'School age', teen: 'Teen' };
    const cadenceLabel = { once: 'One-time', daily: 'Every day', weekly: 'Every week' };
    app.innerHTML = `<section class="family-overview"><div><p class="eyebrow">Super Dad · Family</p><h1>The household, together.</h1><p class="muted">Household tasks and the kids’ conversations.</p></div><div class="row wrap"><span id="parentSummary" class="pill">Loading…</span><button id="familyPerformance" type="button" class="compact">Context and performance</button></div></section>
    <section class="parent-grid"><article class="card full" id="familyShopping"></article>
      <article id="familyLaunchCard" class="card full family-launch"><h2>A first profile</h2><p class="muted">Choose useful tasks to start with. You can edit or uncheck each suggestion.</p>
        <form id="familyLaunchForm" class="stack"><div class="parent-profile-form"><label><span>First name</span><input id="launchProfileName" maxlength="80" required placeholder="Child’s first name"></label><label><span>Avatar</span><input id="launchProfileAvatar" maxlength="8" value="⭐" aria-label="First profile avatar"></label><label><span>Age group</span><select id="launchProfileAge"><option value="little">Early childhood</option><option value="school" selected>School age</option><option value="teen">Teen</option></select></label></div>
        <fieldset class="launch-routines"><legend>To start · 1 to 5 tasks</legend>${[
          ['Put your things back where they belong', 'daily', 2, 'Start with what you used last.'],
          ['Get your things ready for tomorrow', 'daily', 3, 'Bag, clothes or anything you will need.'],
          ['Help tidy a shared space', 'weekly', 4, 'Ask a parent which space needs help.']
        ].map(([title, cadence, stars, note], i) => `<div class="launch-routine"><input type="checkbox" checked aria-label="Include task ${i + 1}"><input data-launch-title maxlength="160" value="${esc(title)}" aria-label="Task ${i + 1} title"><select data-launch-cadence aria-label="Task ${i + 1} frequency">${Object.entries(cadenceLabel).map(([value, label]) => `<option value="${value}" ${value === cadence ? 'selected' : ''}>${label}</option>`).join('')}</select><select data-launch-stars aria-label="Task ${i + 1} stars">${[1,2,3,4,5].map(value => `<option ${value === stars ? 'selected' : ''}>${value}</option>`).join('')}</select><input class="launch-note" data-launch-note maxlength="1000" value="${esc(note)}" aria-label="Help for task ${i + 1}"></div>`).join('')}</fieldset><div class="row wrap"><button id="familyLaunchButton" class="primary">Create the profile and tasks</button><a class="button" href="/kids">See the Kids space</a></div></form>
      </article>
      <article class="card full family-tasks"><div class="row"><h2 class="grow">Tasks</h2><span id="parentPending" class="pill family-attention" hidden></span></div><div id="familyOrganizer"></div><div id="chores" class="stack"></div>
        <details id="choreCreate" class="family-disclosure"><summary>Add a task</summary><form id="choreForm" class="parent-chore-form"><label><span>For</span><select id="choreProfile" required></select></label><label class="wide-field"><span>Task</span><input id="choreTitle" maxlength="160" required placeholder="Pack the school bag"></label><label><span>Date</span><input id="choreDue" type="date"></label><label><span>Frequency</span><select id="choreCadence"><option value="once">One-time</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></label><label><span>Stars</span><select id="choreStars"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label><label class="wide-field"><span>Optional help</span><input id="choreNote" maxlength="1000" placeholder="A small hint to succeed"></label><button class="primary">Add the task</button></form></details><div id="choreSetupEmpty" class="empty" hidden>Create a profile to add tasks.</div>
      </article>
      <article class="card full"><details class="family-disclosure" id="profileDetails"><summary>Kids’ profiles <span id="profilesCount" class="pill">0</span></summary><div id="profiles" class="profile-list"></div><details id="profileCreate" class="family-disclosure"><summary>Add a profile</summary><form id="profileForm" class="parent-profile-form"><label><span>First name</span><input id="profileName" maxlength="80" required placeholder="Child’s first name"></label><label><span>Avatar</span><input id="profileAvatar" maxlength="8" value="⭐" aria-label="Profile avatar"></label><label><span>Age group</span><select id="profileAge"><option value="little">Early childhood</option><option value="school" selected>School age</option><option value="teen">Teen</option></select></label><button class="primary">Create profile</button></form></details></details></article>
      <article class="card full"><details class="family-disclosure" id="familyJournal"><summary>Conversations with Nestor <span id="journalAlert" class="pill family-attention" hidden></span></summary><div class="row wrap journal-toolbar"><div class="row wrap journal-filters" role="group" aria-label="Show conversations"><button type="button" class="compact journal-filter" data-journal-view="recent" aria-pressed="true">Recent</button><button type="button" class="compact journal-filter" data-journal-view="safety" aria-pressed="false">To review</button><button type="button" class="compact journal-filter" data-journal-view="all" aria-pressed="false">Show all</button></div><span id="journalCount" class="pill">Loading…</span><button id="refreshJournal" type="button">Refresh</button></div><div id="journal" class="stack"></div></details></article>
      <article class="card full" id="familyDevicesCard"></article>
    </section>`;
    window.HouseholdFamilyDevices?.mount({ host: document.getElementById('familyDevicesCard'), api, esc, toast });
    const preferences = window.ConversationPreferences.mount({ button: document.getElementById('familyPerformance'), api,
      endpoint: '/api/voice-personas/preferences?space=family', title: 'Family · Context and performance' });
    window.addEventListener('pagehide', () => preferences.clear(), { once: true });
    document.getElementById('familyLaunchCard').hidden = true;
    document.getElementById('profileForm').closest('article').hidden = true;
    document.getElementById('choreForm').hidden = true;
    window.HouseholdShopping.mount({ host: document.getElementById('familyShopping'), api, esc, canBuy: true });
    const organizer = window.FamilyOrganizer.mount({ host: document.getElementById('familyOrganizer'),
      list: document.getElementById('chores'), api, esc, refresh: refreshFamily, toast });
    let profiles = [];
    let familyRequest = 0;
    let journalRows = [];
    let journalView = 'recent';
    // Names the clip a turn offered; an unknown id still shows as its raw id
    // rather than disappearing from the parent's view.
    const soundsById = new Map();
    const journalRecentLimit = 8;
    let familyLoaded = false;
    async function refreshFamily() {
      const request = ++familyRequest;
      try {
        const [profileData, choreData] = await Promise.all([api('/api/family/profiles'), api('/api/family/chores')]);
        if (request !== familyRequest) return;
        profiles = profileData.profiles;
        const hasProfiles = profiles.length > 0;
        document.getElementById('familyLaunchCard').hidden = hasProfiles;
        if (!hasProfiles) document.getElementById('familyLaunchButton').disabled = false;
        document.getElementById('profileForm').closest('article').hidden = !hasProfiles;
        document.getElementById('profiles').innerHTML = profiles.length ? profiles.map((profile) => `<div class="profile-chip"><span class="kid-avatar">${esc(profile.avatar)}</span><div class="grow"><strong>${esc(profile.displayName)}</strong><small>${esc(ageLabel[profile.ageBand] || profile.ageBand)}</small></div><button class="compact danger archive-profile" data-id="${esc(profile.id)}">Archive</button></div>`).join('') : '<div class="empty">No profile yet.</div>';
        const chosenProfile = document.getElementById('choreProfile').value;
        document.getElementById('choreProfile').innerHTML = profiles.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.avatar)} ${esc(profile.displayName)}</option>`).join('');
        if (profiles.some(profile => profile.id === chosenProfile)) document.getElementById('choreProfile').value = chosenProfile;
        document.getElementById('choreForm').hidden = !profiles.length;
        document.getElementById('choreSetupEmpty').hidden = Boolean(profiles.length);
        organizer.update(profiles, choreData);
        document.getElementById('parentSummary').textContent = choreData.chores.length ? `${choreData.chores.length} active task${choreData.chores.length > 1 ? 's' : ''}` : 'All up to date';
        document.getElementById('profilesCount').textContent = profiles.length;
        const pending = choreData.chores.filter(chore => chore.status === 'review').length;
        document.getElementById('parentPending').hidden = !pending;
        document.getElementById('parentPending').textContent = `${pending} to approve`;
        document.querySelectorAll('.archive-profile').forEach((button) => button.addEventListener('click', async () => {
          if (!window.confirm('Archive this profile? Its tasks stay in the history.')) return;
          button.disabled = true;
          try { await api('/api/family/profiles/archive', { method: 'POST', body: JSON.stringify({ profileId: button.dataset.id }) }); await refreshFamily(); }
          catch (error) { toast(error.message); button.disabled = false; }
        }));
        familyLoaded = true;
        setRuntime(true, 'family tracking ready');
      } catch (error) {
        if (request !== familyRequest) return;
        setRuntime(false, 'family tracking unavailable');
        document.querySelector('[data-family-coverage]').textContent = 'Could not refresh. The tasks shown may have changed. Try again with Refresh.';
        // A first load that fails would leave the page saying Loading… with its forms hidden: retry on its own.
        if (!familyLoaded) {
          document.getElementById('parentSummary').textContent = 'Family tracking unavailable · retrying…';
          setTimeout(refreshFamily, 10000);
        }
      }
    }
    function renderJournal() {
      const safetyRows = journalRows.filter((row) => row.parentAttention || (Array.isArray(row.safetyFlags) && row.safetyFlags.length));
      const visibleRows = journalView === 'all'
        ? journalRows
        : journalView === 'safety' ? safetyRows : journalRows.slice(0, journalRecentLimit);
      const count = journalView === 'recent'
        ? `${visibleRows.length} of ${journalRows.length} conversations`
        : journalView === 'safety' ? `${visibleRows.length} to review` : `${visibleRows.length} conversations`;
      document.getElementById('journalCount').textContent = count;
      const alert = document.getElementById('journalAlert');
      alert.hidden = !safetyRows.length; alert.textContent = `${safetyRows.length} to review`;
      document.querySelectorAll('.journal-filter').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.journalView === journalView));
      });
      document.getElementById('journal').innerHTML = visibleRows.length ? visibleRows.map((row) => {
        return window.JournalDisplay.row(row, { esc, sound: row.soundId ? soundsById.get(row.soundId) : null });
      }).join('') : `<div class="empty">${journalRows.length ? 'No conversation to review in this period.' : 'No conversation yet.'}</div>`;
    }
    async function refreshJournal() {
      try {
        if (!soundsById.size) {
          const catalog = await api('/api/voice-personas/sounds').catch(() => ({ sounds: [] }));
          (catalog.sounds || []).forEach((sound) => soundsById.set(sound.id, sound));
        }
        // Flagged turns older than the recent window still belong in "to review".
        const [data, flagged] = await Promise.all([api('/api/voice-personas/audit/recent?childSafe=true&limit=80'),
          api('/api/voice-personas/alerts').catch(() => ({ alerts: { items: [] } }))]);
        const recent = Array.isArray(data.audit) ? data.audit : [];
        const seen = new Set(recent.map((row) => row.id));
        const older = (flagged.alerts?.items || []).filter((row) => row.id && !seen.has(row.id));
        journalRows = recent.concat(older).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        renderJournal();
      } catch (error) { document.getElementById('journal').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
    }
    document.getElementById('familyLaunchForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('familyLaunchButton');
      if (button.disabled) return;
      const routines = [...document.querySelectorAll('.launch-routine')]
        .filter((row) => row.querySelector('input[type="checkbox"]').checked)
        .map((row) => ({
          title: row.querySelector('[data-launch-title]').value,
          note: row.querySelector('[data-launch-note]').value,
          cadence: row.querySelector('[data-launch-cadence]').value,
          stars: Number(row.querySelector('[data-launch-stars]').value)
        }));
      if (!routines.length) { toast('Choose at least one task to start.'); return; }
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
        toast('The profile and its tasks are ready.');
        await refreshFamily();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
    document.getElementById('profileForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.target.querySelector('button.primary');
      if (button.disabled) return; button.disabled = true;
      try {
        await api('/api/family/profiles', { method: 'POST', body: JSON.stringify({ displayName: document.getElementById('profileName').value, avatar: document.getElementById('profileAvatar').value, ageBand: document.getElementById('profileAge').value }) });
        document.getElementById('profileName').value = '';
        document.getElementById('profileCreate').open = false;
        await refreshFamily();
      } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });
    document.getElementById('choreForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.target.querySelector('button.primary');
      if (button.disabled) return; button.disabled = true;
      const due = document.getElementById('choreDue').value;
      try {
        await api('/api/family/chores', { method: 'POST', body: JSON.stringify({ profileId: document.getElementById('choreProfile').value, title: document.getElementById('choreTitle').value, note: document.getElementById('choreNote').value, cadence: document.getElementById('choreCadence').value, stars: Number(document.getElementById('choreStars').value), dueAt: due || null }) });
        document.getElementById('choreTitle').value = '';
        document.getElementById('choreNote').value = '';
        document.getElementById('choreCreate').open = false;
        await refreshFamily();
      } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });
    document.querySelectorAll('.journal-filter').forEach((button) => button.addEventListener('click', () => {
      journalView = button.dataset.journalView;
      renderJournal();
    }));
    document.getElementById('refreshJournal').addEventListener('click', refreshJournal);
    await Promise.all([refreshFamily(), refreshJournal()]);
} };
