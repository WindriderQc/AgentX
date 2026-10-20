/* Ma jungle (/kids/plants, #870): the published family plants for the children.
   Tablet first, big targets, pictures before words. A plant card shows its
   needs, a do-not-eat warning when it applies, its fun fact, the child's own
   care chore (checked in like any Kids Room chore) and "Nestor me présente…",
   a spoken introduction built only from the card. Nothing here is generated. */
(function () {
  'use strict';
  const MOODS = {
    thirsty: ['💧', 'I’m thirsty!', 'thirsty'],
    needs_care: ['🌞', 'I need care', 'care'],
    waiting: ['⏳', 'Dad is checking', 'waiting'],
    happy: ['😊', 'All good', 'happy']
  };
  const NEEDS = [['light', '☀️', 'Light'], ['water', '💧', 'Water'], ['humidity', '💨', 'Air']];

  const mood = plant => MOODS[plant.mood] || MOODS.happy;
  const mine = (plant, profileId) => (plant.care || []).filter(chore => chore.profileId === profileId);
  const dueFor = (plant, profileId) => mine(plant, profileId).find(chore => !chore.waiting && (chore.overdue || chore.dueToday)) || null;

  /** Plants waiting on this child first, then plants needing care, then by name. */
  function ordered(plants, profileId) {
    const rank = plant => dueFor(plant, profileId) ? 0 : plant.mood === 'happy' ? 2 : 1;
    return [...plants].sort((a, b) => rank(a) - rank(b) || String(a.nickname).localeCompare(String(b.nickname), 'fr'));
  }

  /** The introduction, in the plant's own voice, from its published card only. */
  function introText(plant, childName = '') {
    const sentence = text => String(text || '').trim().replace(/([^.!?])$/, '$1.');
    return [
      `Salut${childName ? ` ${childName}` : ''} ! Moi, c’est ${plant.nickname}.`,
      plant.commonName && `Mon nom de plante, c’est ${plant.commonName}.`,
      plant.needs?.light && `Pour la lumière : ${sentence(plant.needs.light)}`,
      plant.needs?.water && `Pour l’eau : ${sentence(plant.needs.water)}`,
      plant.doNotEat && 'Attention : on ne mange jamais mes feuilles, et les animaux non plus !',
      plant.funFact && `Le sais-tu ? ${sentence(plant.funFact)}`
    ].filter(Boolean).join(' ');
  }

  function photoHtml(plant, esc, className) {
    const photo = plant.photos?.[0];
    return photo ? `<img class="${className}" src="${esc(photo.url)}" alt="${esc(plant.nickname)}" loading="lazy">`
      : `<span class="${className} jungle-no-photo" aria-hidden="true">🌿</span>`;
  }

  function galleryHtml(plants, profileId, esc) {
    if (!plants.length) return '<div class="jungle-empty"><span aria-hidden="true">🌱</span><h2>No plant yet</h2><p>Dad adds the plants of the house here.</p></div>';
    return `<div class="jungle-gallery">${ordered(plants, profileId).map(plant => {
      const [icon, label, kind] = mood(plant), due = dueFor(plant, profileId);
      return `<a class="jungle-tile mood-${kind}${due ? ' mine' : ''}" href="/kids/plants?plant=${encodeURIComponent(plant.id)}" data-plant-id="${esc(plant.id)}">
        <span class="jungle-photo-wrap">${photoHtml(plant, esc, 'jungle-photo')}<span class="jungle-mood"><span aria-hidden="true">${icon}</span>${label}</span></span>
        <strong>${esc(plant.nickname)}</strong><small>${esc([plant.commonName, plant.room].filter(Boolean).join(' · '))}</small></a>`;
    }).join('')}</div>`;
  }

  function actionHtml(plant, profileId, esc) {
    const due = dueFor(plant, profileId);
    if (due) return `<button type="button" class="jungle-done" data-jungle-check="${esc(due.ref)}"><span aria-hidden="true">✓</span>Done: ${esc(due.title)}!</button>`;
    const checked = mine(plant, profileId).find(chore => chore.waiting);
    if (checked) return '<p class="jungle-waiting"><span aria-hidden="true">⏳</span>Dad will check. Thank you!</p>';
    const next = mine(plant, profileId).sort((a, b) => String(a.dueDay).localeCompare(String(b.dueDay)))[0];
    return `<p class="jungle-rest"><span aria-hidden="true">😊</span>${next ? `Next for you: ${esc(next.title)}` : `Nothing to do for ${esc(plant.nickname)} today.`}</p>`;
  }

  function cardHtml(plant, profileId, esc) {
    const [icon, label, kind] = mood(plant);
    const needs = NEEDS.filter(([key]) => plant.needs?.[key]);
    return `<article class="jungle-card">
      <div class="jungle-card-photo">${photoHtml(plant, esc, 'jungle-big-photo')}<span class="jungle-mood mood-${kind}"><span aria-hidden="true">${icon}</span>${label}</span></div>
      <div class="jungle-card-body">
        <a class="jungle-back" href="/kids/plants" data-jungle-gallery>← Ma jungle</a>
        <h1>${esc(plant.nickname)}</h1><p class="jungle-species">${esc([plant.commonName, plant.room].filter(Boolean).join(' · '))}</p>
        <button type="button" class="jungle-intro" data-jungle-intro><span class="jungle-play" aria-hidden="true">▶</span><span><strong>Nestor me présente ${esc(plant.nickname)}</strong><small>Listen to ${esc(plant.nickname)}</small></span></button>
        <div class="jungle-action" data-jungle-action>${actionHtml(plant, profileId, esc)}</div>
        ${needs.length ? `<h2>What I need</h2><ul class="jungle-needs">${needs.map(([key, emoji, title]) =>
          `<li><span class="jungle-need-icon" aria-hidden="true">${emoji}</span><span><small>${title}</small>${esc(plant.needs[key])}</span></li>`).join('')}</ul>` : ''}
        ${plant.doNotEat ? '<p class="jungle-do-not-eat"><span aria-hidden="true">🚫</span>Never eat my leaves. Not for the pets either!</p>' : ''}
        ${plant.funFact ? `<p class="jungle-fact"><strong>Did you know?</strong> ${esc(plant.funFact)}</p>` : ''}
        <a class="jungle-ask" href="/kids?ask=${encodeURIComponent(`Parle-moi de ${plant.nickname}, notre ${plant.commonName || 'plante'}.`)}">Ask Nestor about ${esc(plant.nickname)}</a>
      </div></article>`;
  }

  async function mount({ app, api, esc, toast, speak, stopPlayback, setRuntime }) {
    const params = () => new URLSearchParams(location.search);
    let profiles = [], plants = [], profileId = params().get('profile') || '';
    try { profileId ||= localStorage.getItem('household.kids.profile') || ''; } catch { /* tab-only choice */ }
    app.innerHTML = `<section class="kids-room jungle"><div class="kids-shell"><header class="kids-header jungle-header">
      <div><a class="jungle-back" href="/kids">← Kids Room</a><p class="eyebrow">Kids Room</p><h1>Ma jungle</h1></div>
      <label class="kid-profile"><span>Who are you?</span><select id="jungleProfile"></select></label></header>
      <p class="jungle-hello" data-jungle-hello hidden></p><div data-jungle-body><div class="empty" role="status">Loading…</div></div></div></section>`;
    const body = app.querySelector('[data-jungle-body]'), select = app.querySelector('#jungleProfile');
    const child = () => profiles.find(profile => profile.id === profileId);

    function render() {
      const id = params().get('plant'), plant = id && plants.find(entry => entry.id === id);
      const hello = app.querySelector('[data-jungle-hello]');
      const waitingOnMe = plants.filter(entry => dueFor(entry, profileId));
      hello.hidden = Boolean(plant) || !waitingOnMe.length;
      hello.innerHTML = waitingOnMe.length ? `<span aria-hidden="true">💧</span><span><strong>${esc(waitingOnMe.map(entry => entry.nickname).join(', '))}</strong> ${waitingOnMe.length > 1 ? 'need' : 'needs'} you today, ${esc(child()?.displayName || 'friend')}!</span>` : '';
      body.innerHTML = plant ? cardHtml(plant, profileId, esc) : galleryHtml(plants, profileId, esc);
      app.querySelector('.jungle')?.classList.toggle('jungle-detail', Boolean(plant));
      body.querySelectorAll('[data-plant-id], [data-jungle-gallery]').forEach(link => link.addEventListener('click', event => {
        event.preventDefault(); stopPlayback?.(); history.pushState(null, '', link.getAttribute('href')); render();
      }));
      const intro = body.querySelector('[data-jungle-intro]');
      if (intro) intro.onclick = async () => {
        intro.classList.add('playing');
        try { await speak(introText(plant, child()?.displayName), 'fr'); }
        catch { toast('The voice is not available right now.'); }
        finally { intro.classList.remove('playing'); }
      };
      const done = body.querySelector('[data-jungle-check]');
      if (done) done.onclick = async () => {
        done.disabled = true;
        try {
          await api('/api/family/chores/check-in', { method: 'POST', body: JSON.stringify({ profileId, ref: done.dataset.jungleCheck }) });
          await reload();
          toast('Bravo! Dad will check.');
        } catch (error) { toast(error.message); done.disabled = false; }
      };
    }

    async function reload() {
      ({ plants } = await api('/api/family/plants'));
      render();
    }

    try {
      const [family] = await Promise.all([api('/api/family/profiles'), reload()]);
      profiles = family.profiles || [];
      if (!profiles.some(profile => profile.id === profileId)) profileId = profiles[0]?.id || '';
      select.innerHTML = profiles.length ? profiles.map(profile => `<option value="${esc(profile.id)}"${profile.id === profileId ? ' selected' : ''}>${esc(profile.avatar)} ${esc(profile.displayName)}</option>`).join('')
        : '<option value="">Guest</option>';
      select.disabled = !profiles.length;
      render();
      setRuntime?.(true, `${plants.length} plant${plants.length === 1 ? '' : 's'}`);
    } catch (error) {
      body.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
      setRuntime?.(false, 'plants unavailable');
    }
    select.addEventListener('change', () => {
      profileId = select.value;
      try { localStorage.setItem('household.kids.profile', profileId); } catch { /* tab-only choice */ }
      render();
    });
    window.addEventListener('popstate', () => { stopPlayback?.(); render(); });
  }

  window.KidsPlants = { mount, ordered, introText, galleryHtml, cardHtml, dueFor };
})();
