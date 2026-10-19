/* Household plants, parent page /dad/family/plants (#868). One-handed on a phone:
   photograph → Nestor proposes → choose the species → where it lives → care card
   → toxicity check → care actions → publish. Every save carries the revision Core
   gave; a conflict reloads the card instead of overwriting someone else's edit.
   Nothing reaches the children before Publish. */
(function () {
  'use strict';
  const POLL_MS = 2000;
  const view = () => window.PlantView;
  const frequency = () => window.FamilyFrequency;

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('This photo cannot be read.'));
      reader.readAsDataURL(file);
    });
  }

  async function photoDataUrl(file) {
    const images = window.NestorAttachmentImages;
    if (!images.isImage(file) || !images.accepts(file)) throw new Error('Choose a photo of 50 MB or less.');
    return readAsDataUrl(await images.reduce(file));
  }

  function mount({ app, api, esc, toast }) {
    app.innerHTML = '';
    let plant = null, profiles = [], timer = null, busy = false;
    const url = id => `/api/family/plants/${encodeURIComponent(id)}`;
    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
    const stopPolling = () => { clearTimeout(timer); timer = null; };
    const go = (search) => { stopPolling(); history.pushState(null, '', `/dad/family/plants${search}`); route(); };
    window.addEventListener('popstate', () => { stopPolling(); route(); });

    async function route() {
      const id = new URLSearchParams(location.search).get('plant');
      app.querySelector('[data-plants-page]')?.remove();
      const host = document.createElement('section');
      host.dataset.plantsPage = ''; host.className = 'plants-page';
      app.append(host);
      try { return id ? await detail(host, id) : await list(host); }
      catch (error) {
        host.innerHTML = `<article class="card danger-box"><h2>${id ? 'This plant cannot be opened.' : 'The plants cannot be loaded.'}</h2><p>${esc(error.message)}</p><a class="button" href="/dad/family/plants">Back to plants</a></article>`;
      }
    }

    function addButton(label = 'Add a plant') {
      return `<label class="button primary plant-add"><input type="file" accept="image/*" capture="environment" data-plant-photo hidden>
        <span>${label}</span></label>`;
    }

    async function addPlant(file, status) {
      status.textContent = 'Preparing the photo…';
      const dataUrl = await photoDataUrl(file);
      const { plant: created } = await post('/api/family/plants', { nickname: 'New plant' });
      status.textContent = 'Saving the photo…';
      await post(`${url(created.id)}/photos`, { expectedRevision: created.revision, dataUrl });
      await post(`${url(created.id)}/identify`).catch(() => null);
      go(`?plant=${encodeURIComponent(created.id)}`);
    }

    async function list(host) {
      const { plants } = await api('/api/family/plants?view=manage');
      const drafts = plants.filter(entry => entry.status === 'draft'), published = plants.filter(entry => entry.status === 'published');
      host.innerHTML = `<header class="plants-head"><div><p class="eyebrow">Family</p><h1>Plants</h1>
          <p class="muted">Photograph a plant: Nestor proposes the species and a care card, you check and publish. The kids see only published plants.</p></div>
          ${addButton()}</header><p class="muted" data-plant-status role="status" aria-live="polite"></p>
        ${drafts.length ? `<section class="card plants-section"><h2>To review</h2>${drafts.map(entry => view().listRowHtml(entry, esc)).join('')}</section>` : ''}
        <section class="card plants-section"><h2>All plants</h2>${published.length ? published.map(entry => view().listRowHtml(entry, esc)).join('')
          : '<div class="empty">No published plant yet. Start with the one you see most often.</div>'}</section>`;
      const input = host.querySelector('[data-plant-photo]'), status = host.querySelector('[data-plant-status]');
      input.onchange = async () => {
        const [file] = input.files; input.value = '';
        if (!file || busy) return;
        busy = true;
        try { await addPlant(file, status); } catch (error) { status.textContent = error.message; } finally { busy = false; }
      };
      host.querySelectorAll('.plant-row').forEach(link => link.addEventListener('click', event => {
        event.preventDefault(); go(new URL(link.href).search);
      }));
    }

    async function load(id) {
      const [card, family] = await Promise.all([api(`${url(id)}?view=manage`), profiles.length ? null : api('/api/family/profiles')]);
      plant = card.plant;
      if (family) profiles = family.profiles || [];
    }

    // One revision-bound write; a conflict reloads the card and says so.
    async function save(path, body, message) {
      if (busy) return false;
      busy = true;
      try {
        ({ plant } = await post(`${url(plant.id)}${path}`, { expectedRevision: plant.revision, ...body }));
        if (message) toast(message);
        return true;
      } catch (error) {
        if (error.status === 409 && /changed/i.test(error.message)) { toast('This plant changed meanwhile. It was reloaded.'); await load(plant.id); }
        else toast(error.message);
        return false;
      } finally { busy = false; }
    }

    function stepHtml(number, title, body, done = false) {
      return `<section class="card plant-step${done ? ' done' : ''}"><h2><span class="plant-step-number" aria-hidden="true">${done ? '✓' : number}</span>${title}</h2>${body}</section>`;
    }

    function identifyBody() {
      const step = plant.assistant?.identify, chosen = plant.identification;
      if (chosen?.commonName) {
        return `<p class="plant-chosen"><strong>${esc(chosen.commonName)}</strong>${chosen.latinName ? ` <em>${esc(chosen.latinName)}</em>` : ''}</p>
          <button type="button" class="compact" data-plant-change-species>Change the species</button>`;
      }
      const running = step?.state === 'running';
      return `${running ? '<p class="plant-working" role="status">Nestor is looking at the plant…</p>' : ''}
        ${step?.state === 'failed' ? `<p class="plant-note" role="alert">${esc(/VISION_UNAVAILABLE/.test(step.error || '') ? 'The model chosen for plant identification cannot read photos. Choose a vision model for plant_identify in routing, or type the species.' : 'Nestor could not identify this photo. Try again or type the species.')}</p>` : ''}
        ${step?.state === 'completed' ? view().candidatesHtml(step.candidates, esc) : ''}
        <details class="family-disclosure plant-other"${step?.state === 'completed' && step.candidates?.length ? '' : ' open'}><summary>Other species</summary>
          <label class="plant-field"><span>Common name</span><input name="speciesCommon" maxlength="80" placeholder="Pothos doré"></label>
          <label class="plant-field"><span>Latin name (optional)</span><input name="speciesLatin" maxlength="120" placeholder="Epipremnum aureum"></label></details>
        <div class="row wrap"><button type="button" class="primary" data-plant-choose${running ? ' disabled' : ''}>This is it</button>
        ${running ? '' : `<button type="button" class="compact" data-plant-identify${plant.photos.length ? '' : ' disabled'}>${step ? 'Ask Nestor again' : 'Ask Nestor'}</button>`}</div>`;
    }

    function careBody() {
      if (!plant.identification?.commonName) return '<p class="muted">Choose the species first: Nestor drafts the care card from it.</p>';
      const step = plant.assistant?.care, hasCare = Object.keys(plant.careSheet || {}).length || plant.carePlan.length;
      // A draft already on the card is not proposed again.
      const draft = step?.state === 'completed' && step.draft && !view().draftApplied(step.draft, plant) && step.draft;
      const proposal = draft ? `<div class="plant-proposal"><p><strong>Nestor drafted a care card.</strong> ${step.unsourced
          ? 'No web source was available: check each line before applying it.' : 'Each line keeps the sources it came from.'}</p>
        <ul>${view().CARE.filter(([key]) => draft.careSheet?.[key]).slice(0, 3).map(([key, label]) => `<li><span>${label}</span> ${esc(draft.careSheet[key].text)}</li>`).join('')}</ul>
        <div class="row wrap"><button type="button" class="primary" data-plant-apply>${hasCare ? 'Replace with this draft' : 'Use this draft'}</button></div></div>` : '';
      return `${step?.state === 'running' ? '<p class="plant-working" role="status">Nestor is drafting the care card…</p>' : ''}
        ${step?.state === 'failed' ? '<p class="plant-note" role="alert">The draft could not be written. Try again or fill the card yourself.</p>' : ''}
        ${proposal}
        ${step?.state === 'running' ? '' : `<button type="button" class="compact" data-plant-care${plant.identification?.commonName ? '' : ' disabled'}>${step ? 'Draft again' : 'Ask Nestor to draft it'}</button>`}
        <form class="plant-editor" data-plant-editor>
          <div class="plant-where"><label class="plant-field"><span>Nickname</span><input name="nickname" maxlength="60" required value="${esc(plant.nickname)}"></label>
          <label class="plant-field"><span>Room</span><input name="room" maxlength="60" list="plantRooms" value="${esc(plant.room || '')}"></label>
          <datalist id="plantRooms">${view().ROOMS.map(room => `<option value="${esc(room)}">`).join('')}</datalist>
          <label class="plant-field"><span>Where in the room</span><input name="spot" maxlength="120" value="${esc(plant.spot || '')}" placeholder="Near the window"></label></div>
          <h3>Care</h3>${view().careSheetHtml(plant.careSheet, esc)}
          <h3>Toxicity</h3>${view().toxicityHtml(plant.toxicity, esc)}
          <label class="plant-field"><span>Fun fact for the kids</span><input name="funFact" maxlength="300" value="${esc(plant.funFact || '')}"></label>
          <h3>Care actions</h3><p class="muted">Each action becomes a Kids Room chore once the plant is published.</p>
          <div data-plant-actions>${plant.carePlan.map((action, index) => view().actionHtml(action, index, profiles, esc, frequency())).join('')}</div>
          <button type="button" class="compact" data-plant-add-action${plant.carePlan.length >= 8 ? ' disabled' : ''}>Add a care action</button>
          <div class="row wrap plant-save"><button type="submit" class="primary">Save</button></div></form>`;
    }

    function publishBody() {
      const problems = view().problemText(plant.problems);
      if (plant.status === 'published') return `<p>Published. The kids see ${esc(plant.nickname)} in Ma jungle.</p><button type="button" class="compact danger" data-plant-retire>Retire this plant</button>`;
      return `${view().childPreviewHtml(plant, esc)}
        ${problems.length ? `<ul class="plant-problems">${problems.map(problem => `<li>${esc(problem)}</li>`).join('')}</ul>` : '<p>Ready for the kids.</p>'}
        <div class="row wrap"><button type="button" class="primary" data-plant-publish${problems.length ? ' disabled' : ''}>Publish ${esc(plant.nickname)}</button>
        <button type="button" class="compact danger" data-plant-retire>Discard this draft</button></div>`;
    }

    function render(host) {
      const running = ['identify', 'care'].some(step => plant.assistant?.[step]?.state === 'running');
      host.innerHTML = `<header class="plants-head"><div><a href="/dad/family/plants" data-plant-back>← Plants</a>
          <h1>${esc(plant.nickname)}</h1><span class="pill ${plant.status === 'published' ? 'ok' : 'waiting'}">${view().statusLabel(plant.status)}</span></div></header>
        <div class="plant-photos">${plant.photos.map(photo => `<figure><img src="${esc(photo.url)}?view=manage" alt="${esc(plant.nickname)}">
          <button type="button" class="compact" data-plant-remove-photo="${esc(photo.id)}" aria-label="Remove this photo">✕</button></figure>`).join('')}
          ${plant.photos.length < 4 ? `<label class="plant-photo-add"><input type="file" accept="image/*" capture="environment" data-plant-more hidden><span>+ Photo</span></label>` : ''}</div>
        ${stepHtml(1, 'Who is it?', identifyBody(), Boolean(plant.identification?.commonName))}
        ${stepHtml(2, 'Care card and chores', careBody(), !plant.problems.some(code => code !== 'species'))}
        ${stepHtml(3, plant.status === 'published' ? 'For the kids' : 'Publish', publishBody(), plant.status === 'published')}`;
      bind(host);
      frequencyBind(host);
      stopPolling();
      if (running) timer = setTimeout(async () => { try { await load(plant.id); render(host); } catch { /* next visit reloads */ } }, POLL_MS);
    }

    function frequencyBind(host) {
      host.querySelectorAll('[data-action]').forEach(fieldset => {
        const action = plant.carePlan[Number(fieldset.dataset.action)] || {};
        frequency().fill(fieldset, action);
        frequency().bind(fieldset, fieldset.querySelector('[name="cadence"]'));
      });
    }

    function bind(host) {
      const on = (selector, handler) => host.querySelectorAll(selector).forEach(node => node.addEventListener('click', handler));
      host.querySelector('[data-plant-back]').onclick = event => { event.preventDefault(); go(''); };
      on('[data-plant-identify]', async () => { try { ({ plant } = await post(`${url(plant.id)}/identify`)); render(host); } catch (error) { toast(error.message); } });
      on('[data-plant-care]', async () => { try { ({ plant } = await post(`${url(plant.id)}/care-draft`)); render(host); } catch (error) { toast(error.message); } });
      on('[data-plant-change-species]', async () => { if (await save('/update', { identification: null }, null)) render(host); });
      on('[data-plant-choose]', async () => {
        const typed = host.querySelector('[name="speciesCommon"]').value.trim();
        const step = plant.assistant?.identify, picked = host.querySelector('[name="plantCandidate"]:checked');
        const candidate = !typed && picked ? step.candidates[Number(picked.value)] : null;
        if (!typed && !candidate) { toast('Choose a proposed species or type one.'); return; }
        const identification = candidate
          ? { commonName: candidate.commonName, latinName: candidate.latinName, confidence: candidate.confidence, source: 'model', model: step.model, candidates: step.candidates }
          : { commonName: typed, latinName: host.querySelector('[name="speciesLatin"]').value.trim() || null, source: 'parent', candidates: step?.candidates || [] };
        if (await save('/update', { identification }, 'Species saved.')) render(host);
      });
      on('[data-plant-apply]', async () => {
        const { careSheet, toxicity, funFact, carePlan } = plant.assistant.care.draft;
        if (await save('/update', { careSheet, toxicity: { ...toxicity, reviewed: false }, funFact, carePlan }, 'Draft applied. Check it, then confirm the toxicity.')) render(host);
      });
      on('[data-plant-add-action]', () => {
        const actions = host.querySelector('[data-plant-actions]'), index = actions.children.length;
        actions.insertAdjacentHTML('beforeend', view().actionHtml({ cadence: 'interval', intervalDays: 7, stars: 1, minAgeBand: 'school' }, index, profiles, esc, frequency()));
        const fieldset = actions.lastElementChild;
        frequency().fill(fieldset, { intervalDays: 7 }); frequency().bind(fieldset, fieldset.querySelector('[name="cadence"]'));
        fieldset.querySelector('[name="title"]').focus();
      });
      host.querySelector('[data-plant-actions]')?.addEventListener('click', event => {
        const button = event.target.closest('[data-remove-action]');
        if (button) button.closest('[data-action]').remove();
      });
      const editor = host.querySelector('[data-plant-editor]');
      if (editor) editor.onsubmit = async event => {
        event.preventDefault();
        const fields = view().keepSources(view().readEditor(editor, frequency()), plant);
        if (await save('/update', fields, 'Saved.')) render(host);
      };
      on('[data-plant-publish]', async () => { if (await save('/publish', {}, `${plant.nickname} is in Ma jungle.`)) render(host); });
      on('[data-plant-retire]', async () => {
        if (!window.confirm(plant.status === 'draft' ? 'Discard this draft?' : `Retire ${plant.nickname}? The kids will no longer see it.`)) return;
        if (await save('/retire', {}, 'Retired.')) go('');
      });
      host.querySelectorAll('[data-plant-remove-photo]').forEach(button => button.addEventListener('click', async () => {
        if (await save(`/photos/${encodeURIComponent(button.dataset.plantRemovePhoto)}/remove`, {}, 'Photo removed.')) render(host);
      }));
      const more = host.querySelector('[data-plant-more]');
      if (more) more.onchange = async () => {
        const [file] = more.files; more.value = '';
        if (!file) return;
        try { if (await save('/photos', { dataUrl: await photoDataUrl(file) }, 'Photo added.')) render(host); }
        catch (error) { toast(error.message); }
      };
    }

    async function detail(host, id) {
      await load(id);
      render(host);
    }

    return route();
  }

  window.HouseholdPlants = { mount };
})();
