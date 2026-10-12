(function () {
  'use strict';

  // The "new member" guide of the Team view. Core does not write the agent
  // runtime's configuration: the harness owns its tools and permissions and
  // stays replaceable. The entry format belongs to the instance, which
  // supplies it as config/agent-ops-new-member.json (handoffs.newMember):
  // { runtime, entryPath, entry, notes[] }, where entry may use {{id}},
  // {{name}} and {{model}} in keys and string values.

  const ID = /^[a-z][a-z0-9-]{0,63}$/;

  function fill(value, fields) {
    if (typeof value === 'string') return value.replace(/\{\{(id|name|model)\}\}/g, (_match, key) => fields[key]);
    if (Array.isArray(value)) return value.map((item) => fill(item, fields));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [fill(key, fields), fill(item, fields)]));
    }
    return value;
  }

  // The configuration entry for one agent, from the instance's template.
  function entry(template, fields) {
    return template?.entry ? fill(template.entry, fields) : null;
  }

  function create({ esc }) {
    let dialog = null;
    let template = null;

    function snippet() {
      const data = new FormData(dialog.querySelector('form'));
      const fields = { id: String(data.get('id') || '').trim(), name: String(data.get('name') || '').trim(), model: String(data.get('model') || '').trim() };
      const output = dialog.querySelector('[data-guide-output]');
      const ready = Boolean(template) && ID.test(fields.id) && fields.name && fields.model;
      output.textContent = !template ? 'This instance supplies no entry template (config/agent-ops-new-member.json).'
        : ready ? JSON.stringify(entry(template, fields), null, 2) : 'Fill in the three fields to prepare the entry.';
      dialog.querySelector('[data-guide-copy]').disabled = !ready;
      dialog.querySelector('[data-guide-identity]').textContent = fields.id || 'the new agent';
    }

    function open(models = [], newMember = null) {
      template = newMember?.entry ? newMember : null;
      if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.className = 'agent-ops-editor';
        document.body.appendChild(dialog);
        dialog.addEventListener('input', snippet);
        // The guide writes nothing: Enter in a field must not close it.
        dialog.addEventListener('submit', (event) => event.preventDefault());
        dialog.addEventListener('click', async (event) => {
          if (event.target.closest('[data-editor-close]')) return dialog.close();
          const copy = event.target.closest('[data-guide-copy]');
          if (!copy) return undefined;
          try {
            await navigator.clipboard.writeText(dialog.querySelector('[data-guide-output]').textContent);
            copy.textContent = 'Copied';
          } catch { copy.textContent = 'Select the text and copy it'; }
          return undefined;
        });
      }
      const known = [...new Set(models.filter(Boolean))];
      dialog.innerHTML = `
        <form method="dialog" class="agent-ops-editor-form">
          <header><div><span class="agent-ops-kicker">New member</span><h2>Add an agent to the team</h2></div>
            <button type="button" class="agent-ops-drawer-close" data-editor-close aria-label="Close"><i class="fas fa-xmark"></i></button></header>
          <p class="agent-ops-editor-note">An agent is created in the agent runtime, which owns its tools, memory and permissions. AgentX prepares the entry; nothing is written from this page.</p>
          <div class="agent-ops-editor-row">
            <label>Agent id<input name="id" maxlength="64" required pattern="[a-z][a-z0-9-]*" title="Lowercase letters, digits and -" placeholder="scout"></label>
            <label>Name<input name="name" maxlength="80" required placeholder="Scout"></label>
          </div>
          <label>Model<input name="model" maxlength="160" required list="agentOpsGuideModels" value="${esc(known[0] || '')}">
            <datalist id="agentOpsGuideModels">${known.map((model) => `<option value="${esc(model)}"></option>`).join('')}</datalist></label>
          <ol class="agent-ops-guide-steps">
            <li>${template ? `Add this entry under <code>${esc(template.entryPath || 'the agent list')}</code> in the ${esc(template.runtime || 'agent runtime')} configuration.` : 'Add the agent to its runtime configuration.'}
              ${(template?.notes || []).map((note) => `<p class="agent-ops-editor-note">${esc(note)}</p>`).join('')}
              <pre data-guide-output></pre>
              <button type="button" class="agent-ops-button" data-guide-copy disabled>Copy the entry</button></li>
            <li>Create its workspace with the instruction files that say what it answers for (its role).</li>
            <li>Restart the runtime gateway, then refresh this page: the agent appears under Team.</li>
            <li>Use “Create identity” on the card of <strong data-guide-identity>the new agent</strong> to give it a name, a voice and a personality.</li>
          </ol>
          <footer><span></span><div><button type="button" class="agent-ops-button" data-editor-close>Close</button></div></footer>
        </form>`;
      snippet();
      return dialog.showModal();
    }

    return { open };
  }

  window.AgentOpsTeamGuide = { create, entry };
})();
