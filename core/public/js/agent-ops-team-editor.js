(function () {
  'use strict';

  // The identity editor of the Team view. It changes how a persona presents
  // (name, voice, colour, personality) through the prompt library's persona
  // routes; it never touches the agent's runtime, tools or permissions.

  const PROVIDERS = [['kokoro', 'Kokoro'], ['voxcpm', 'VoxCPM (cloned voice)'], ['windows_sapi', 'Windows speech']];
  const STYLES = [['', 'Default avatar'], ['initials', 'Initials'], ['orb', 'Orb']];

  function create({ esc, reload, fetchImpl = window.fetch.bind(window) }) {
    let dialog = null;
    let current = null;
    let draft = null;

    async function call(method, path, body) {
      const response = await fetchImpl(path, { method, headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `The request failed (${response.status}).`);
      return payload.data;
    }

    const options = (pairs, selected) => pairs.map(([value, label]) =>
      `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');

    // owner: set while a persona is being created, for an agent without identity or as one more style of a member.
    function form(row, owner = null) {
      const layout = row.uiConfig?.layoutConfig || {};
      const voice = layout.voice || {};
      const visual = layout.visual || {};
      const local = layout.source?.id === 'agentx-team';
      const kicker = owner ? (owner.agentId ? `New identity · agent ${owner.agentId}` : `New style · ${owner.styleOf}`) : `Identity · ${row.name} v${row.version}`;
      const origin = owner || !layout.source?.edited ? '' : local ? ' This persona was created on this instance.' : ' This persona was edited on this instance.';
      return `
        <form method="dialog" class="agent-ops-editor-form">
          <header><div><span class="agent-ops-kicker">${esc(kicker)}</span><h2>${esc(layout.label || row.name || 'New identity')}</h2></div>
            <button type="button" class="agent-ops-drawer-close" data-editor-close aria-label="Close"><i class="fas fa-xmark"></i></button></header>
          <p class="agent-ops-editor-note">This changes how the member presents. Its model, tools, memory and channels belong to the agent and are not edited here.${origin}</p>
          ${owner ? `<label>Identifier<input name="name" maxlength="120" required pattern="[a-z][a-z0-9_-]*" title="Lowercase letters, digits, _ and -" value="${esc(row.name)}"></label>` : ''}
          <label>Name shown<input name="label" maxlength="80" required value="${esc(layout.label || row.name)}"></label>
          <div class="agent-ops-editor-row">
            <label>Voice engine<select name="provider">${options(PROVIDERS, voice.provider || 'kokoro')}</select></label>
            <label>French voice<input name="voiceFr" maxlength="120" value="${esc(voice.voices?.fr || '')}"></label>
            <label>English voice<input name="voiceEn" maxlength="120" value="${esc(voice.voices?.en || '')}"></label>
          </div>
          <div class="agent-ops-editor-row">
            <label>Avatar<select name="style">${options(STYLES, visual.style || '')}</select></label>
            <label>Colour<input name="color" type="color" value="${esc(/^#[a-f0-9]{6}$/i.test(visual.color || '') ? visual.color : '#52cfc5')}"></label>
          </div>
          <label>Personality<textarea name="personality" rows="12" maxlength="12000" required>${esc(row.systemPrompt)}</textarea></label>
          <p class="agent-ops-editor-error" role="alert" hidden></p>
          <footer>
            ${owner ? '<span></span>' : local ? '<button type="button" class="agent-ops-button" data-editor-remove>Remove this persona</button>'
              : layout.source?.edited ? '<button type="button" class="agent-ops-button" data-editor-reset>Return to default</button>' : '<span></span>'}
            <div><button type="button" class="agent-ops-button" data-editor-close>Cancel</button>
              <button type="submit" class="agent-ops-button primary">${owner ? 'Create identity' : 'Save identity'}</button></div>
          </footer>
        </form>`;
    }

    // Only what the owner changed is sent, so saving a new name does not freeze
    // an instance-wide voice into this persona.
    function changes(row, fields) {
      const layout = row.uiConfig?.layoutConfig || {};
      const voice = layout.voice || {};
      const visual = layout.visual || {};
      const body = {};
      if (fields.label !== (layout.label || row.name)) body.label = fields.label;
      if (fields.personality !== row.systemPrompt) body.personality = fields.personality;
      if (fields.provider !== (voice.provider || 'kokoro') || fields.voiceFr !== (voice.voices?.fr || '') || fields.voiceEn !== (voice.voices?.en || '')) {
        body.voice = { provider: fields.provider, voices: { ...(fields.voiceFr ? { fr: fields.voiceFr } : {}), ...(fields.voiceEn ? { en: fields.voiceEn } : {}) } };
      }
      if (fields.style !== (visual.style || '') || (fields.style && fields.color.toLowerCase() !== (visual.color || '').toLowerCase())) {
        body.visual = fields.style ? { style: fields.style, color: fields.color } : null;
      }
      return body;
    }

    // A new persona carries what it was given; a voice only when one was typed.
    function creation(owner, fields) {
      const voices = { ...(fields.voiceFr ? { fr: fields.voiceFr } : {}), ...(fields.voiceEn ? { en: fields.voiceEn } : {}) };
      return { ...owner, name: fields.name, label: fields.label, personality: fields.personality,
        ...(Object.keys(voices).length ? { voice: { provider: fields.provider, voices } } : {}),
        ...(fields.style ? { visual: { style: fields.style, color: fields.color } } : {}) };
    }

    function fail(message) {
      const box = dialog.querySelector('.agent-ops-editor-error');
      box.textContent = message;
      box.hidden = false;
    }

    async function finish(work) {
      try {
        await work();
        dialog.close();
        await reload();
      } catch (error) {
        fail(error.message);
      }
    }

    function ensureDialog() {
      if (dialog) return;
      dialog = document.createElement('dialog');
      dialog.className = 'agent-ops-editor';
      document.body.appendChild(dialog);
      dialog.addEventListener('click', (event) => {
        if (event.target.closest('[data-editor-close]')) dialog.close();
        else if (event.target.closest('[data-editor-reset]')) {
          finish(() => call('DELETE', `/api/prompts/catalog/${encodeURIComponent(current.name)}/edit`));
        } else if (event.target.closest('[data-editor-remove]')) {
          finish(() => call('DELETE', `/api/prompts/catalog/${encodeURIComponent(current.name)}`));
        }
      });
      dialog.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.target);
        const fields = Object.fromEntries(['name', 'label', 'personality', 'provider', 'voiceFr', 'voiceEn', 'style', 'color']
          .map((name) => [name, String(data.get(name) || '').trim()]));
        if (draft) return finish(() => call('POST', '/api/prompts/catalog', creation(draft, fields)));
        const body = changes(current, fields);
        if (!Object.keys(body).length) return dialog.close();
        return finish(() => call('PUT', `/api/prompts/catalog/${encodeURIComponent(current.name)}`, body));
      });
    }

    // owner: { agentId } for an agent without identity, or { styleOf } for one more style of a member.
    function openNew(owner, suggestion = {}) {
      ensureDialog();
      draft = owner;
      current = { name: suggestion.name || '', systemPrompt: '', uiConfig: { layoutConfig: { label: suggestion.label || '' } } };
      dialog.innerHTML = form(current, draft);
      return dialog.showModal();
    }

    async function open(personaId) {
      ensureDialog();
      draft = null;
      try {
        current = await call('GET', `/api/prompts/catalog/${encodeURIComponent(personaId)}`);
      } catch (error) {
        dialog.innerHTML = `<div class="agent-ops-editor-form"><p class="agent-ops-editor-error" role="alert">${esc(error.message)}</p>
          <footer><span></span><div><button type="button" class="agent-ops-button" data-editor-close>Close</button></div></footer></div>`;
        return dialog.showModal();
      }
      dialog.innerHTML = form(current);
      return dialog.showModal();
    }

    return { open, openNew, changes, creation };
  }

  window.AgentOpsTeamEditor = { create };
})();
