/* "Proposer une plante" in Ma jungle (#876). A child takes one photo on the
   family tablet and may pick the room; nothing else is typed. The photo goes
   to Dad as a draft: the child then sees it waiting, opened, in Ma jungle or
   answered ("Papa a vu ta plante"), and acknowledges the answer before
   proposing again. Rendering is pure (panelHtml); the controller owns requests. */
(function () {
  'use strict';
  const endpoint = '/api/family/plant-proposals';

  const ERRORS = {
    PLANT_PHOTO_TOO_LARGE: 'Ta photo est trop grosse. Essaie encore, un peu plus loin.',
    PLANT_PHOTO_INVALID: 'Cette photo ne marche pas. Reprends-en une autre.',
    PLANT_PROPOSAL_PENDING: 'Ta plante attend déjà Papa.',
    PLANT_PROPOSAL_PROFILE_UNKNOWN: 'Choisis ton nom en haut.'
  };
  const errorText = error => ERRORS[error?.code] || (error?.status === 413 ? ERRORS.PLANT_PHOTO_TOO_LARGE : error?.message) || 'Ça n’a pas marché. Réessaie.';

  function photoHtml(src, esc) {
    return src ? `<img class="propose-photo" src="${esc(src)}" alt="Ta photo de plante">` : '<span class="propose-photo propose-no-photo" aria-hidden="true">🌱</span>';
  }

  /** The panel for one state; `model` is the controller's state. */
  function panelHtml(model, esc) {
    const { profile, loading, unavailable, draft, proposal, rooms = [], busy, message } = model;
    const note = message ? `<p class="propose-message" role="alert">${esc(message)}</p>` : '';
    if (!profile) return '<div class="propose-card propose-guest"><span aria-hidden="true">🌱</span><p>Choisis ton nom en haut pour proposer une plante.</p></div>';
    if (loading) return '<div class="propose-card" role="status">Chargement…</div>';
    if (unavailable) return `<div class="propose-card"><p>On ne peut pas proposer de plante pour l’instant.</p><button type="button" data-propose-retry>Réessayer</button></div>`;
    if (draft) {
      return `<div class="propose-card propose-draft">${photoHtml(draft.preview, esc)}
        <div class="propose-body"><h2>Elle vit où ?</h2>
        <div class="propose-rooms" role="group" aria-label="La pièce de ta plante">${[...rooms, null].map(room =>
          `<button type="button" class="propose-room" data-propose-room="${esc(room || '')}" aria-pressed="${draft.room === room}">${esc(room || 'Je ne sais pas')}</button>`).join('')}</div>
        ${note}<div class="propose-actions"><button type="button" class="propose-send" data-propose-send${busy ? ' disabled' : ''}>${busy ? 'J’envoie…' : 'Envoyer à Papa'}</button>
        <button type="button" class="propose-cancel" data-propose-cancel${busy ? ' disabled' : ''}>Annuler</button></div></div></div>`;
    }
    if (proposal && ['pending', 'opened'].includes(proposal.state)) {
      return `<div class="propose-card propose-waiting">${photoHtml(proposal.photoUrl, esc)}<div class="propose-body">
        <h2><span aria-hidden="true">${proposal.state === 'opened' ? '👀' : '⏳'}</span> ${proposal.state === 'opened' ? 'Papa regarde ta plante.' : 'Ta plante attend Papa.'}</h2>
        <p>${proposal.room ? `${esc(proposal.room)} · ` : ''}Tu pourras en proposer une autre quand Papa aura répondu.</p></div></div>`;
    }
    if (proposal?.state === 'accepted') {
      return `<div class="propose-card propose-answer accepted">${photoHtml(proposal.photoUrl, esc)}<div class="propose-body">
        <h2><span aria-hidden="true">🎉</span> ${esc(proposal.plant?.nickname || 'Ta plante')} est dans Ma jungle !</h2>
        ${proposal.plant ? `<a class="propose-open" href="/kids/plants?plant=${encodeURIComponent(proposal.plant.id)}">Voir ma plante</a>` : ''}
        ${note}<button type="button" data-propose-seen${busy ? ' disabled' : ''}>OK</button></div></div>`;
    }
    if (proposal?.state === 'declined') {
      return `<div class="propose-card propose-answer declined">${photoHtml(proposal.photoUrl, esc)}<div class="propose-body">
        <h2><span aria-hidden="true">💌</span> ${esc(proposal.reply || 'Papa a vu ta plante.')}</h2>
        ${note}<button type="button" data-propose-seen${busy ? ' disabled' : ''}>OK</button></div></div>`;
    }
    return `<div class="propose-card propose-idle"><label class="propose-start${busy ? ' busy' : ''}">
      <input type="file" accept="image/*" capture="environment" data-propose-photo hidden${busy ? ' disabled' : ''}>
      <span aria-hidden="true">📷</span><span><strong>${busy ? 'Je prépare ta photo…' : 'Proposer une plante'}</strong><small>Prends une photo, Papa va la regarder.</small></span></label>${note}</div>`;
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Cette photo ne se lit pas.'));
      reader.readAsDataURL(file);
    });
  }

  /** Reduces the photo in the browser to a display rendition of 2 MB or less. */
  async function photoDataUrl(file, images = window.NestorAttachmentImages, read = readAsDataUrl) {
    if (!images?.isImage(file) || !images.accepts(file)) throw Object.assign(new Error(ERRORS.PLANT_PHOTO_INVALID), { code: 'PLANT_PHOTO_INVALID' });
    return read(await images.reduce(file));
  }

  /**
   * Mounts the panel in `host`. `profile()` returns the selected child or null.
   * Returns the controller so Ma jungle can refresh it when the child changes.
   */
  function mount({ host, api, esc, profile, prepare = photoDataUrl }) {
    const model = { profile: null, loading: false, unavailable: false, draft: null, proposal: null, rooms: [], busy: false, message: '' };
    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
    let generation = 0;

    function render() {
      host.innerHTML = panelHtml(model, esc);
      const on = (selector, handler) => host.querySelectorAll(selector).forEach(node => { node.onclick = handler; });
      const input = host.querySelector('[data-propose-photo]');
      if (input) input.onchange = () => { const [file] = input.files || []; input.value = ''; if (file) controller.choosePhoto(file); };
      on('[data-propose-room]', event => controller.chooseRoom(event.currentTarget.dataset.proposeRoom || null));
      on('[data-propose-send]', () => controller.send());
      on('[data-propose-cancel]', () => controller.cancel());
      on('[data-propose-seen]', () => controller.acknowledge());
      on('[data-propose-retry]', () => controller.refresh());
    }

    const controller = {
      model,
      async refresh() {
        const child = profile();
        const mine = ++generation;
        Object.assign(model, { profile: child, draft: null, proposal: null, message: '', unavailable: false, busy: false, loading: Boolean(child) });
        render();
        if (!child) return;
        try {
          const data = await api(`${endpoint}?profileId=${encodeURIComponent(child.id)}`);
          if (mine !== generation) return; // another child was chosen meanwhile
          Object.assign(model, { loading: false, rooms: data.rooms || [], proposal: data.proposal || null });
        } catch {
          if (mine !== generation) return;
          Object.assign(model, { loading: false, unavailable: true });
        }
        render();
      },
      async choosePhoto(file) {
        if (model.busy) return;
        Object.assign(model, { busy: true, message: '' });
        render();
        try {
          const dataUrl = await prepare(file);
          Object.assign(model, { draft: { dataUrl, preview: dataUrl, room: null } });
        } catch (error) { model.message = errorText(error); }
        model.busy = false;
        render();
      },
      chooseRoom(room) {
        if (!model.draft || model.busy) return;
        model.draft.room = model.rooms.includes(room) ? room : null;
        render();
      },
      cancel() {
        if (model.busy) return;
        Object.assign(model, { draft: null, message: '' });
        render();
      },
      async send() {
        if (!model.draft || model.busy) return;
        const child = model.profile;
        Object.assign(model, { busy: true, message: '' });
        render();
        try {
          const { proposal } = await post(endpoint, { profileId: child.id, room: model.draft.room, dataUrl: model.draft.dataUrl });
          Object.assign(model, { busy: false, draft: null, proposal });
          render();
        } catch (error) {
          model.busy = false;
          // Already waiting (another tablet, a double tap): show the proposal that waits.
          if (error.code === 'PLANT_PROPOSAL_PENDING') return controller.refresh();
          model.message = errorText(error);
          render();
        }
      },
      async acknowledge() {
        if (!model.proposal || model.busy) return;
        Object.assign(model, { busy: true, message: '' });
        render();
        try {
          const data = await post(`${endpoint}/${encodeURIComponent(model.proposal.id)}/seen`, { profileId: model.profile.id });
          Object.assign(model, { busy: false, proposal: data.proposal || null });
        } catch (error) { Object.assign(model, { busy: false, message: errorText(error) }); }
        render();
      }
    };
    controller.refresh();
    return controller;
  }

  window.KidsPlantProposal = { mount, panelHtml, photoDataUrl, errorText };
})();
