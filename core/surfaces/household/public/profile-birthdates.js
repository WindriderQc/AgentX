/* Parent-only birth dates, on the family follow-up page (/dad/family). Core
   keeps the date with the profile and gives Super Dad only the age and the
   birthday; the Family page and child-facing routes never receive it. This
   block only reads and calls the adult profile routes. */
(function () {
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (!response.ok || body.ok === false || body.status === 'error') throw new Error(body.message || `HTTP ${response.status}`);
    return body.data;
  }
  const today = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  };

  function mount(host) {
    host.dataset.mounted = 'true';
    host.innerHTML = `<p class="card-kicker">Dates de naissance · parent</p>
      <p class="muted">Facultatif. Nestor personnel en tire l'âge et la fête de chaque enfant; la page Famille ne la voit jamais.</p>
      <div data-birth-list class="stack"></div><p data-birth-status class="muted" role="status"></p>`;
    const list = host.querySelector('[data-birth-list]');
    const status = (message) => { host.querySelector('[data-birth-status]').textContent = message; };
    const row = (profile) => `<form class="parent-chore" data-birth-profile="${esc(profile.id)}"><div class="grow"><strong>${esc(profile.avatar)} ${esc(profile.displayName)}</strong></div>
      <label><small>Date de naissance</small><input type="date" min="1900-01-01" max="${today()}" value="${esc(profile.birthDate || '')}" aria-label="Date de naissance de ${esc(profile.displayName)}"></label>
      <button class="compact primary">Enregistrer</button><button type="button" class="compact" data-birth-clear>Effacer</button></form>`;
    async function load() {
      try {
        const { profiles } = await api('/api/family/profiles/details');
        list.innerHTML = profiles.map(row).join('') || '<div class="empty">Aucun profil.</div>';
        status('');
      } catch (error) { status(error.message); }
    }
    async function save(form, birthDate) {
      form.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        await api('/api/family/profiles/birth-date', { method: 'POST', body: JSON.stringify({ profileId: form.dataset.birthProfile, birthDate }) });
        status(birthDate ? 'Date de naissance enregistrée.' : 'Date de naissance effacée.');
        await load();
      } catch (error) {
        status(error.message);
        form.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      }
    }
    list.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = event.target.querySelector('input[type="date"]').value;
      if (!value) { status('Choisis une date, ou utilise Effacer.'); return; }
      save(event.target, value);
    });
    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-birth-clear]');
      if (button) save(button.closest('form'), null);
    });
    // Reload when the profile list above changes (added or archived profile).
    new MutationObserver(load).observe(document.getElementById('profiles'), { childList: true });
    load();
  }

  function scan() {
    const profiles = document.getElementById('profiles');
    if (profiles && !document.querySelector('[data-profile-birthdates]')) {
      profiles.insertAdjacentHTML('afterend', '<div class="profile-birthdates" data-profile-birthdates></div>');
    }
    document.querySelectorAll('[data-profile-birthdates]:not([data-mounted])').forEach(mount);
  }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scan);
}());
