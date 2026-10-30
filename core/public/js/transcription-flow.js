/* Read-only journey: same node/LED/dotted-wire language as Nestor's workflow panel.
 * This serial pipeline has its own receipt semantics; it does not reuse conversation events. */
(function(root) {
  'use strict';
  const steps = [
    ['request', 'Votre URL', 'AgentX', 'Core valide le lien et conserve votre demande. Fermer la page ne l’annule pas.'],
    ['admission', 'File et ressource', 'File AgentX', 'Core attend le créneau puis réserve la ressource physique. Cette admission précède le téléchargement.'],
    ['download', 'Piste audio', 'yt-dlp', 'La meilleure piste HTTPS native est téléchargée depuis YouTube. Aucune conversion MP3 n’est imposée.'],
    ['decode', 'Préparer l’audio', 'PyAV', 'L’audio est décodé vers un fichier temporaire borné. Le budget porte sur le son décodé, pas seulement le fichier compressé.'],
    ['whisper', 'Paroles → texte', 'Whisper', 'Le service vocal existant reconnaît les paroles et produit les segments horodatés. Il partage sa ressource avec la voix.'],
    ['save', 'Conserver le résultat', 'Stockage local', 'Le service nettoie l’audio temporaire, conserve son reçu et Core enregistre le texte. Ces opérations ne sont pas chronométrées séparément.'],
    ['read', 'Lire et exporter', 'Texte · SRT', 'La lecture devient disponible après conservation. Les fichiers TXT et SRT sont générés à votre demande ; ce ne sont pas deux traitements en arrière-plan.']
  ];
  const stageIndex = { accepted: 1, admission: 1, dispatching: 1, queued: 1, downloading: 2, decoding: 3, transcribing: 4, cleaning: 5, completed: 6 };
  const recent = (value, now) => Number.isFinite(Date.parse(value)) && now - Date.parse(value) >= -5000 && now - Date.parse(value) <= 20000;
  function project(row, service, now = Date.now()) {
    if (!row) return { mode: 'explanation', index: -1, animate: false, message: 'Le parcours général. Sélectionnez une transcription pour suivre ses reçus.' };
    if (row.state === 'completed') return { mode: 'history', index: 6, animate: false,
      message: 'Historique terminé. Le temps total est mesuré ; les durées de chaque bloc ne sont pas consignées.' };
    if (row.state === 'cancelled') return { mode: 'cancelled', index: row.startedAt ? -1 : 1, animate: false,
      message: row.startedAt ? 'Tentative annulée. La dernière sous-étape avant arrêt n’est pas consignée.' : 'Annulée avant le démarrage du service vocal.' };
    if (row.state === 'uncertain' || row.stage === 'reconciling') return { mode: 'uncertain', index: -1, animate: false,
      message: 'Le reçu reste à vérifier. Le chemin ne suppose ni activité GPU ni arrêt ; aucun remplacement automatique.' };
    if (row.stage === 'cancelling' || row.cancelRequested && !['failed', 'completed'].includes(row.state)) return {
      mode: 'cancelling', index: -1, animate: false, message: 'Arrêt demandé. Le service attend la fin de l’opération native en cours ; l’étape exacte n’est pas confirmée.' };
    if (row.state === 'failed') return { mode: 'failed', index: stageIndex[row.stage] ?? -1, animate: false,
      message: row.error || 'Le traitement s’est arrêté. Les étapes suivantes ne sont pas déclarées exécutées.' };
    if (row.state === 'queued') return { mode: 'waiting', index: 1, animate: false, message: waitReason(row, service, now) };
    const observation = service?.service?.activity;
    const nativeFresh = observation && recent(observation.observedAt, now) &&
      Date.parse(observation.observedAt) >= Date.parse(row.updatedAt || row.startedAt || 0);
    const job = nativeFresh ? observation.jobs?.find(item => item.id === row.queueId) : null;
    const fresh = nativeFresh ? Boolean(job) : recent(row.updatedAt, now);
    return { mode: fresh ? 'live' : 'stale', index: stageIndex[job?.stage || row.stage] ?? -1, animate: fresh,
      message: fresh ? 'Dernière étape confirmée par le service. L’animation suit ses informations ; elle ne mesure pas la charge du GPU.'
        : 'Dernière étape connue ; observation à rafraîchir. L’animation est arrêtée.' };
  }
  function waitReason(row, service, now) {
    const plan = row.planning;
    if (!plan?.available) return 'La planification reste à vérifier ; aucune heure de démarrage n’est confirmée.';
    if (plan.scheduleState === 'expired') return 'Le créneau a expiré sans démarrage. Annulez puis préparez une nouvelle demande.';
    if (Date.parse(plan.earliestStartAt) > now) return 'En attente de l’heure autorisée, puis de l’admission native. Le créneau n’est pas une heure de fin promise.';
    if (row.error || row.planningError) return row.error || row.planningError;
    if (service?.coordination?.blockers?.some(item => item.uncertain)) return 'La ressource attend une réconciliation native. Elle n’est pas déclarée libre.';
    if (service?.coordination?.blockers?.length) return 'La ressource partagée est retenue par un autre travail ou une maintenance. Core attend son admission.';
    if (plan.state === 'requested') return 'La demande est conservée ; Core cherche encore un créneau libre.';
    return 'Le créneau est ouvert. Core doit encore vérifier le service et obtenir l’admission ; le démarrage n’est pas garanti à la seconde.';
  }
  function mount(container) {
    const node = (tag, text, cls) => { const n = document.createElement(tag); if(text != null)n.textContent=text; if(cls)n.className=cls; return n; };
    const heading = node('div', null, 'tr-flow-heading'), intro=node('div');
    intro.append(node('p', 'SUIVRE LE CHEMIN', 'tr-eyebrow'), node('h2', 'De l’URL au texte'));
    const reset=node('button', 'Voir le principe', 'tr-button'); reset.type='button';
    const fold=node('button','Réduire','tr-button');fold.type='button';
    fold.setAttribute('aria-controls','transcriptionFlowNodes transcriptionFlowDetail');
    fold.setAttribute('aria-expanded','true');
    const controls=node('div',null,'tr-flow-controls');controls.append(reset,fold);heading.append(intro,controls);
    const title=node('p', null, 'tr-flow-title'), summary=node('p', null, 'tr-help'), clock=node('p', null, 'tr-flow-clock');
    summary.setAttribute('role','status');
    const list=node('ol',null,'tr-flow-nodes'), detail=node('div',null,'tr-flow-detail');
    list.id='transcriptionFlowNodes';
    detail.id='transcriptionFlowDetail'; detail.setAttribute('role','region'); detail.setAttribute('aria-label','Détails de l’étape');
    const buttons=steps.map(([key,label,engine],i)=>{
      const li=node('li');li.dataset.step=key;
      const b=node('button'); b.type='button'; b.setAttribute('aria-controls',detail.id);
      const led=node('span',String(i+1),'tr-flow-led'); led.setAttribute('aria-hidden','true');
      b.append(led,node('strong',label),node('span',engine,'tr-flow-engine'),node('span','Principe','tr-flow-state'));
      li.append(b);list.append(li);return b;
    });
    container.append(heading,title,summary,clock,list,detail);
    let chosen=4, row=null, service=null, general=false, folded=false;
    function foldView() {list.hidden=folded;detail.hidden=folded;fold.setAttribute('aria-expanded',String(!folded));fold.textContent=folded?'Déplier':'Réduire';}
    fold.addEventListener('click',()=>{folded=!folded;foldView();});
    const labels={explanation:'Parcours général',history:'Historique terminé',live:'En cours',waiting:'En attente',failed:'Échec',cancelled:'Annulée',uncertain:'À vérifier',stale:'Observation ancienne',cancelling:'Annulation demandée'};
    function describe() {
      const subject = general ? null : row;
      const [key,label,engine,explanation]=steps[chosen];
      const historical = subject && ['completed','failed','cancelled'].includes(subject.state);
      let where = subject?.execution?.machine || (!historical ? service?.configuration?.machine?.name : null);
      let more='';
      if (key==='whisper') {
        const actual=subject?.execution;
        more=actual?.device && actual?.model ? 'Reçu de cette tentative : '+actual.model+' · '+actual.device+(actual.computeType?' · '+actual.computeType:'')
          : historical ? 'Le modèle effectif de cette ancienne tentative n’est pas consigné.'
          : 'Modèle configuré : '+(service?.configuration?.model||'non observé')+(service?.configuration?.device?' · '+service.configuration.device:'')+'. Ce réglage ne prouve pas qu’il décode en ce moment. Le modèle n’est pas sélectionnable par demande.';
      }
      if (key==='decode' && service?.limits) {
        const limits=service.limits;
        more=(historical ? 'Budgets actuels du service, sans preuve des anciennes valeurs : ' : 'Budgets configurés : ')+(Number.isFinite(limits.maxSeconds)?Math.floor(limits.maxSeconds/60)+' min de son décodé':'durée non observée')+
          (Number.isFinite(limits.maxDecodedBytes)?' · '+Math.round(limits.maxDecodedBytes/1024**2)+' Mio float32':'')+
          (Number.isFinite(limits.maxDownloadBytes)?' · '+Math.round(limits.maxDownloadBytes/1024**2)+' Mio compressés au maximum':'')+
          '. Ils protègent la mémoire et le disque ; ce ne sont pas des limites Whisper.'+
          (Number.isFinite(limits.effectiveDownloadBytes)?' À l’observation, budget disque disponible : '+Math.floor(limits.effectiveDownloadBytes/1024**2)+' Mio. Il sera revérifié au téléchargement.':'');
      }
      detail.replaceChildren(node('strong',label+' · '+engine),node('p',explanation));
      if([2,3,4].includes(chosen))detail.append(node('p','Machine '+(historical?'consignée':'prévue')+' : '+(where||'non consignée')+'.'));
      if(more)detail.append(node('p',more));
      if(chosen===1)detail.append(node('p',subject?.state==='queued'?waitReason(subject,service,Date.now()):
        subject?.startedAt?'Le lancement de cette tentative a été enregistré après admission. Cela ne décrit pas la disponibilité actuelle de la ressource.':
        'L’heure et le fuseau sont définis dans le formulaire. Une admission exclusive est vérifiée avant le téléchargement.'));
      if(chosen===4)detail.append(node('p','Les réponses vocales peuvent être plus lentes pendant ce travail. L’activité des conversations vocales n’est pas mesurée par ce chemin.'));
      buttons.forEach((b,i)=>b.setAttribute('aria-expanded',String(i===chosen)));
    }
    function render() {
      const view=project(general?null:row,service);
      container.dataset.mode=view.mode;
      title.textContent=labels[view.mode]+(row&&!general?' · '+(row.title||'Vidéo YouTube'):'');
      summary.textContent=view.message;
      clock.replaceChildren();
      if(row&&!general) {
        const zone=row.timeZone||'UTC';
        const date=value=>new Intl.DateTimeFormat('fr-CA',{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(new Date(value));
        if(row.planning?.earliestStartAt&&row.state==='queued')clock.append(node('span','Pas avant '+date(row.planning.earliestStartAt)+' · '+zone+'. '));
        else clock.append(node('span','Fuseau de la demande : '+zone+'. '));
        if(row.startedAt){const t=node('span');t.dataset.started=row.startedAt;t.dataset.finished=row.finishedAt||'';clock.append(t);}
      }
      buttons.forEach((b,i)=>{
        let tone='unknown',label='Principe';
        if(view.mode==='history'){tone='complete';label=i===6?'Disponible':'Parcouru';}
        else if(view.index>=0){tone=i<view.index?'complete':i===view.index?(view.mode==='failed'?'error':view.mode==='waiting'?'waiting':view.animate?'active':'caution'):'unknown';
          label=i<view.index?'Parcouru':i===view.index?labels[view.mode]:'Non confirmé';}
        b.parentElement.dataset.tone=tone;
        b.setAttribute('aria-current',i===view.index?'step':'false');b.querySelector('.tr-flow-state').textContent=label;
      });
      describe();
    }
    buttons.forEach((b,i)=>b.addEventListener('click',()=>{chosen=i;describe();}));
    reset.addEventListener('click',()=>{general=true;folded=false;foldView();render();});
    return { update(nextRow,nextService,{select=false}={}) { row=nextRow;service=nextService;if(select){general=false;folded=false;foldView();}render(); } };
  }
  const api={project,waitReason,steps,mount}; if(typeof module==='object'&&module.exports)module.exports=api; else root.TranscriptionFlow=api;
})(typeof window==='undefined'?globalThis:window);
