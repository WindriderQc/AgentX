'use strict';

const cockpitCards = (() => {
  const lanes = [
    {id:'decision', label:'À décider', hint:'Demandes en attente d’une décision'},
    {id:'plan', label:'Ce que je compte creuser', hint:'Pistes encore au stade de l’intention'},
    {id:'work', label:'Ce qui avance', hint:'Travaux avec une étape réalisée'}
  ];
  const stages = {proposed:'Proposition à trier', needs_clarification:'Clarification requise',
    accepted:'Portée acceptée', deferred:'Différé', declined:'Décliné', superseded:'Remplacé'};
  const states = {queued:'En file', in_progress:'En cours', review:'En revue', blocked:'Bloqué', done:'Clos'};
  function fromPipeline(task) {
    const undecided = ['proposed','needs_clarification'].includes(task.intake);
    const active = ['in_progress','review'].includes(task.status);
    let lane = 'other';
    if (undecided || task.status === 'blocked') lane = 'decision';
    else if (active) lane = 'work';
    else if (task.intake === 'accepted' && task.status === 'queued') lane = 'plan';
    const events = {intake_decision:'Décision de triage enregistrée', transition:'Transition de dossier enregistrée', created:'Dossier créé'};
    return {id:'pipeline-'+task.pipelineId, ref:'Pipeline #'+task.pipelineId, title:task.label,
      domain:'Ingénierie', type:'Dossier Pipeline', executor:task.assigned ? 'Attribué · identité masquée' : 'Non attribué',
      owner:'Non renseigné', lane, status:undecided ? stages[task.intake] : states[task.status] || 'État inconnu',
      intent:task.intent,
      result:task.relationships === 0 ? 'Aucun résultat lié dans cette projection.' : 'Consulter les relations dans le dossier natif pour vérifier les résultats.',
      evidence:'Tentatives automatiques : ' + task.attempts + '. Relations enregistrées : ' + task.relationships + '.',
      next:task.nextAction === 'intake_review' ? 'Triage humain requis.' : 'Consulter la prochaine action dans Pipeline.',
      updated:task.updatedAt, url:'/pipeline?task='+encodeURIComponent(task.pipelineId),
      timeline:task.timeline.map(event=>({stage:'Enregistré', label:events[event.kind], at:event.at}))};
  }
  const dot = {id:'dot', ref:'Fictif · Dot', title:'Comparer deux méthodes de recherche',
    domain:'Recherche', type:'Investigation', executor:'Dot', owner:'Personne à l’origine de la demande',
    lane:'plan', status:'Piste proposée', intent:'Comparer deux méthodes sur un exemple public.',
    result:'Protocole esquissé. Aucun essai effectué.', next:'Définir un critère de comparaison.',
    timeline:[{stage:'Prévu',label:'Question de recherche formulée'}]};
  const finance = {id:'comptable', ref:'Fictif · Comptable', title:'Vérifier un modèle de synthèse',
    domain:'Finance', type:'Vérification', executor:'Comptable', owner:'Responsable de la revue',
    lane:'work', status:'Validation en attente', intent:'Vérifier la lisibilité d’un modèle de synthèse fictif.',
    result:'Synthèse fictive remise pour relecture.',next:'Recueillir la validation du responsable.',
    timeline:[{stage:'Prévu',label:'Portée définie'},{stage:'Exécuté',label:'Contrôle effectué'},
      {stage:'Livré',label:'Synthèse fictive remise'},{stage:'À valider',label:'Validation en attente'}]};
  const decision = {id:'review', ref:'Fictif · Revue', title:'Choisir le périmètre du contrôle',
    domain:'Ingénierie', type:'Cadrage', executor:'Opératrice fictive', owner:'Équipe de revue fictive',
    lane:'decision', status:'Proposition à trier', intent:'Délimiter le prochain contrôle.',
    result:'Aucun contrôle démarré.',next:'Choisir le périmètre.',
    timeline:[{stage:'Prévu',label:'Demande soumise pour triage'}]};
  const topics = ['navigation','recherche','export','accessibilité','tri','lecture','calendrier','affichage','classement','historique'];
  function demo() {
    return topics.flatMap((topic,i)=>[decision,dot,finance].map((item,j)=>{
      const n = i*3+j+1;
      return {...item,id:'demo-'+n,ref:'Fictif · D'+String(n).padStart(2,'0'),
        title:item.title+' · '+topic,updated:new Date(Date.UTC(2026,10,1+n,12)).toISOString()};
    }));
  }
  return {lanes, fromPipeline, dot, finance, demo};
})();
