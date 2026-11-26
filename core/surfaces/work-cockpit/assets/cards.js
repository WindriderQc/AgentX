'use strict';

const cockpitCards = (() => {
  const lanes = [
    {id:'decision',label:'À décider',hint:'Triage en attente ou dossier bloqué'},
    {id:'plan',label:'Ce que je compte creuser',hint:'Dossiers Pipeline acceptés et en file'},
    {id:'work',label:'Ce qui avance',hint:'Dossiers en cours ou en revue'}
  ];
  function fromPipeline(task) {
    const {status, intake, pipelineId} = task;
    let lane = 'other';
    if (status === 'blocked' || (status === 'queued' && ['proposed','needs_clarification'].includes(intake))) lane = 'decision';
    else if (['in_progress','review'].includes(status)) lane = 'work';
    else if (status === 'queued' && intake === 'accepted') lane = 'plan';
    return {id:'pipeline-'+pipelineId,ref:'Pipeline #'+pipelineId,title:task.title || 'Pipeline #'+pipelineId,
      lane,status,domain:task.service,type:'Dossier Pipeline',executor:task.assigned ? 'Attribué · identité masquée' : 'Non attribué',intake,
      attempts:task.attempts,relationships:task.relationships,transitions:task.transitions || [],
      created:task.createdAt,updated:task.updatedAt,url:'/pipeline?task='+encodeURIComponent(pipelineId)};
  }
  return {lanes, fromPipeline};
})();
