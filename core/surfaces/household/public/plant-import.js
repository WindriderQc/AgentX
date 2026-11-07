/* Parent-only folder intake. Selection is one plant (up to four photos).
   A retry keeps the exact selection and identity; Core owns hash deduplication. */
(function () {
  'use strict';
  const endpoint = '/api/family/plants/import-folder';
  function html(result, esc) {
    if (!result.configured) return '<p class="empty">Le dossier d’import n’est pas configuré sur cette instance.</p>';
    const messages = { imported: 'Déjà importée', incomplete: 'Import à reprendre' };
    return `${result.entries.length ? `<div class="plant-import-grid">${result.entries.map(entry => {
      const selectable = ['available', 'incomplete'].includes(entry.state);
      const thumb = entry.sha256 ? `${endpoint}/thumbnail?name=${encodeURIComponent(entry.name)}&sha256=${entry.sha256}` : null;
      return `<label class="card plant-import-photo">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" width="160" height="120">` : ''}
        <span>${esc(entry.name)}</span><span class="muted">${esc(messages[entry.state] || entry.message || entry.roomHint || '')}</span>
        ${selectable ? `<input type="checkbox" name="photo" value="${esc(entry.sha256)}" data-name="${esc(entry.name)}" data-room="${esc(entry.roomHint || '')}">` : ''}
        ${entry.plantId ? `<a href="/dad/family/plants?plant=${encodeURIComponent(entry.plantId)}">Ouvrir la fiche</a>` : ''}</label>`;
    }).join('')}</div>` : '<p class="empty">Aucune photo dans ce dossier.</p>'}
      ${result.truncated ? '<p>Liste bornée aux 500 premières entrées. Réduisez le contenu du dossier pour voir les autres photos.</p>' : ''}
      ${result.nextOffset !== null ? `<button type="button" data-import-next="${result.nextOffset}">Page suivante</button>` : ''}`;
  }
  async function mount({ host, api, esc, onDone }) {
    let offset = 0, busy = false, retry = null;
    const selectedFiles = new Map();
    let nickname = 'Nouvelle plante', room = '';
    async function load() {
      host.innerHTML = '<p role="status">Chargement du dossier…</p>';
      try {
        const result = await api(`${endpoint}?offset=${offset}`);
        host.innerHTML = `<header class="plants-head"><h1>Importer depuis le dossier</h1><button type="button" data-import-back>Retour aux plantes</button></header>
          <p>Choisissez jusqu’à quatre photos d’une même plante, puis créez son brouillon. L’identification attend dans la file Core, une plante à la fois. Les enfants voient uniquement les fiches publiées.</p>
          <form data-import-form>${html(result, esc)}
          ${offset ? '<button type="button" data-import-previous>Page précédente</button>' : ''}
          <p data-import-selection></p>${result.configured && (selectedFiles.size || result.entries.some(entry => ['available', 'incomplete'].includes(entry.state))) ? `
            <label>Nom de la plante <input name="nickname" maxlength="60" required value="${esc(nickname)}"></label>
            <label>Pièce <input name="room" maxlength="60" value="${esc(room)}"></label><button type="submit" class="primary">Créer le brouillon</button>` : ''}</form>
          <p role="status" aria-live="polite" data-import-status></p>`;
        host.querySelector('[data-import-back]').onclick = onDone;
        const form = host.querySelector('[data-import-form]'), status = host.querySelector('[data-import-status]');
        const showSelection = () => {
          host.querySelector('[data-import-selection]').textContent = `${selectedFiles.size}/4 photos choisies : ${Array.from(selectedFiles.values()).map(file => file.name).join(', ')}`;
        };
        form.querySelectorAll('input[name="photo"]').forEach(input => { input.checked = selectedFiles.has(input.value); });
        showSelection();
        form.onchange = () => {
          retry = null;
          form.querySelectorAll('input[name="photo"]').forEach(input => {
            if (input.checked) selectedFiles.set(input.value, { name: input.dataset.name, sha256: input.value });
            else selectedFiles.delete(input.value);
          });
          const selected = form.querySelector('input[name="photo"]:checked');
          if (selected && !form.elements.room.value) form.elements.room.value = selected.dataset.room;
          nickname = form.elements.nickname?.value || nickname; room = form.elements.room?.value || '';
          showSelection();
        };
        host.querySelector('[data-import-previous]')?.addEventListener('click', () => { if (!busy) { offset = Math.max(0, offset - 20); load(); } });
        host.querySelector('[data-import-next]')?.addEventListener('click', event => { if (!busy) { offset = Number(event.currentTarget.dataset.importNext); load(); } });
        form.onsubmit = async event => {
          event.preventDefault();
          if (busy) return;
          const files = Array.from(selectedFiles.values());
          if (!files.length || new Set(files.map(file => file.sha256)).size > 4) { status.textContent = 'Choisissez de 1 à 4 photos de la même plante.'; return; }
          const body = retry || { files, nickname: form.elements.nickname.value, room: form.elements.room.value };
          retry = body; busy = true;
          const controls = Array.from(host.querySelectorAll('button,input')); controls.forEach(control => { control.disabled = true; });
          status.textContent = 'Création du brouillon…';
          try {
            const result = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
            const message = result.planningError ? 'Brouillon créé. L’identification attend la configuration de la file Core.' : 'Brouillon créé. Identification dans la file Core.';
            host.innerHTML = `<article class="card"><h2>${esc(message)}</h2><a class="button" href="/dad/family/plants?plant=${encodeURIComponent(result.plant.id)}">Vérifier le brouillon</a>
              <button type="button" data-import-more>Importer une autre plante</button></article>`;
            host.querySelector('[data-import-more]').onclick = () => { retry = null; selectedFiles.clear(); nickname = 'Nouvelle plante'; room = ''; load(); };
          } catch (error) { status.textContent = `${error.message} Vous pouvez réessayer la même sélection.`; controls.forEach(control => { control.disabled = false; }); }
          finally { busy = false; }
        };
      } catch (error) {
        host.innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" data-import-reload>Réessayer</button><button type="button" data-import-back>Retour aux plantes</button>`;
        host.querySelector('[data-import-reload]').onclick = load;
        host.querySelector('[data-import-back]').onclick = onDone;
      }
    }
    return load();
  }
  window.PlantImport = { html, mount };
})();
