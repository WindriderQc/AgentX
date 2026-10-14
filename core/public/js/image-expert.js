'use strict';
globalThis.AgentXImageExpert = { mount({ getContext, apply, restoreBrief, prepareReferences, matchReferences }) {
  const $ = id => document.getElementById(id);
  if (!$('imagex')) return { refresh() {} };
  const labels = { accepted: 'Recorded', running: 'Consultation in progress…', completed: 'Done', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Stopped', unknown: 'Outcome unknown' };
  let metadata, sessionId = '', turns = [], selectedTurn = '', proposalTurn = null, timer, pending = false, retry = null, fileEpoch = 0, fileUrl;
  const baselines = new Map();
  const constraints = globalThis.ImageBriefConstraints;
  const textPolicy = globalThis.ImageTextPolicy;
  let applied = null;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const active = () => turns.find(turn => ['accepted', 'running'].includes(turn.state));
  const busy = () => pending || !!active();
  const signature = () => { const { references, ...context } = getContext(); return JSON.stringify(context); };
  const uncertainInspection = turn => turn?.inspection?.state === 'unknown';
  const unresolvedInspection = () => turns.find(uncertainInspection);
  const inspectionWarning = turn => `The inspection outcome is unknown. Check the original receipt; another inspection is not started.${turn?.inspection?.requestId ? ` Inspection request: ${turn.inspection.requestId}` : ''}`;
  const terminal = turn => ['failed', 'interrupted', 'cancelled', 'unknown'].includes(turn?.state);
  function errorText(turn) {
    if (/Image expert changed the requested (width|height|profile)/.test(turn.error || '')) {
      const field = /requested (width|height|profile)/.exec(turn.error)[1];
      const name = { width: 'width', height: 'height', profile: 'recipe' }[field];
      const format = `${turn.context.width} × ${turn.context.height}`;
      return `Refinement refused: Hermes proposed changing the chosen ${name} (${format}). AgentX kept your settings and your brief.`;
    }
    return turn.error || labels[turn.state];
  }
  function turnNotice(turn) {
    if (!turn) return '';
    if (uncertainInspection(turn)) return 'Reference inspection outcome is unknown. The original request is kept; no replacement inspection or image was started. Check its recorded receipt.';
    if (terminal(turn)) return `${errorText(turn)} No image was started by this consultation.`;
    if (turn.proposal) return 'Proposal ready to review next to the brief. Apply prepares the text; Create starts the render.';
    if (turn.state === 'completed') return 'The imageX advice is available in the discussion.';
    return turn.inspection && ['prepared', 'running'].includes(turn.inspection.state)
      ? 'Request kept in AgentX. The selected references are being inspected before Hermes advice.'
      : 'Request kept in AgentX. Hermes is working on the text; selected pixels were not inspected.';
  }
  function inputError(context, message) {
    const limit = constraints?.MAX_BRIEF || 32000;
    if (context.prompt.length > limit) return 'The brief exceeds 32,000 characters. Shorten it before consulting Hermes; your text is kept.';
    if (message.length > limit) return 'The message exceeds 32,000 characters. Shorten it before sending; your text is kept.';
    try { constraints?.composeBrief(context.prompt, context.constraints); }
    catch (error) { return error.message; }
    if (context.constraintsInvalid) return 'Fix the brief constraints before consulting Hermes.';
    if (context.textPolicyError) return context.textPolicyError;
    return '';
  }
  async function api(route, body) {
    const response = await fetch(`/api/images/expert${route}`, { method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok || !value.ok) throw new Error(value.message || 'The specialist is unavailable.');
    return value;
  }
  function tab(name) {
    if (name === 'proposal') {
      if (proposalTurn) {
        $('imagex-proposal-panel').hidden = false; $('imagex-proposal-panel').open = true;
      }
      return;
    }
    for (const id of ['activity', 'files']) {
      const selected = id === name, button = $(`imagex-tab-${id}`);
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      $(`imagex-${id}`).hidden = !selected;
    }
  }
  function renderReceipt() {
    const turn = turns.find(row => row.id === selectedTurn) || turns.at(-1);
    $('imagex-events').replaceChildren(); $('imagex-envelope').textContent = turn ? JSON.stringify(turn.envelope, null, 2) : '';
    if (!turn) { $('imagex-receipt').textContent = 'No recorded consultation.'; if ($('imagex-inspection-receipt')) $('imagex-inspection-receipt').textContent = ''; return; }
    for (const event of turn.events || []) {
      const time = new Date(event.at).toLocaleTimeString('en-US');
      const action = event.type === 'accepted' ? 'AgentX recorded the request'
        : event.type === 'started' ? `Hermes started · declared model: ${event.reportedModel || 'not specified'}`
          : event.type === 'tool_use' ? `Tool called · ${event.name}`
            : `Tool finished · ${event.name}${event.durationMs != null ? ` · ${event.durationMs} ms` : ''}${event.failed ? ' · error' : ''}`;
      $('imagex-events').append(node('li', `${time} · ${action}`));
    }
    $('imagex-events').append(node('li', labels[turn.state] || turn.state));
    $('imagex-receipt').textContent = [turn.durationMs != null ? `${Math.round(turn.durationMs / 1000)} s` : '',
      turn.tokens?.total != null ? `${turn.tokens.total} tokens` : '', turn.reportedModel ? `Declared model: ${turn.reportedModel}` : '',
      turn.error ? errorText(turn) : '', 'The model declared at start does not confirm a possible local fallback.'].filter(Boolean).join(' · ');
    const inspection = turn.inspection, receipt = $('imagex-inspection-receipt');
    if (receipt) {
      const states = { 'not-requested': 'Text-only advice: selected pixels were not inspected.', prepared: 'Selected references verified; inspection not yet completed.',
        running: 'Reference inspection in progress.', completed: 'Reference inspection completed through Main; Hermes receives its advisory analysis.',
        unknown: 'Reference inspection outcome unknown. No replacement was launched.', failed: 'Reference inspection failed. No successful visual advice is claimed.',
        cancelled: 'Reference inspection cancellation requested. Native termination and release require their own receipt.' };
      const selected = (inspection?.references || []).map(value => `Image ${value.position + 1} · ${value.kind} · SHA-256 ${value.sha256}`);
      const native = inspection?.nativeReceipt;
      receipt.textContent = [states[inspection?.state || 'not-requested'] || 'Reference inspection state unavailable.', ...selected,
        inspection?.requestId ? `Inspection request: ${inspection.requestId}` : '', native?.runId ? `Native run: ${native.runId}` : '', inspection?.error || ''].filter(Boolean).join(' · ');
    }
  }
  function showProposal(turn) {
    proposalTurn = turn; $('imagex-proposal-empty').hidden = !!turn; $('imagex-proposal-content').hidden = !turn;
    $('imagex-proposal-panel').hidden = !turn;
    if (turn) $('imagex-proposal-panel').open = true;
    if (turn) {
      $('imagex-proposal-prompt').value = turn.proposal.visualPrompt ?? turn.proposal.prompt;
      $('imagex-proposal-original').textContent = turn.context.prompt;
      $('imagex-proposal-constraints').textContent = constraints?.block(turn.proposal.constraints) || '';
      $('imagex-proposal-constraints').hidden = !turn.proposal.constraints;
      $('imagex-proposal-reason').textContent = turn.proposal.reason || '';
      $('imagex-proposal-settings').textContent = `${turn.proposal.profile} · ${turn.proposal.width} × ${turn.proposal.height} · ${turn.context.referenceCount} reference(s)`;
      const target = $('imagex-proposal-text-plan'), plan = turn.proposal.textPlan;
      target.hidden = !plan; target.replaceChildren();
      if (plan) {
        target.append(node('strong', plan.strategy === 'two-pass' ? 'Two passes: image, then text layers' : 'One pass: text drawn by the model'), node('p', plan.reason));
        const list = node('ul');
        for (const label of plan.labels) list.append(node('li', `${label.text}${label.placement ? ' · ' + label.placement : ''}`));
        target.append(list, node('p', 'Apply copies these labels into "Text in the image". Check and adjust the placements on the result.', 'image-help'));
      }
    }
    refresh();
  }
  function renderTurns() {
    const previous = $('imagex-messages').scrollTop, nearBottom = $('imagex-messages').scrollHeight - previous - $('imagex-messages').clientHeight < 60;
    $('imagex-messages').replaceChildren();
    if (!turns.length) $('imagex-messages').append(node('p', 'Ask a question about the style, the recipes or your edit. Prepare your image in the Workshop brief.', 'imagex-welcome'));
    for (const turn of turns) {
      const user = node('article', undefined, 'imagex-message imagex-message-user'); user.append(node('header', 'You'), node('p', turn.input));
      const answer = node('article', undefined, 'imagex-message'); answer.append(node('header', `imageX · ${labels[turn.state] || turn.state}`),
        node('p', terminal(turn) ? errorText(turn) : turn.text || (active()?.id === turn.id ? 'Preparing my answer…' : '')));
      if (turn.proposal) { const button = node('button', 'Review this proposal next to the brief'); button.type = 'button'; button.addEventListener('click', () => { showProposal(turn); tab('proposal'); $('imagex-proposal-prompt').focus(); }); answer.append(button); }
      $('imagex-messages').append(user, answer);
    }
    if (nearBottom || pending) $('imagex-messages').scrollTop = $('imagex-messages').scrollHeight;
    $('imagex-inspect-turn').replaceChildren(...turns.map((turn, index) => {
      const option = node('option', `${index + 1} · ${labels[turn.state]} · ${turn.input.slice(0, 50)}`); option.value = turn.id; return option;
    }));
    if (!turns.some(row => row.id === selectedTurn)) selectedTurn = turns.at(-1)?.id || '';
    $('imagex-inspect-turn').value = selectedTurn;
    const latestProposal = [...turns].reverse().find(turn => turn.proposal);
    if (latestProposal && (!proposalTurn || latestProposal.id !== proposalTurn.id && !turns.some(row => row.id === proposalTurn.id))) showProposal(latestProposal);
    else if (latestProposal && proposalTurn?.state !== 'completed') showProposal(latestProposal);
    renderReceipt(); refresh();
  }
  async function loadTurns() {
    if (!sessionId) return;
    const requested = sessionId;
    try {
      const result = await api(`/sessions/${requested}/turns`);
      if (sessionId !== requested) return;
      const previousIds = new Set(turns.filter(row => row.proposal).map(row => row.id));
      turns = result.turns;
      const newProposal = turns.find(row => row.proposal && !previousIds.has(row.id));
      if (newProposal) { showProposal(newProposal); tab('proposal'); }
      const last = turns.at(-1);
      if (last) $('imagex-notice').textContent = turnNotice(last);
      if (last?.mode === 'plan' && terminal(last)) {
        if (!proposalTurn) $('imagex-proposal-panel').hidden = true;
        $('imagex-proposal-empty').textContent = 'The refinement produced no proposal. Your brief is kept; you can try again.';
      }
      renderTurns();
      clearTimeout(timer);
      if (active()) timer = setTimeout(() => { void loadTurns(); }, 1500);
    } catch (error) {
      $('imagex-notice').textContent = `${error.message} The recorded request will be checked on reconnection.`;
      clearTimeout(timer); if (active()) timer = setTimeout(() => { void loadTurns(); }, 4000);
    }
  }
  async function loadSessions() {
    const result = await api('/sessions'), select = $('imagex-session');
    select.replaceChildren(node('option', 'New discussion')); select.options[0].value = '';
    for (const session of result.sessions) {
      const date = new Date(session.lastTurnAt || session.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const option = node('option', `${session.label} · ${date}`); option.value = session.sessionId; select.append(option);
    }
    if (!sessionId) { try { sessionId = new URLSearchParams(location.search).get('expertSession') || localStorage.getItem('agentx-imagex-session') || ''; } catch {} }
    if (!result.sessions.some(row => row.sessionId === sessionId)) sessionId = '';
    select.value = sessionId; if (sessionId) await loadTurns();
  }
  async function send(mode, message, inspectReferences = false) {
    if (busy() || !metadata?.available) return;
    if (inspectReferences && unresolvedInspection()) {
      $('imagex-notice').textContent = inspectionWarning(unresolvedInspection()); refresh(); return;
    }
    const current = getContext(), error = inputError(current, message), baseline = signature();
    if (error) { $('imagex-notice').textContent = error; return; }
    if (!current.ready || mode === 'plan' && !current.prompt.trim()) { $('imagex-notice').textContent = 'Write your brief and choose a recipe before asking for a proposal.'; return; }
    if (inspectReferences && metadata.referenceInspection?.available === false) {
      $('imagex-notice').textContent = 'The installed specialist needs its reference-inspection update. Your draft is kept; text-only advice remains available.'; return;
    }
    if (inspectReferences && (!prepareReferences || current.referenceCount < 1 || current.referenceCount > 2 || current.locked)) {
      $('imagex-notice').textContent = 'Choose one or two references and finish the current render before inspecting them.'; return;
    }
    pending = true; refresh(); $('imagex-notice').textContent = 'Sending to Hermes…';
    if (mode === 'plan') {
      $('imagex-proposal-panel').hidden = false; $('imagex-proposal-panel').open = true;
      $('imagex-proposal-empty').textContent = 'Hermes is preparing a proposal. Your brief stays in place; no image is started.';
    }
    try {
      if (!sessionId) { sessionId = (await api('/sessions', {})).session.sessionId;
        try { localStorage.setItem('agentx-imagex-session', sessionId); } catch {} }
      let selected;
      if (inspectReferences) {
        if (baseline !== signature()) throw new Error('The brief, settings or references changed while the consultation was being prepared. Check them and send again; your draft is kept.');
        $('imagex-notice').textContent = 'Verifying the selected references…';
        selected = await prepareReferences(sessionId);
        if (baseline !== signature()) throw new Error('The brief, settings or references changed while the consultation was being prepared. Check them and send again; your draft is kept.');
      }
      const context = { prompt: current.prompt, profile: current.profile, width: current.width, height: current.height, referenceCount: current.referenceCount,
        ...(inspectReferences && { inspectReferences: true, references: selected }),
        ...(current.constraints && { constraints: current.constraints }), ...(current.textPolicy && { textPolicy: current.textPolicy }) };
      const payload = { mode, message, context }, key = JSON.stringify({ sessionId, ...payload });
      if (!retry || retry.key !== key) retry = { key, body: { ...payload, clientTurnId: crypto.randomUUID() } };
      baselines.set(retry.body.clientTurnId, baseline);
      const result = await api(`/sessions/${sessionId}/turns`, retry.body);
      retry = null; selectedTurn = result.turn.id;
      if (!turns.some(row => row.id === result.turn.id)) turns.push(result.turn);
      if (mode === 'consult' && $('imagex-message').value === message) $('imagex-message').value = '';
      $('imagex-notice').textContent = turnNotice(result.turn);
      renderTurns(); tab(result.turn.proposal ? 'proposal' : 'activity'); await loadSessions(); await loadTurns();
    } catch (error) { $('imagex-notice').textContent = error.message; }
    finally { pending = false; refresh(); }
  }
  function refresh() {
    const context = getContext(), working = busy(), message = $('imagex-message').value;
    const instruction = $('imagex-plan-instruction').value;
    const error = inputError(context, instruction), chatError = inputError(context, message);
    const ready = !!metadata?.available && context.ready;
    const counter = $('imagex-message-counter');
    if (counter) { counter.textContent = `Message: ${new Intl.NumberFormat('en-US').format(message.length)} / 32,000 characters.${message.length > 32000 ? ' Shorten it before sending; all pasted text is kept.' : ''}`; counter.dataset.invalid = String(message.length > 32000); }
    $('imagex-instruction-counter').textContent = `Instruction: ${new Intl.NumberFormat('en-US').format(instruction.length)} / 32,000 characters.${instruction.length > 32000 ? ' Shorten it before refining; all text is kept.' : ''}`;
    let needsCondensing = false;
    try { textPolicy.compose(context.prompt, context.constraints, context.textPolicy); needsCondensing = context.prompt.length > (constraints?.MAX_PROMPT || 8000) && !error; } catch { needsCondensing = !error; }
    if ($('imagex-planning-help')) $('imagex-planning-help').textContent = error || (!metadata?.available
      ? metadata ? 'Hermes is unavailable. Your brief is kept; shorten it manually to 8,000 characters, constraints included, to create.' : 'Connecting to Hermes…'
      : needsCondensing ? 'Your long brief is kept. "Refine my brief" can prepare a version of at most 8,000 characters, constraints included.'
        : 'Your brief can be created directly. Refine proposes another version to review; no conversation is needed.');
    if (!error && !metadata?.available && !needsCondensing) $('imagex-planning-help').textContent = 'Hermes is unavailable for advice. If your brief is ready, you can create directly.';
    if (!context.prompt.trim() && !error) $('imagex-planning-help').textContent = 'Start by describing your image in the brief. You can then refine it if needed.';
    if (context.ready && context.prompt.trim()) $('imagex-planning-help').textContent = `Chosen format: ${context.width} × ${context.height}. ${$('imagex-planning-help').textContent}`;
    $('imagex-chat-notice').textContent = $('imagex-notice').textContent;
    const last = turns.at(-1), unresolved = unresolvedInspection();
    const canRetry = terminal(last) && !uncertainInspection(last) && last.mode === 'plan'
      && !(last.context?.inspectReferences && unresolved);
    $('imagex-recovery').hidden = !canRetry;
    $('imagex-retry').disabled = !canRetry || working || !ready || !!error || !context.prompt.trim();
    const canRestore = canRetry && !context.prompt.trim() && !!last.context?.prompt && !!restoreBrief;
    $('imagex-restore-brief').hidden = !canRestore;
    $('imagex-restore-brief').disabled = working || context.locked;
    // Rendering has its own validation and admission; this link only opens its review.
    let canCreate = !!context.prompt.trim() && context.prompt.length <= 8000 && !context.constraintsInvalid;
    try { canCreate = canCreate && textPolicy.compose(context.prompt, context.constraints, context.textPolicy).length <= 8000; } catch { canCreate = false; }
    $('imagex-use-brief').hidden = !canCreate;
    $('imagex-recovery-help').textContent = canRestore
      ? 'Recover the saved brief and its constraints, then check the recipe, the format and the references before trying again.'
      : context.prompt !== last?.context?.prompt
      ? 'The brief changed since this request. Retrying will use the current text and settings.'
      : canCreate ? 'You can ask for a new refinement, or check your current brief and create directly.'
        : 'Your long brief is kept. Retry the refinement to prepare a version of at most 8,000 characters, constraints included.';
    $('imagex-send').disabled = working || !ready || !!chatError; $('imagex-plan').disabled = working || !ready || !!error || !context.prompt.trim();
    if ($('imagex-inspect-references')) $('imagex-inspect-references').disabled = working || !ready || !!error || !context.prompt.trim()
      || context.locked || context.referenceCount < 1 || context.referenceCount > 2 || !prepareReferences || !!unresolved
      || metadata?.referenceInspection?.available === false;
    if ($('imagex-inspection-help')) $('imagex-inspection-help').textContent = unresolved
      ? inspectionWarning(unresolved)
      : metadata?.referenceInspection?.available === false ? 'The installed specialist needs its reference-inspection update. Text-only advice remains available and your draft is kept.'
      : context.referenceCount > 2 ? 'Choose at most two references for inspection.'
      : !context.referenceCount ? 'Attach one or two references to inspect them before refining the brief.'
      : 'Inspect exactly these selected images, then review Hermes’s proposal. Send and Refine remain text-only; Apply and Create are separate actions.';
    $('imagex-explore').disabled = working || !ready || !!inputError(context, ''); $('imagex-new').disabled = working; $('imagex-session').disabled = working;
    $('imagex-stop').hidden = !active(); $('imagex-stop').disabled = pending;
    $('imagex-tab-proposal').disabled = !proposalTurn;
    if (context.worker) $('imagex-renderer').textContent = `${context.worker.label || 'Local host'} · ${context.worker.gpu || 'Configured GPU'}${context.worker.vramGiB ? ` · ${context.worker.vramGiB} GB` : ''}. AgentX reserves the resources before the computation.`;
    const original = proposalTurn?.context;
    const changed = original && (context.prompt !== original.prompt || context.profile !== original.profile
      || context.width !== original.width || context.height !== original.height || context.referenceCount !== original.referenceCount
      || JSON.stringify(context.constraints) !== JSON.stringify(original.constraints)
      || JSON.stringify(context.textPolicy) !== JSON.stringify(original.textPolicy)
      || original.inspectReferences === true && (!matchReferences || !matchReferences(original.references))
      || baselines.has(proposalTurn.id) && baselines.get(proposalTurn.id) !== signature());
    let invalidProposal = context.constraintsInvalid || $('imagex-proposal-prompt').value.length > (constraints?.MAX_PROMPT || 8000);
    try {
      const proposed = $('imagex-proposal-prompt').value, measurement = textPolicy.inspect(proposed, proposalTurn?.proposal.constraints, proposalTurn?.proposal.textPolicy);
      const format = value => new Intl.NumberFormat('en-US').format(value);
      $('imagex-proposal-counter').textContent = `Proposed final render: ${format(measurement.renderUnits)} / 8,000 characters, including ${format(measurement.overheadUnits)} of instructions. Room for the description: ${format(measurement.maxVisualUnits)} characters.`;
      textPolicy.compose(proposed, proposalTurn?.proposal.constraints, proposalTurn?.proposal.textPolicy);
    } catch (error) { invalidProposal = true; $('imagex-proposal-counter').textContent = error.message; }
    $('imagex-apply').disabled = !proposalTurn || working || context.locked || changed || invalidProposal || !$('imagex-proposal-prompt').value.trim();
    $('imagex-apply-note').textContent = applied && applied.id === proposalTurn?.id && applied.signature === signature() ? 'Proposal applied. The brief is ready to be checked in the creation form.'
      : working ? 'Hermes is working. Wait for its answer before applying a proposal.'
      : context.locked ? 'Wait for the generation to finish before changing the brief.'
      : invalidProposal ? 'Fix the constraints or shorten the brief: the sent text is limited to 8,000 characters.'
      : changed ? 'The brief, the constraints, the settings or the references changed. Ask for a new proposal for this context.'
        : proposalTurn?.proposal.textPlan ? 'Apply copies the description, the exact text and the proposed method. Check the labels and their placements before creating.'
        : proposalTurn?.proposal.constraints ? 'Apply replaces the visual description. Your constraints are kept; whether the image respects them still needs to be checked.'
        : 'Apply replaces the brief text. The seed, the recipe and the references stay those of the form.';
  }
  $('imagex-tab-proposal').addEventListener('click', () => { tab('proposal'); if (proposalTurn) $('imagex-proposal-prompt').focus(); });
  for (const name of ['activity', 'files']) {
    $(`imagex-tab-${name}`).addEventListener('click', () => tab(name));
    $(`imagex-tab-${name}`).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); const next = name === 'activity' ? 'files' : 'activity';
      tab(next); $(`imagex-tab-${next}`).focus();
    });
  }
  $('imagex-chat-form').addEventListener('submit', event => { event.preventDefault(); const message = $('imagex-message').value; if (message.trim()) void send('consult', message); });
  $('imagex-plan').addEventListener('click', () => { const message = $('imagex-plan-instruction').value; void send('plan', message || 'Affine ce brief pour la recette et le format choisis. Préserve mon intention et explique tes changements.'); });
  $('imagex-inspect-references')?.addEventListener('click', () => {
    refresh(); if ($('imagex-inspect-references').disabled) return;
    void send('plan', $('imagex-plan-instruction').value || 'Inspecte les références sélectionnées et affine ce brief pour la recette et le format choisis. Préserve mon intention et distingue les observations de tes incertitudes.', true);
  });
  $('imagex-retry').addEventListener('click', () => {
    refresh(); if ($('imagex-retry').disabled) return;
    const message = $('imagex-plan-instruction').value || turns.at(-1)?.input || 'Affine ce brief en conservant la recette et le format choisis.';
    void send('plan', message, turns.at(-1)?.context?.inspectReferences === true);
  });
  $('imagex-restore-brief').addEventListener('click', () => {
    refresh(); if ($('imagex-restore-brief').hidden || $('imagex-restore-brief').disabled) return;
    try {
      restoreBrief(turns.at(-1).context);
      $('imagex-notice').textContent = 'Brief and constraints recovered. Check the recipe, the format and the references; no image is started.';
    } catch (error) { $('imagex-notice').textContent = error.message; }
    refresh();
  });
  $('imagex-explore').addEventListener('click', () => { void send('consult', 'Quelles possibilités concrètes avons-nous dans cet Atelier ? Propose trois expériences adaptées aux recettes disponibles et explique le rôle de Hermes, AgentX et ComfyUI.'); });
  $('imagex-apply').addEventListener('click', () => {
    refresh(); if ($('imagex-apply').disabled) return;
    const args = [$('imagex-proposal-prompt').value.trim(), { sessionId, turnId: proposalTurn.id }];
    if (proposalTurn.proposal.textPolicy) args.push(proposalTurn.proposal.textPolicy);
    apply(...args); applied = { id: proposalTurn.id, signature: signature() };
    $('imagex-notice').textContent = 'Proposal applied to the brief. Check the references, then start the creation.'; refresh();
    $('imagex-proposal-panel').open = false;
  });
  $('imagex-proposal-prompt').addEventListener('input', refresh);
  $('imagex-message').addEventListener('input', refresh);
  $('imagex-plan-instruction').addEventListener('input', refresh);
  $('imagex-inspect-turn').addEventListener('change', () => { selectedTurn = $('imagex-inspect-turn').value; renderReceipt(); });
  $('imagex-new').addEventListener('click', () => {
    if (busy()) return; sessionId = ''; turns = []; selectedTurn = ''; retry = null; clearTimeout(timer);
    try { localStorage.removeItem('agentx-imagex-session'); } catch {}
    $('imagex-session').value = ''; $('imagex-notice').textContent = ''; showProposal(null); renderTurns(); $('imagex-message').focus();
  });
  $('imagex-session').addEventListener('change', () => {
    if (busy()) return; sessionId = $('imagex-session').value; turns = []; selectedTurn = ''; retry = null;
    try { localStorage.setItem('agentx-imagex-session', sessionId); } catch {}
    $('imagex-notice').textContent = ''; showProposal(null); renderTurns(); void loadTurns();
  });
  $('imagex-stop').addEventListener('click', async () => {
    const turn = active(); if (!turn) return;
    try { await api(`/sessions/${sessionId}/turns/${turn.id}/cancel`, {}); $('imagex-notice').textContent = 'Consultation stop requested. This acknowledgment does not confirm native termination or release.'; await loadTurns(); }
    catch (error) { $('imagex-notice').textContent = error.message; }
  });
  $('imagex-resource').addEventListener('change', async () => {
    const id = $('imagex-resource').value, epoch = ++fileEpoch;
    $('imagex-file-content').textContent = ''; $('imagex-file-download').hidden = true;
    if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = null; }
    if (!id) { $('imagex-file-facts').textContent = ''; return; }
    $('imagex-file-facts').textContent = 'Reading the Hermes profile…';
    try {
      const { resource } = await api(`/resources/${encodeURIComponent(id)}`); if (epoch !== fileEpoch) return;
      if (!resource.available) throw new Error('This document is not present in the profile.');
      $('imagex-file-content').textContent = resource.content;
      $('imagex-file-facts').textContent = `${resource.path} · ${new Date(resource.updatedAt).toLocaleString('en-US')} · ${resource.bytes} bytes · SHA-256 ${resource.sha256.slice(0, 16)}…`;
      fileUrl = URL.createObjectURL(new Blob([resource.content], { type: 'text/plain;charset=utf-8' }));
      $('imagex-file-download').href = fileUrl; $('imagex-file-download').download = resource.path.split('/').at(-1); $('imagex-file-download').hidden = false;
    } catch (error) { if (epoch === fileEpoch) $('imagex-file-facts').textContent = error.message; }
  });
  const openAdvice = () => { $('imagex').open = true; };
  for (const link of document.querySelectorAll?.('[data-imagex-open]') || []) link.addEventListener('click', openAdvice);
  if (location.hash === '#imagex' || new URLSearchParams(location.search).has('expertSession')) openAdvice();
  globalThis.addEventListener?.('hashchange', () => { if (location.hash === '#imagex') openAdvice(); });
  (async () => {
    try {
      metadata = await api('/status'); $('imagex-connection').textContent = metadata.available ? 'Hermes connected · imageX specialist' : 'Hermes unavailable';
      if (metadata.dashboardUrl) { $('imagex-official-dashboard').href = metadata.dashboardUrl; $('imagex-official-dashboard').hidden = false; }
      const entries = [['Advice', metadata.routing?.model || 'Model not specified'], ['Route', metadata.routing?.provider || 'Not specified'],
        ['Pricing', metadata.routing?.freeOnly ? 'Free cloud models configured' : 'Per the configured provider'],
        ['Configured fallback', metadata.routing?.fallbackModels?.join(', ') || 'Not specified'], ['Vision', metadata.referenceInspection?.available === false
          ? 'Reference inspection unavailable in the installed specialist. Text-only advice remains available.'
          : 'Optional selected-reference inspection through Main; each consultation records its outcome.']];
      $('imagex-routing').replaceChildren(...entries.map(([label, value]) => { const row = node('div'); row.append(node('dt', label), node('dd', value)); return row; }));
      for (const file of metadata.resources || []) { const option = node('option', `${file.title}${file.available ? '' : ' · missing'}`); option.value = file.id; $('imagex-resource').append(option); }
      if (!metadata.available) $('imagex-notice').textContent = metadata.message || 'Hermes advice is unavailable. You can compose and generate directly.';
      await loadSessions();
    } catch (error) { metadata = { ...metadata, available: false }; $('imagex-connection').textContent = 'Hermes unavailable'; $('imagex-notice').textContent = error.message; }
    finally { refresh(); }
  })();
  return { refresh, planTexts() {
    $('imagex').open = true;
    if (!metadata?.available) { $('imagex-notice').textContent = 'Hermes is unavailable. You can choose one or two passes and enter the labels in the Workshop.'; refresh(); return; }
    void send('plan', 'Prépare les textes de cette image avec moi. Identifie les libellés principaux dans mon brief, conserve mes textes exacts et le mode choisi. Si le mode est automatique, recommande une ou deux passes selon la longueur, la densité et les placements ; explique les compromis. Prépare un textPlan et un brief de rendu de 8 000 caractères maximum.');
  } };
} };
