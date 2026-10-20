(function () {
    'use strict';

    // The principal card: the Standard/Abliterated switch and the model each
    // option names. The operator chooses both models here; the product ships none.
    const shared = window.NerveCenterShared;

    function optionRow(option, principalModel) {
        const inUse = option.value === principalModel.selected;
        return `<div class="nc-principal-option" data-option="${shared.escapeHtml(option.value)}">
            <strong>${shared.escapeHtml(option.label)}:</strong>
            <span class="nc-muted">${option.model ? shared.escapeHtml(option.model) : 'Not set'}${inUse ? ' (in use)' : ''}</span>
            <button type="button" class="nc-btn nc-principal-edit" data-option="${shared.escapeHtml(option.value)}"
                aria-label="Choose the ${shared.escapeHtml(option.label)} model">Change</button>
        </div>`;
    }

    function build(principalModel) {
        if (!principalModel) return '';
        const unset = principalModel.options.filter(option => !option.model);
        return `<div class="nc-host-card nc-mb-16 nc-td-lg" id="ncPrincipalCard">
            <h4 class="nc-title">Principal model</h4>
            <p class="nc-muted">Main, automatic chats and DSH follow this choice. Context: ${shared.escapeHtml(String(principalModel.contextSize || '--'))} tokens.</p>
            <select id="ncPrincipalChoice" class="nc-inline-select" aria-label="Principal model" ${principalModel.available ? '' : 'disabled'}>
                ${principalModel.options.map(option => `<option value="${shared.escapeHtml(option.value)}" ${option.value === principalModel.selected ? 'selected' : ''} ${option.model ? '' : 'disabled'}>${shared.escapeHtml(option.label)}</option>`).join('')}
            </select>
            <button id="ncPrincipalApply" class="nc-btn" ${principalModel.available ? '' : 'disabled'}>Apply</button>
            <span class="nc-muted"> ${shared.escapeHtml(principalModel.model || 'Configure the principal pin first')}</span>
            <p class="nc-muted">The selection persists. A busy host refuses the switch; retry when its work finishes.</p>
            ${principalModel.options.map(option => optionRow(option, principalModel)).join('')}
            ${unset.length ? `<p class="nc-muted">Choose a model installed on ${shared.escapeHtml(principalModel.hostUrl || 'the principal host')} for ${unset.map(option => shared.escapeHtml(option.label)).join(' and ')}. Nothing loads until you apply a choice.</p>` : ''}
            ${principalModel.model && !principalModel.selected ? `<p class="nc-muted">The pin (${shared.escapeHtml(principalModel.model)}) is neither choice; name it as one to use the switch.</p>` : ''}
            <div id="ncPrincipalEditor" class="nc-principal-editor" hidden>
                <label for="ncPrincipalModelPick" id="ncPrincipalEditorLabel"></label>
                <select id="ncPrincipalModelPick" class="nc-inline-select"></select>
                <button type="button" id="ncPrincipalSave" class="nc-btn">Save</button>
                <button type="button" id="ncPrincipalCancel" class="nc-btn">Cancel</button>
                <p class="nc-muted" id="ncPrincipalEditorNote"></p>
            </div>
            ${principalModel.divergentRoutes?.length ? `<p class="nc-muted">Routes on this host that name an unpinned model block the switch: ${principalModel.divergentRoutes.map(task => shared.escapeHtml(task)).join(', ')}.</p>` : ''}
        </div>`;
    }

    async function putJson(url, body) {
        const reply = await shared.fetchJson(url, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, requestId: globalThis.crypto?.randomUUID?.() })
        });
        if (reply.status !== 'success') throw new Error(reply.message || 'The change failed');
        return reply.data;
    }

    function attachSwitch(principalModel, reload) {
        const button = document.getElementById('ncPrincipalApply');
        if (!button) return;
        button.addEventListener('click', async () => {
            button.disabled = true;
            button.textContent = 'Loading model…';
            try {
                const data = await putJson('/api/nerve-center/principal-model', {
                    selected: document.getElementById('ncPrincipalChoice').value, expectedModel: principalModel.model });
                Toast.success(`Principal model: ${data.model}`);
                shared.invalidateEcosystemSnapshot();
            } catch (error) { Toast.error(error.message); }
            finally { await reload(); }
        });
    }

    async function openEditor(principalModel, option) {
        const editor = document.getElementById('ncPrincipalEditor');
        const pick = document.getElementById('ncPrincipalModelPick');
        const save = document.getElementById('ncPrincipalSave');
        const inUse = option.value === principalModel.selected;
        document.getElementById('ncPrincipalEditorLabel').textContent = `${option.label} model `;
        document.getElementById('ncPrincipalEditorNote').textContent = inUse
            ? 'This option is in use: saving loads the new model on the principal host now.'
            : 'Saving only names the model; it loads when you apply this option.';
        save.textContent = inUse ? 'Save and load' : 'Save';
        save.dataset.option = option.value;
        pick.innerHTML = '<option value="">Loading installed models…</option>';
        pick.disabled = true;
        save.disabled = true;
        editor.hidden = false;
        try {
            const reply = await shared.fetchJson('/api/nerve-center/principal-model/installed');
            const models = reply.status === 'success' ? reply.data.models : [];
            if (!models.length) throw new Error(reply.message || 'The principal host lists no model');
            pick.innerHTML = models.map(name => `<option value="${shared.escapeHtml(name)}" ${name === option.model ? 'selected' : ''}>${shared.escapeHtml(name)}</option>`).join('');
            pick.disabled = false;
            save.disabled = false;
            pick.focus();
        } catch (error) {
            pick.innerHTML = '<option value="">No model listed</option>';
            Toast.error(error.message);
        }
    }

    function attachEditor(principalModel, reload) {
        const card = document.getElementById('ncPrincipalCard');
        if (!card) return;
        card.querySelectorAll('.nc-principal-edit').forEach(button => button.addEventListener('click', () => {
            const option = principalModel.options.find(entry => entry.value === button.dataset.option);
            if (option) openEditor(principalModel, option);
        }));
        document.getElementById('ncPrincipalCancel')?.addEventListener('click', () => {
            document.getElementById('ncPrincipalEditor').hidden = true;
        });
        const save = document.getElementById('ncPrincipalSave');
        save?.addEventListener('click', async () => {
            const model = document.getElementById('ncPrincipalModelPick').value;
            if (!model) return;
            save.disabled = true;
            save.textContent = 'Saving…';
            try {
                await putJson('/api/nerve-center/principal-model/choices', {
                    option: save.dataset.option, model,
                    expectedRevision: principalModel.choicesRevision, expectedModel: principalModel.model });
                Toast.success(`${save.dataset.option === 'standard' ? 'Standard' : 'Abliterated'}: ${model}`);
                shared.invalidateEcosystemSnapshot();
            } catch (error) { Toast.error(error.message); }
            finally { await reload(); }
        });
    }

    function attach(principalModel, reload) {
        if (!principalModel) return;
        attachSwitch(principalModel, reload);
        attachEditor(principalModel, reload);
    }

    window.NerveCenterPrincipalModel = { build, attach };
})();
