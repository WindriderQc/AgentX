(function () {
  'use strict';

  // The "new member" guide of the Team view. Core does not write the agent
  // runtime's configuration: the harness owns its tools and permissions and
  // stays replaceable. The guide prepares the entry to paste there, with the
  // narrowest tool profile, and says what to do before coming back to give
  // the agent an identity.

  const ID = /^[a-z][a-z0-9-]{0,63}$/;

  // The configuration entry for one agent, keyed by its id. Tools start minimal:
  // widening them is a deliberate edit in the harness.
  function entry({ id, name, model }) {
    return { [id]: {
      name,
      workspace: `~/.openclaw/workspace-${id}`,
      agentDir: `~/.openclaw/agents/${id}/agent`,
      model: { primary: model, fallbacks: [] },
      identity: { name },
      tools: { profile: 'minimal' }
    } };
  }

  function create({ esc }) {
    let dialog = null;

    function snippet() {
      const data = new FormData(dialog.querySelector('form'));
      const fields = { id: String(data.get('id') || '').trim(), name: String(data.get('name') || '').trim(), model: String(data.get('model') || '').trim() };
      const output = dialog.querySelector('[data-guide-output]');
      const ready = ID.test(fields.id) && fields.name && fields.model;
      output.textContent = ready ? JSON.stringify(entry(fields), null, 2) : 'Fill in the three fields to prepare the entry.';
      dialog.querySelector('[data-guide-copy]').disabled = !ready;
      dialog.querySelector('[data-guide-identity]').textContent = fields.id || 'the new agent';
    }

    function open(models = []) {
      if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.className = 'agent-ops-editor';
        document.body.appendChild(dialog);
        dialog.addEventListener('input', snippet);
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
        <form method="dialog" class="agent-ops-editor-form" onsubmit="return false">
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
            <li>Add this entry under <code>agents.entries</code> in the runtime configuration. It starts with the minimal tool profile; add tools there, one need at a time.
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
