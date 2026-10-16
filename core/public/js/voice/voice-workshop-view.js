/* Voice workshop presentation. Indicators describe observed activity, never acoustic success. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXVoiceWorkshopView = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const names = { personal: 'Nestor personnel', family: 'Famille', reading: 'Lecture / Kids', psyx: 'PsyX' };
  const paths = { personal: '/dad', family: '/panel', reading: '/lecture', psyx: '/psyx' };
  const tabs = { microphone: 'Micro et STT', speech: 'Voix et TTS', conversation: 'Conversation', settings: 'Réglages' };
  const shapes = {
    microphone: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
    speech: '<path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    conversation: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z"/><path d="M7 10h10M7 14h6"/>',
    settings: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="8" cy="5" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="19" r="2"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    play: '<path d="m8 4 13 8-13 8V4Z"/>',
    compare: '<path d="M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4"/>',
    devices: '<rect x="4" y="2" width="16" height="20" rx="3"/><path d="M10 18h4"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
  };
  const icon = id => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[id] || shapes.microphone}</svg>`;
  function template(scope, embedded) {
    const section = (index, title, caption, symbol) => `<div class="vw-section-heading"><span class="vw-section-icon">${icon(symbol)}</span><div><p class="vw-eyebrow">${index}</p><h2>${title}</h2><p class="muted">${caption}</p></div></div>`;
    return `<section class="voice-workshop" lang="fr" aria-label="Atelier vocal">
      <header class="vw-heading">
        <div class="vw-identity"><span class="vw-brandmark">${icon('microphone')}</span><div><p class="vw-eyebrow">Atelier / Voix</p><h1>${embedded ? 'Diagnostic vocal' : 'Atelier vocal'}</h1><p class="vw-lede">Écouter. Comprendre. Ajuster.</p></div></div>
        <div class="vw-heading-actions"><span class="vw-live-badge" data-role="liveBadge">Micro éteint</span>${embedded ? '<button type="button" data-action="close" class="vw-close">Fermer</button>' : ''}</div>
      </header>
      <div class="vw-context">
        <label><span class="vw-eyebrow">Parcours</span><select data-field="scope" ${embedded ? 'disabled' : ''}>${Object.entries(names).map(([id, name]) => `<option value="${id}" ${id === scope ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
        <p class="vw-scope" data-role="owner"></p>
        <a href="${embedded ? '/voice-lab?scope=' + scope : paths[scope]}" data-role="return">${embedded ? 'L’atelier complet' : 'Ouvrir ' + names[scope]}${icon('arrow')}</a>
      </div>
      <section class="vw-studio" aria-label="Activité vocale">
        <div class="vw-monitor">
          <div class="vw-monitor-copy"><p class="vw-eyebrow">Le parcours en direct</p><h2 data-role="phase" role="status">Micro éteint</h2><p data-role="monitorHint">Activez l’écoute pour essayer votre prochaine phrase.</p></div>
          <div class="vw-signal" aria-hidden="true"><svg viewBox="0 0 560 96" preserveAspectRatio="none"><path d="M0 48H560" class="vw-signal-axis"/><g data-role="signalBars"></g></svg><span>Niveau du micro</span></div>
        </div>
        <div class="vw-transport"><div class="vw-actions"><button type="button" class="primary" data-action="start">${icon('microphone')}<span>${embedded ? 'Reprendre la conversation' : 'Activer l’écoute'}</span></button><button type="button" data-action="pause">${icon('pause')}<span>Pause</span></button></div><div class="vw-input"><span data-role="device">Micro de cet appareil</span><label class="sr-only" for="vw-level-${scope}">Niveau du microphone</label><progress id="vw-level-${scope}" data-role="level" max="1" value="0" aria-label="Niveau du microphone"></progress></div></div>
        <ol class="vw-route" aria-label="Étapes du parcours">${[['capture','microphone','Capture','microphone'],['recognition','microphone','Transcription','compare'],['response','conversation','Réponse','conversation'],['voice','speech','Voix','speech']].map(([id, tab, label, symbol], i) => `<li><button type="button" data-step="${id}" data-step-tab="${tab}"><span class="vw-step-number">0${i+1}</span><span class="vw-step-symbol">${icon(symbol)}</span><strong>${label}</strong><span class="vw-step-status">${id === 'response' && !embedded ? 'Hors de cet essai' : 'En attente'}</span></button></li>`).join('')}</ol>
        <div class="vw-stats" aria-label="Dernières mesures">${[['recognition','Temps STT','Après une phrase'],['queue','Attente STT','Dans le reçu du service'],['language','Langue d’essai','Choix explicite du parcours'],['voice','Voix reçue','Après une lecture']].map(([id,label,hint])=>`<div><span class="vw-eyebrow">${label}</span><strong data-stat="${id}">—</strong><small data-stat-note="${id}">${hint}</small></div>`).join('')}</div>
      </section>
      <nav class="vw-tabs" aria-label="Sections de l’atelier">${Object.entries(tabs).map(([id,label])=>`<button type="button" data-tab="${id}" aria-pressed="false">${icon(id)}<span>${label}</span></button>`).join('')}<a href="/voice-lab/devices">${icon('devices')}<span>Appareils</span></a></nav>
      <p class="vw-notice" data-role="notice" role="status" aria-live="polite"></p>
      <section data-panel="microphone"><div class="vw-grid">
        <div class="vw-card vw-transcription">${section('01 / LES MOTS','Votre voix, à l’écrit.','La transcription reçue, puis votre intention.','microphone')}
          <p class="vw-mode-note">${embedded ? 'Conversation courante : vos paroles utilisent son cerveau et ses outils.' : 'Essai STT : chaque phrase est transcrite jusqu’à Pause. Le cerveau et les outils restent hors de cet essai.'}</p>
          <div class="vw-transcript-shell"><span class="vw-eyebrow">Dernière transcription</span><p class="vw-transcript" data-role="transcript" role="status" aria-live="polite">Votre prochaine phrase apparaîtra ici.</p></div>
          <label>Ce que je voulais dire<textarea data-field="expected" rows="3" maxlength="5000" placeholder="Notez votre phrase pour comparer le sens…"></textarea></label><p class="vw-footnote">Brouillon dans cet onglet. Aucun réentraînement du moteur.</p>
        </div>
        <div class="vw-card">${section('02 / LE SON','Revenir à ce qui a été capté.','Réécouter, comparer, comprendre un raté.','speech')}
          <p class="vw-clip" data-role="clip">Aucun extrait disponible.</p>
          <div class="vw-actions vw-clip-select"><button type="button" data-action="review">Dernière parole</button><button type="button" data-action="recent">Micro récent</button></div>
          <div class="vw-actions vw-playback"><button type="button" class="vw-replay" data-action="replay">${icon('play')}<span>Réécouter</span></button><button type="button" class="vw-stop" data-action="stopReplay" disabled>${icon('stop')}<span>Arrêter la réécoute</span></button><button type="button" class="vw-quiet" data-action="erase">Effacer</button></div>
          <p class="vw-footnote" data-role="replayState" role="status" aria-live="polite"></p>
          <p class="vw-footnote">L’arrêt coupe uniquement la réécoute et conserve l’extrait. Pour reprendre le micro, utilisez le bouton de reprise de l’écoute. Extrait de 20 secondes maximum, effacé après 2 minutes, Pause ou sortie de page.</p>
          ${embedded ? '' : `<div class="vw-compare"><p class="vw-eyebrow">Même extrait / deux langues</p><label>Langue B<select data-field="compareLanguage"><option value="fr">Français</option><option value="en">English</option></select></label><button type="button" data-action="compare">${icon('compare')}<span>Comparer A / B</span></button><p class="vw-footnote">Deux transcriptions explicites de l’extrait brut encore disponible, avec les langues choisies.</p><div data-role="comparison" class="vw-comparison" aria-live="polite"></div></div>`}
          <details class="vw-inspector"><summary>Mesures et reçu STT</summary><dl data-role="metrics"></dl><p class="vw-footnote">Le replay précède le filtre d’écho ; les traitements du navigateur sont déjà appliqués.</p></details>
        </div>
      </div></section>
      <section data-panel="speech" hidden><div class="vw-grid vw-speech-grid">
        <div class="vw-card">${section('01 / LE TEXTE','Trouver la bonne voix.','Écoutez la diction, le rythme et les pauses.','speech')}
          <div class="vw-presets" aria-label="Textes d’essai"><button type="button" data-preset="natural">Phrase naturelle</button><button type="button" data-preset="numbers">Nombres et pauses</button><button type="button" data-preset="english">English</button></div>
          <div class="vw-form-pair"><label>Langue<select data-field="testLanguage"><option value="fr">Français québécois</option><option value="en">English</option></select></label><label>Voix pour cet essai<select data-field="testVoice"><option value="">Voix effective du parcours</option></select></label></div>
          <label>Texte à lire<textarea rows="5" maxlength="12000" data-field="speechText" lang="fr-CA">Bonjour ! Prenons le temps de vérifier les mots, les nombres et les pauses.</textarea></label><p class="vw-footnote">Texte d’essai : jusqu’à 12 000 caractères. Un brouillon par langue, conservé tant que l’atelier est ouvert.</p>
          <div class="vw-actions"><button type="button" class="vw-speak" data-action="speak" ${embedded ? 'disabled' : ''}>${icon('play')}<span>Lire le texte complet</span></button><button type="button" class="vw-stop" data-action="stopSpeech" disabled>${icon('stop')}<span>${embedded ? 'Couper la voix' : 'Arrêter la lecture'}</span></button></div>
          ${embedded ? '<p class="vw-mode-note">Ouvrez l’atelier complet pour un essai de synthèse avec le micro de conversation fermé.</p>' : ''}
        </div>
        <div class="vw-card vw-voice-result"><span class="vw-speaker-emblem">${icon('speech')}</span><p class="vw-eyebrow">Le retour du lecteur</p><h2 data-role="speechState">À vous d’écouter.</h2><p class="muted" data-role="speechDetail">La voix reçue et ses mesures apparaîtront ici.</p><details class="vw-inspector"><summary>Reçu et mesures de lecture</summary><dl data-role="speechReceipt"></dl><p class="vw-footnote">Une programmation audio ne prouve pas le premier son entendu. Voix demandée, voix reçue et secours restent distincts. PsyX anglais autorise uniquement une voix système déclarée locale.</p></details></div>
      </div></section>
      <section data-panel="conversation" hidden><div class="vw-card vw-conversation">${section('03 / LE PARCOURS','Suivre le fil de l’échange.','Les étapes attestées et les reçus au même endroit.','conversation')}
        <p class="vw-mode-note" data-role="flowState"></p><div data-role="flow"></div>
        ${embedded ? '' : `<div class="vw-conversation-entry"><span class="vw-speaker-emblem">${icon('conversation')}</span><h3>Une vraie conversation, dans son parcours.</h3><p>Ouvrez ${names[scope]}, puis son bouton Atelier vocal pour observer l’échange en cours.</p><a class="vw-link-button" href="${paths[scope]}">Ouvrir ${names[scope]}${icon('arrow')}</a></div>`}
        <details class="vw-inspector"><summary>Mesures du navigateur</summary><dl data-role="timings"></dl><p class="vw-footnote">La planification d’un signal ne prouve pas le premier son entendu.</p></details><p class="vw-footnote">Stop coupe la parole. Une tâche Main déjà lancée continue et conserve son résultat dans le même suivi.</p>
      </div></section>
      <section data-panel="settings" hidden><div class="vw-settings-intro"><p class="vw-eyebrow">À votre oreille</p><h2>Le bon réglage, au bon endroit.</h2><p class="muted">Vos choix sur cet appareil, les voix partagées et les informations du service.</p></div>
        <form data-role="settings"><div class="vw-grid"><fieldset class="vw-card"><legend>Sur ce navigateur</legend><label>Langue<select data-field="language"><option value="fr">Français québécois</option><option value="en">English</option></select></label><label>Voix préférée pour cette langue<select data-field="voice"><option value="">Voix du parcours</option></select></label><label data-role="wake" class="vw-check"><input type="checkbox" data-field="wakeWord"> Activation par Hey / Eille / Oh / Ah Nestor</label><label data-role="links" class="vw-check" hidden><input type="checkbox" data-field="linksClickable"> Clickable links in answers <span class="muted">(otherwise shown as text)</span></label><label data-role="interrupt" class="vw-check"><input type="checkbox" data-field="interruption"> Interrompre en parlant</label><div data-role="psyx" hidden><label class="vw-check"><input type="checkbox" data-field="spokenReplies"> Réponses parlées</label><label class="vw-check"><input type="checkbox" data-field="autoSend"> Envoyer après dictée</label></div><label>Micro de ce parcours<select data-field="inputDeviceId"><option value="">Micro système par défaut</option></select></label><button type="button" data-action="devices">Autoriser et lister les micros</button><div data-role="extraSettings"></div></fieldset>
          <fieldset class="vw-card"><legend>Capture de ce parcours</legend><p class="vw-footnote">Les essais utilisent ces valeurs provisoires. Enregistrer les applique aux prochaines ouvertures du micro de ce parcours sur cet appareil.</p>${[['threshold','Seuil de niveau RMS',.002,.15,.001],['minimumVoiceMs','Parole minimale (ms)',40,400,10],['endSilenceMs','Silence de fin de phrase (ms)',400,2000,100],['interruptionSilenceMs','Silence d’interruption (ms)',100,700,50]].map(([id,label,min,max,step])=>`<label>${label}<input type="number" data-capture="${id}" min="${min}" max="${max}" step="${step}" required></label>`).join('')}<button type="button" data-action="defaults">Valeurs de référence</button></fieldset></div><div class="vw-save"><button type="submit" class="primary">Enregistrer sur ce navigateur</button><p data-role="saved" role="status"></p></div></form>
        ${scope === 'personal' ? `<section class="vw-card vw-shared"><div class="vw-split-heading"><h2>La voix d’une personnalité</h2><span class="vw-scope-badge">Tous ses utilisateurs</span></div><p class="muted">Choix partagés dans Core, sauf préférence explicite du navigateur.</p><div class="vw-form-pair"><label>Personnalité<select data-field="sharedPersona"></select></label><label>Moteur<select data-field="sharedProvider"></select></label><label>Voix française<input type="text" data-field="sharedFr" maxlength="120"></label><label>Voix anglaise<input type="text" data-field="sharedEn" maxlength="120"></label></div><button type="button" data-action="sharedVoice">Enregistrer la voix de cette personnalité</button><p data-role="sharedStatus" role="status"></p></section>` : ''}
        <details class="vw-card vw-inspector vw-service"><summary>Service vocal <span class="vw-scope-badge">Lecture seule</span></summary><dl data-role="service"></dl><p class="vw-footnote">Les modèles et le VAD gardent leur propriétaire et leur procédure de livraison.</p></details>
      </section>
    </section>`;
  }
  function describe({ phase = 'idle', embedded = false, hasAudio = false, recognition = null, recognitionFailed = false, speech = 'idle' } = {}) {
    const speaking = ['preparing','scheduled'].includes(speech);
    const states = { starting:'Ouverture du micro',listening:'À l’écoute.',hearing:'Signal détecté.',transcribing:'Vos mots prennent forme.',reviewing:'Prenez le temps d’écouter.',error:'L’essai est interrompu.' };
    const speechLabels = { preparing:'Préparation de la lecture',scheduled:'Lecture programmée',done:'Lecture terminée',stopped:'Lecture interrompue',error:'Lecture indisponible' };
    const received = Boolean(recognition?.text || recognition?.control);
    return {
      title: speaking || !hasAudio && speech !== 'idle' ? speechLabels[speech] : recognitionFailed ? 'Transcription indisponible.' : states[phase] || (embedded && ['thinking','speaking','preparing'].includes(phase) ? 'Échange en cours.' : received ? 'Transcription reçue.' : 'À vous de jouer.'),
      active: speaking || ['starting','listening','hearing','transcribing','thinking','speaking'].includes(phase) && hasAudio,
      capture: ['reviewing','paused'].includes(phase) ? 'Au repos' : hasAudio ? phase === 'hearing' ? 'Parole détectée' : 'Micro ouvert' : 'Micro éteint',
      recognition: phase === 'transcribing' ? 'En cours' : recognitionFailed ? 'Indisponible' : received ? 'Reçue' : 'En attente',
      response: embedded ? phase === 'thinking' ? 'En cours' : 'Suivi de l’échange' : 'Hors de cet essai',
      voice: speechLabels[speech] || (embedded && phase === 'speaking' ? 'Lecture demandée' : 'À essayer'),
      tones: { capture: hasAudio && !['reviewing','paused'].includes(phase) ? 'active' : 'idle', recognition: phase === 'transcribing' ? 'active' : recognitionFailed ? 'caution' : received ? 'complete' : 'idle', response: embedded ? phase === 'thinking' ? 'active' : 'idle' : 'off', voice: speaking || embedded && phase === 'speaking' ? 'active' : speech === 'done' ? 'complete' : ['stopped','error'].includes(speech) ? 'caution' : 'idle' },
      speechLabel: speechLabels[speech] || 'À vous d’écouter.',
    };
  }
  const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  const ms = value => Number.isFinite(value) ? Math.round(value).toLocaleString('fr-CA') + ' ms' : '—';
  function create(host) {
    const find = selector => host.querySelector(selector), role = name => find(`[data-role="${name}"]`);
    const bars = [], levels = Array(70).fill(0);
    for (let i = 0; i < levels.length; i++) { const bar = document.createElementNS('http://www.w3.org/2000/svg','rect'); bar.setAttribute('x', String(i*8+1));bar.setAttribute('width','3');bar.setAttribute('rx','1.5');role('signalBars').append(bar);bars.push(bar); }
    return {
      update(input) {
        const view = describe(input), result = input.recognition || {}, trace = result.recognition || {};
        text(role('phase'),view.title);text(role('liveBadge'),view.active ? 'En direct' : 'Au repos');role('liveBadge').dataset.active=String(view.active);
        text(role('monitorHint'),input.phase==='error' && input.detail ? input.detail : input.recognitionFailed ? 'Réécoutez l’extrait capté, puis reprenez l’écoute pour réessayer. Le micro est au repos.' : input.speech==='preparing' ? 'Le lecteur prépare le texte. Stop reste disponible.' : input.speech==='scheduled' ? 'Le signal est programmé par le lecteur. Stop coupe la lecture.' : input.speech==='done' ? 'Réécoutez le texte ou comparez une autre voix.' : input.speech==='stopped' ? 'La lecture est arrêtée. Vous pouvez reprendre un essai.' : input.speech==='error' ? 'Le lecteur n’a pas terminé. Les détails sont indiqués ci-dessous.' : input.embedded ? 'Diagnostic de votre conversation courante.' : input.hasAudio ? input.phase==='reviewing' ? 'L’extrait reste temporaire. Comparez le son et les mots.' : input.wakeWord ? 'Dites « Hey Nestor », puis enchaînez naturellement.' : 'Parlez naturellement. Pause ferme le micro.' : 'Une phrase pour commencer. Les détails viennent avec les essais.');
        for (const id of ['capture','recognition','response','voice']) { const step=find(`[data-step="${id}"]`);step.dataset.state=view.tones[id];text(step.querySelector('.vw-step-status'),view[id]); }
        text(find('[data-stat="recognition"]'),ms(result.sttMs));text(find('[data-stat="queue"]'),ms(trace.queueMs));
        text(find('[data-stat="language"]'),input.language==='en' ? 'EN' : 'FR · QC');
        text(find('[data-stat="voice"]'),input.receipt?.voice || '—');text(find('[data-stat-note="voice"]'),input.receipt?.provider || 'Après une lecture');
        text(role('speechState'),view.speechLabel);
        text(role('speechDetail'),input.receipt?.voice ? 'Voix reçue : ' + [input.receipt.voice,input.receipt.provider,input.receipt.language?.toUpperCase()].filter(Boolean).join(' · ') : input.speech==='done' ? 'Le lecteur a terminé. Aucun reçu vocal fourni.' : 'La voix reçue et ses mesures apparaîtront ici.');
        if (!input.hasAudio || ['reviewing','paused','idle','error'].includes(input.phase)) levels.fill(0); else { levels.shift();levels.push(Math.max(0,Math.min(1,(input.level || 0)*12))); }
        bars.forEach((bar,i)=>{const height=2+levels[i]*80;bar.setAttribute('y',String(48-height/2));bar.setAttribute('height',String(height));});
        find('.vw-signal').dataset.active=String(input.hasAudio && !['reviewing','paused','error'].includes(input.phase));
      },
    };
  }
  function comparison(host,value) {
    host.replaceChildren();
    value.rows.forEach((row,i)=>{
      const card=document.createElement('dl');card.className='vw-variant';
      const label=document.createElement('dt');label.textContent=`${i ? 'B' : 'A'} · ${row.language.toUpperCase()} · ${row.elapsedMs} ms`;
      const result=document.createElement('dd');result.textContent=row.result.control==='stop' ? 'Commande Stop' : row.result.text || 'Aucune parole';card.append(label,result);host.append(card);
    });
  }
  return { template,create,describe,comparison,names,paths,tabs };
});
