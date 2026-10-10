'use strict';
globalThis.AgentXImageExpert = { mount({ getContext, apply }) {
  const $ = id => document.getElementById(id);
  if (!$('imagex')) return { refresh() {} };
  const labels = { accepted: 'Enregistrée', running: 'Hermes travaille…', completed: 'Terminée', failed: 'Échec', interrupted: 'Interrompue', cancelled: 'Arrêtée' };
  let metadata, sessionId = '', turns = [], selectedTurn = '', proposalTurn = null, timer, pending = false, retry = null, fileEpoch = 0, fileUrl;
  const baselines = new Map();
  const constraints = globalThis.ImageBriefConstraints;
  let applied = null;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const active = () => turns.find(turn => ['accepted', 'running'].includes(turn.state));
  const busy = () => pending || !!active();
  const signature = () => JSON.stringify(getContext());
  function inputError(context, message) {
    const limit = constraints?.MAX_BRIEF || 32000;
    if (context.prompt.length > limit) return 'Le brief dépasse 32 000 caractères. Réduis-le avant de consulter Hermes ; ton texte reste conservé.';
    if (message.length > limit) return 'Le message dépasse 32 000 caractères. Réduis-le avant l’envoi ; ton texte reste conservé.';
    try { constraints?.composeBrief(context.prompt, context.constraints); }
    catch (error) { return error.message; }
    if (context.constraintsInvalid) return 'Corrige les contraintes du brief avant de consulter Hermes.';
    return '';
  }
  async function api(route, body) {
    const response = await fetch(`/api/images/expert${route}`, { method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok || !value.ok) throw new Error(value.message || 'Le spécialiste est indisponible.');
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
    if (!turn) { $('imagex-receipt').textContent = 'Aucune consultation enregistrée.'; return; }
    for (const event of turn.events || []) {
      const time = new Date(event.at).toLocaleTimeString('fr-CA');
      const action = event.type === 'accepted' ? 'AgentX a enregistré la demande'
        : event.type === 'started' ? `Hermes démarré · modèle déclaré : ${event.reportedModel || 'non renseigné'}`
          : event.type === 'tool_use' ? `Outil appelé · ${event.name}`
            : `Outil terminé · ${event.name}${event.durationMs != null ? ` · ${event.durationMs} ms` : ''}${event.failed ? ' · erreur' : ''}`;
      $('imagex-events').append(node('li', `${time} · ${action}`));
    }
    $('imagex-events').append(node('li', labels[turn.state] || turn.state));
    $('imagex-receipt').textContent = [turn.durationMs != null ? `${Math.round(turn.durationMs / 1000)} s` : '',
      turn.tokens?.total != null ? `${turn.tokens.total} tokens` : '', turn.reportedModel ? `Modèle déclaré : ${turn.reportedModel}` : '',
      turn.error || '', 'Le modèle déclaré au démarrage ne confirme pas un éventuel repli local.'].filter(Boolean).join(' · ');
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
      $('imagex-proposal-settings').textContent = `${turn.proposal.profile} · ${turn.proposal.width} × ${turn.proposal.height} · ${turn.context.referenceCount} référence(s)`;
    }
    refresh();
  }
  function renderTurns() {
    const previous = $('imagex-messages').scrollTop, nearBottom = $('imagex-messages').scrollHeight - previous - $('imagex-messages').clientHeight < 60;
    $('imagex-messages').replaceChildren();
    if (!turns.length) $('imagex-messages').append(node('p', 'Pose une question sur le style, les recettes ou ta retouche. Prépare ton image dans le brief de l’Atelier.', 'imagex-welcome'));
    for (const turn of turns) {
      const user = node('article', undefined, 'imagex-message imagex-message-user'); user.append(node('header', 'Toi'), node('p', turn.input));
      const answer = node('article', undefined, 'imagex-message'); answer.append(node('header', `imageX · ${labels[turn.state] || turn.state}`),
        node('p', turn.text || turn.error || (active()?.id === turn.id ? 'Je prépare ma réponse…' : '')));
      if (turn.proposal) { const button = node('button', 'Vérifier cette proposition près du brief'); button.type = 'button'; button.addEventListener('click', () => { showProposal(turn); tab('proposal'); $('imagex-proposal-prompt').focus(); }); answer.append(button); }
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
      if (newProposal) { showProposal(newProposal); tab('proposal'); $('imagex-notice').textContent = 'Proposition prête à vérifier près du brief. Appliquer prépare le texte ; Créer lance le rendu.'; }
      const last = turns.at(-1);
      if (last && ['failed', 'interrupted', 'cancelled'].includes(last.state)) $('imagex-notice').textContent = `${last.error || labels[last.state]} Ton brief est conservé.`;
      else if (last?.state === 'completed' && !last.proposal) $('imagex-notice').textContent = 'Le conseil imageX est disponible dans la discussion.';
      renderTurns();
      clearTimeout(timer);
      if (active()) timer = setTimeout(() => { void loadTurns(); }, 1500);
    } catch (error) {
      $('imagex-notice').textContent = `${error.message} La demande enregistrée sera vérifiée à la reconnexion.`;
      clearTimeout(timer); if (active()) timer = setTimeout(() => { void loadTurns(); }, 4000);
    }
  }
  async function loadSessions() {
    const result = await api('/sessions'), select = $('imagex-session');
    select.replaceChildren(node('option', 'Nouvelle discussion')); select.options[0].value = '';
    for (const session of result.sessions) {
      const date = new Date(session.lastTurnAt || session.createdAt).toLocaleString('fr-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const option = node('option', `${session.label} · ${date}`); option.value = session.sessionId; select.append(option);
    }
    if (!sessionId) { try { sessionId = new URLSearchParams(location.search).get('expertSession') || localStorage.getItem('agentx-imagex-session') || ''; } catch {} }
    if (!result.sessions.some(row => row.sessionId === sessionId)) sessionId = '';
    select.value = sessionId; if (sessionId) await loadTurns();
  }
  async function send(mode, message) {
    if (busy() || !metadata?.available) return;
    const current = getContext(), error = inputError(current, message), baseline = signature();
    if (error) { $('imagex-notice').textContent = error; return; }
    if (!current.ready || mode === 'plan' && !current.prompt.trim()) { $('imagex-notice').textContent = 'Écris ton brief et choisis une recette avant de demander une proposition.'; return; }
    pending = true; refresh(); $('imagex-notice').textContent = 'Transmission à Hermes…';
    if (mode === 'plan') {
      $('imagex-proposal-panel').hidden = false; $('imagex-proposal-panel').open = true;
      $('imagex-proposal-empty').textContent = 'Hermes prépare une proposition. Ton brief reste en place ; aucune image n’est lancée.';
    }
    try {
      if (!sessionId) { sessionId = (await api('/sessions', {})).session.sessionId;
        try { localStorage.setItem('agentx-imagex-session', sessionId); } catch {} }
      const context = { prompt: current.prompt, profile: current.profile, width: current.width, height: current.height, referenceCount: current.referenceCount,
        ...(current.constraints && { constraints: current.constraints }) };
      const payload = { mode, message, context }, key = JSON.stringify({ sessionId, ...payload });
      if (!retry || retry.key !== key) retry = { key, body: { ...payload, clientTurnId: crypto.randomUUID() } };
      baselines.set(retry.body.clientTurnId, baseline);
      const result = await api(`/sessions/${sessionId}/turns`, retry.body);
      retry = null; selectedTurn = result.turn.id;
      if (!turns.some(row => row.id === result.turn.id)) turns.push(result.turn);
      if (mode === 'consult' && $('imagex-message').value === message) $('imagex-message').value = '';
      $('imagex-notice').textContent = 'Demande conservée dans AgentX. Hermes travaille sur le texte.';
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
    if (counter) { counter.textContent = `Message : ${new Intl.NumberFormat('fr-CA').format(message.length)} / 32 000 caractères.${message.length > 32000 ? ' Réduis-le avant l’envoi ; tout le texte collé reste conservé.' : ''}`; counter.dataset.invalid = String(message.length > 32000); }
    $('imagex-instruction-counter').textContent = `Consigne : ${new Intl.NumberFormat('fr-CA').format(instruction.length)} / 32 000 caractères.${instruction.length > 32000 ? ' Réduis-la avant l’affinage ; tout le texte reste conservé.' : ''}`;
    let needsCondensing = false;
    try { constraints?.compose(context.prompt, context.constraints); needsCondensing = context.prompt.length > (constraints?.MAX_PROMPT || 8000) && !error; } catch { needsCondensing = !error; }
    if ($('imagex-planning-help')) $('imagex-planning-help').textContent = error || (!metadata?.available
      ? metadata ? 'Hermes est indisponible. Ton brief reste conservé ; réduis-le manuellement à 8 000 caractères, contraintes comprises, pour créer.' : 'Connexion à Hermes…'
      : needsCondensing ? 'Ton brief long reste conservé. « Affiner mon brief » peut préparer une version de 8 000 caractères maximum, contraintes comprises.'
        : 'Ton brief peut être créé directement. Affiner propose une autre version à vérifier ; aucune conversation n’est nécessaire.');
    if (!error && !metadata?.available && !needsCondensing) $('imagex-planning-help').textContent = 'Hermes est indisponible pour les conseils. Si ton brief est prêt, tu peux créer directement.';
    if (!context.prompt.trim() && !error) $('imagex-planning-help').textContent = 'Commence par décrire ton image dans le brief. Tu pourras ensuite l’affiner si nécessaire.';
    $('imagex-chat-notice').textContent = $('imagex-notice').textContent;
    $('imagex-send').disabled = working || !ready || !!chatError; $('imagex-plan').disabled = working || !ready || !!error || !context.prompt.trim();
    $('imagex-explore').disabled = working || !ready || !!inputError(context, ''); $('imagex-new').disabled = working; $('imagex-session').disabled = working;
    $('imagex-stop').hidden = !active(); $('imagex-stop').disabled = pending;
    $('imagex-tab-proposal').disabled = !proposalTurn;
    if (context.worker) $('imagex-renderer').textContent = `${context.worker.label || 'Hôte local'} · ${context.worker.gpu || 'GPU configuré'}${context.worker.vramGiB ? ` · ${context.worker.vramGiB} Go` : ''}. AgentX réserve les ressources avant le calcul.`;
    const original = proposalTurn?.context;
    const changed = original && (context.prompt !== original.prompt || context.profile !== original.profile
      || context.width !== original.width || context.height !== original.height || context.referenceCount !== original.referenceCount
      || JSON.stringify(context.constraints) !== JSON.stringify(original.constraints)
      || baselines.has(proposalTurn.id) && baselines.get(proposalTurn.id) !== signature());
    let invalidProposal = context.constraintsInvalid || $('imagex-proposal-prompt').value.length > (constraints?.MAX_PROMPT || 8000);
    try {
      const proposed = $('imagex-proposal-prompt').value, composed = constraints?.compose(proposed, proposalTurn?.proposal.constraints) || proposed;
      $('imagex-proposal-counter').textContent = `Proposition avec contraintes : ${new Intl.NumberFormat('fr-CA').format(composed.length)} / 8 000 caractères.`;
    } catch (error) { invalidProposal = true; $('imagex-proposal-counter').textContent = error.message; }
    $('imagex-apply').disabled = !proposalTurn || working || context.locked || changed || invalidProposal || !$('imagex-proposal-prompt').value.trim();
    $('imagex-apply-note').textContent = applied && applied.id === proposalTurn?.id && applied.signature === signature() ? 'Proposition appliquée. Le brief est prêt à être vérifié dans le formulaire de création.'
      : working ? 'Hermes travaille. Attends sa réponse avant d’appliquer une proposition.'
      : context.locked ? 'Attends la fin de la génération pour modifier le brief.'
      : invalidProposal ? 'Corrige les contraintes ou réduis le brief : le texte transmis est limité à 8 000 caractères.'
      : changed ? 'Le brief, les contraintes, les réglages ou les références ont changé. Demande une nouvelle proposition pour ce contexte.'
        : proposalTurn?.proposal.constraints ? 'Appliquer remplace la description visuelle. Tes contraintes sont reprises mot pour mot dans le brief transmis ; leur respect dans l’image reste à vérifier.'
        : 'Appliquer remplace le texte du brief. La graine, la recette et les références restent celles du formulaire.';
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
  $('imagex-explore').addEventListener('click', () => { void send('consult', 'Quelles possibilités concrètes avons-nous dans cet Atelier ? Propose trois expériences adaptées aux recettes disponibles et explique le rôle de Hermes, AgentX et ComfyUI.'); });
  $('imagex-apply').addEventListener('click', () => {
    refresh(); if ($('imagex-apply').disabled) return;
    apply($('imagex-proposal-prompt').value.trim(), { sessionId, turnId: proposalTurn.id }); applied = { id: proposalTurn.id, signature: signature() };
    $('imagex-notice').textContent = 'Proposition appliquée au brief. Vérifie les références puis lance la création.'; refresh();
    $('imagex-proposal-panel').open = false;
  });
  $('imagex-proposal-prompt').addEventListener('input', refresh);
  $('imagex-message').addEventListener('input', refresh);
  $('imagex-plan-instruction').addEventListener('input', refresh);
  $('imagex-inspect-turn').addEventListener('change', () => { selectedTurn = $('imagex-inspect-turn').value; renderReceipt(); });
  $('imagex-new').addEventListener('click', () => {
    if (busy()) return; sessionId = ''; turns = []; selectedTurn = ''; retry = null; clearTimeout(timer);
    try { localStorage.removeItem('agentx-imagex-session'); } catch {}
    $('imagex-session').value = ''; showProposal(null); renderTurns(); $('imagex-message').focus();
  });
  $('imagex-session').addEventListener('change', () => {
    if (busy()) return; sessionId = $('imagex-session').value; turns = []; selectedTurn = ''; retry = null;
    try { localStorage.setItem('agentx-imagex-session', sessionId); } catch {}
    showProposal(null); renderTurns(); void loadTurns();
  });
  $('imagex-stop').addEventListener('click', async () => {
    const turn = active(); if (!turn) return;
    try { await api(`/sessions/${sessionId}/turns/${turn.id}/cancel`, {}); $('imagex-notice').textContent = 'Arrêt demandé à Hermes.'; await loadTurns(); }
    catch (error) { $('imagex-notice').textContent = error.message; }
  });
  $('imagex-resource').addEventListener('change', async () => {
    const id = $('imagex-resource').value, epoch = ++fileEpoch;
    $('imagex-file-content').textContent = ''; $('imagex-file-download').hidden = true;
    if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = null; }
    if (!id) { $('imagex-file-facts').textContent = ''; return; }
    $('imagex-file-facts').textContent = 'Lecture du profil Hermes…';
    try {
      const { resource } = await api(`/resources/${encodeURIComponent(id)}`); if (epoch !== fileEpoch) return;
      if (!resource.available) throw new Error('Ce document n’est pas présent dans le profil.');
      $('imagex-file-content').textContent = resource.content;
      $('imagex-file-facts').textContent = `${resource.path} · ${new Date(resource.updatedAt).toLocaleString('fr-CA')} · ${resource.bytes} octets · SHA-256 ${resource.sha256.slice(0, 16)}…`;
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
      metadata = await api('/status'); $('imagex-connection').textContent = metadata.available ? 'Hermes connecté · spécialiste imageX' : 'Hermes indisponible';
      if (metadata.dashboardUrl) { $('imagex-official-dashboard').href = metadata.dashboardUrl; $('imagex-official-dashboard').hidden = false; }
      const entries = [['Conseil', metadata.routing?.model || 'Modèle non renseigné'], ['Route', metadata.routing?.provider || 'Non renseignée'],
        ['Tarification', metadata.routing?.freeOnly ? 'Modèles cloud gratuits configurés' : 'Selon le fournisseur configuré'],
        ['Repli configuré', metadata.routing?.fallbackModels?.join(', ') || 'Non renseigné'], ['Vision', 'Conseil textuel · références rendues localement']];
      $('imagex-routing').replaceChildren(...entries.map(([label, value]) => { const row = node('div'); row.append(node('dt', label), node('dd', value)); return row; }));
      for (const file of metadata.resources || []) { const option = node('option', `${file.title}${file.available ? '' : ' · absent'}`); option.value = file.id; $('imagex-resource').append(option); }
      if (!metadata.available) $('imagex-notice').textContent = metadata.message || 'Le conseil Hermes est indisponible. Tu peux composer et générer directement.';
      await loadSessions();
    } catch (error) { metadata = { ...metadata, available: false }; $('imagex-connection').textContent = 'Hermes indisponible'; $('imagex-notice').textContent = error.message; }
    finally { refresh(); }
  })();
  return { refresh };
} };
