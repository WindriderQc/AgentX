/* Read-only task presentation. Explicit profile choice; no conversation or device access. */
(function(root){
 'use strict';
 function calendarDay(value){return typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value)&&Number.isFinite(new Date(value+'T12:00:00Z').valueOf())&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
 function nextDay(value){if(!calendarDay(value))throw Error('Invalid calendar day');const date=new Date(value+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10);}
 function tasksFor(data,profileId,day){
  if(!calendarDay(data.today)||!Array.isArray(data.chores))throw Error('Invalid task response');
  const target=day==='tomorrow'?nextDay(data.today):data.today;
  return data.chores.filter(task=>task.profileId===profileId&&['queued','in_progress','review'].includes(task.status)&&(task.dueDay===target||day!=='tomorrow'&&(!task.dueDay||calendarDay(task.dueDay)&&task.dueDay<target)));
 }
 async function mount(document,fetcher=root.fetch.bind(root),location=root.location){
  const child=document.getElementById('child'),status=document.getElementById('status'),list=document.getElementById('tasks'),coverage=document.getElementById('coverage'),routines=document.getElementById('routines');
  let day=new URL(location.href).searchParams.get('day')==='tomorrow'?'tomorrow':'today',epoch=0,abort=null,profileEpoch=0,profileAbort=null,visible=!root.parent||root.parent===root;
  const api=async(path,signal)=>{const response=await fetcher(path,{method:'GET',credentials:'same-origin',cache:'no-store',signal});const body=await response.json();if(!response.ok||body.status==='error')throw Error('Task read failed');return body.data||body;};
  function buttons(){for(const name of ['today','tomorrow'])document.getElementById(name).setAttribute('aria-pressed',String(day===name));}
  async function load(){
   const current=++epoch;abort?.abort();abort=new AbortController();list.replaceChildren();coverage.textContent='';routines.textContent='';buttons();
   if(!visible||!child.value){status.textContent='Choisis un enfant pour voir ses tâches.';return;}
   status.textContent='Chargement des tâches…';const selected=child.value;
   try{
    const data=await api('/api/family/chores?profileId='+encodeURIComponent(selected),abort.signal);
    if(current!==epoch||child.value!==selected)return;
    const tasks=tasksFor(data,selected,day);
    status.textContent=tasks.length?(day==='tomorrow'?'Tâches prévues pour demain.':'Tâches pour aujourd’hui.'):(data.hasMore?'Aucune tâche de cette date parmi les éléments reçus.':'Aucune tâche enregistrée pour '+(day==='tomorrow'?'demain.':'aujourd’hui.'));
    for(const task of tasks){const row=document.createElement('li'),title=document.createElement('strong'),detail=document.createElement('span');title.textContent=String(task.title||'Tâche');detail.textContent=task.status==='review'?'En attente de vérification par un parent':task.dueDay&&task.dueDay<data.today?'En retard':task.dueDay?'À faire':'Sans date';row.append(title,detail);list.append(row);}
    coverage.textContent=data.hasMore?'Une partie des tâches est affichée.':'';
    routines.textContent=day==='tomorrow'?'Les tâches répétées peuvent apparaître après la vérification d’un parent.':'';
   }catch(error){if(current!==epoch||error.name==='AbortError')return;status.textContent='La liste est indisponible pour le moment. Réessaie avec le choix du jour.';}
  }
  child.addEventListener('change',load);for(const name of ['today','tomorrow'])document.getElementById(name).addEventListener('click',()=>{day=name;void load();});buttons();
  async function profiles(){
   const current=++profileEpoch;profileAbort?.abort();profileAbort=new AbortController();
   try{const data=await api('/api/family/profiles',profileAbort.signal);if(!visible||current!==profileEpoch)return;
    for(const profile of data.profiles||[]){if(profile.active===false)continue;const option=document.createElement('option');option.value=String(profile.id);option.textContent=String(profile.displayName||'Enfant');child.append(option);}
    if(child.options.length===1)status.textContent='Aucun profil enfant n’est disponible.';
   }catch(error){if(visible&&current===profileEpoch&&error.name!=='AbortError')status.textContent='Les profils sont indisponibles pour le moment.';}
  }
  function visibility(next){
   if(next===visible)return;visible=next;++epoch;++profileEpoch;abort?.abort();profileAbort?.abort();
   list.replaceChildren();coverage.textContent='';routines.textContent='';child.value='';while(child.options.length>1)child.remove(1);
   status.textContent='Choisis un enfant pour voir ses tâches.';if(visible)void profiles();
  }
  root.addEventListener?.('message',event=>{if(event.source===root.parent&&event.origin===location.origin&&event.data?.type==='agentx.page-visibility'&&typeof event.data.visible==='boolean')visibility(event.data.visible);});
  root.addEventListener?.('pagehide',()=>visibility(false));
  document.addEventListener?.('visibilitychange',()=>{if(document.hidden)visibility(false);else if(root.parent===root)visibility(true);});
  if(visible)await profiles();

 }
 const api={calendarDay,nextDay,tasksFor,mount};if(typeof module==='object'&&module.exports)module.exports=api;else{root.KidsTasksScreen=api;void mount(root.document);}
})(typeof globalThis==='undefined'?this:globalThis);
