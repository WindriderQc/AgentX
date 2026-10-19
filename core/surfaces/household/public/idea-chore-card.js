/* A chore Nestor proposed in the idea inbox (#864): the parent sees it as the child
   would, picks the child, frequency and stars, then creates it. Nothing exists
   in the Kids Room before that click. */
(function () {
  'use strict';
  const stars = count => '★'.repeat(Math.max(1, Math.min(5, Number(count) || 1)));

  function previewText(chore, profiles) {
    const child = profiles.find(profile => profile.id === chore.profileId);
    return `${child ? `${child.avatar || '⭐'} ` : ''}${chore.title} · ${window.FamilyFrequency.kidLabel(chore)} · ${stars(chore.stars)}`;
  }

  function row(idea, profiles, esc) {
    const chore = idea.familyChore || {}, frequency = window.FamilyFrequency;
    const preview = previewText(chore, profiles);
    return `<div class="dad-task idea-chore" data-idea="${esc(idea.id)}">
        <div class="dad-task-main"><div><strong>${esc(chore.title)}</strong><small>Nestor · proposed chore${idea.createdAt ? ` · ${esc(new Date(idea.createdAt).toLocaleDateString('en-CA', { day: 'numeric', month: 'long' }))}` : ''}</small>
        ${idea.text && idea.text.includes(' — ') ? `<p class="muted">${esc(idea.text.split(' — ').slice(1).join(' — '))}</p>` : ''}
        ${chore.note ? `<p class="family-chore-note">${esc(chore.note)}</p>` : ''}
        <p class="idea-chore-preview"><span>In the Kids Room</span><output data-chore-preview>${esc(preview)}</output></p></div></div>
        <form class="idea-chore-form" data-chore-form>
          <label><span>For</span><select name="profileId" required><option value="">Choose a child…</option>${profiles.map(profile => `<option value="${esc(profile.id)}"${profile.id === chore.profileId ? ' selected' : ''}>${esc(profile.displayName)}</option>`).join('')}</select></label>
          <label><span>Frequency</span><select name="cadence">${frequency.options(chore.cadence)}</select></label>
          <label><span>Stars</span><select name="stars">${[1, 2, 3, 4, 5].map(value => `<option${value === chore.stars ? ' selected' : ''}>${value}</option>`).join('')}</select></label>
          ${frequency.fields()}
        </form>
        <div class="row wrap dad-task-actions"><button class="compact primary" data-idea-action="family_chore">Create the chore</button><button class="compact" data-idea-action="park">Later</button>
        <button class="compact danger" data-idea-action="reject">Reject</button></div></div>`;
  }

  /** Binds the frequency fields of every rendered proposal. */
  function bind(list, ideas, profiles = []) {
    list.querySelectorAll('[data-chore-form]').forEach(form => {
      const card = form.closest('[data-idea]');
      const idea = ideas.find(entry => entry.id === card.dataset.idea);
      if (!idea?.familyChore) return;
      window.FamilyFrequency.fill(form, idea.familyChore);
      window.FamilyFrequency.bind(form, form.elements.cadence);
      const refresh = () => {
        const choice = read(card), days = choice.intervalDays;
        card.querySelector('[data-chore-preview]').textContent = previewText({ ...idea.familyChore, ...choice,
          currentIntervalDays: days || null, intervalDays: days || null }, profiles);
      };
      form.addEventListener('change', refresh); form.addEventListener('input', refresh);
      form.addEventListener('submit', event => event.preventDefault());
    });
  }

  /** The parent's choices, sent with the promotion. */
  function read(rowElement) {
    const form = rowElement.querySelector('[data-chore-form]');
    const cadence = form.elements.cadence.value;
    return { profileId: form.elements.profileId.value, cadence, stars: Number(form.elements.stars.value),
      ...window.FamilyFrequency.read(form, cadence) };
  }

  window.IdeaChoreCard = { row, bind, read };
})();
