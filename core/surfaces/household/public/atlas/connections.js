import {escape,number,dateLabel,icon} from './ui.js';
import {reviewState,reviewLabel} from './review.js';
import {sourcePanel} from './evidence.js';
import {readSource} from './data.js';

export const connectionKinds={
 agreement:{label:'Sources concordantes',symbol:'↔'},
 sequence:{label:'Étapes successives',symbol:'→'},
 conflict:{label:'À éclaircir',symbol:'!'},
 hypothesis:{label:'Liens proposés',symbol:'◇'}
};
export function connectionIndex(relations=[]){
 const index=new Map();
 for(const relation of relations)for(const id of relation.eventIds||[]){if(!index.has(id))index.set(id,[]);index.get(id).push(relation);}
 return index;
}
export function matchesEvidence(event,filter,index,newIds){
 if(filter==='owner')return ['owner-testimony','owner-tentative'].includes(event.confirmationBasis);
 if(filter==='new')return newIds.has(event.id);
 if(filter==='kept')return !!event.core?.souvenirNoteId;
 if(filter==='photos')return !!event.photoSourceIds?.length;
 if(filter==='checked')return event.evidenceCheck?.status==='passed';
 if(filter==='linked')return !!index.get(event.id)?.length;
 if(filter==='conflict')return !!index.get(event.id)?.some(r=>r.kind==='conflict');
 return true;
}
export function visibleConnections(state){
 const visible=new Set(state.filtered.filter(e=>state.categories.has(e.category)).map(e=>e.id));
 return (state.meta.pass3?.relations||state.meta.relations||[]).filter(r=>r.eventIds.some(id=>visible.has(id)));
}
export function eventConnections(event,state){
 const relations=state.connectionIndex?.get(event.id)||[];
 if(!relations.length)return '';
 return `<section class="event-connections"><h3>Ce moment dans son histoire <span>${number(relations.length)} lien${relations.length>1?'s':''}</span></h3>${relations.map(r=>{const kind=connectionKinds[r.kind];return `<button type="button" class="connection-inline connection-${r.kind}" data-connection="${escape(r.id)}"><span class="connection-symbol" aria-hidden="true">${kind.symbol}</span><span><strong>${escape(r.title)}</strong><small>${escape(kind.label)}</small></span><span aria-hidden="true">↗</span></button>`;}).join('')}</section>`;
}

export function showConnections(popup,api,anchor,{eventId=null,relationId=null,kind='all'}={}){
 const state=api.state;
 let relations=eventId?(state.connectionIndex.get(eventId)||[]):visibleConnections(state);
 if(relationId)relations=relations.filter(r=>r.id===relationId);
 const sourceCache=new Map();
 popup.info('',anchor);popup.makeModal();popup.root.querySelector('.popover').classList.add('connections-popover');
 popup.root.querySelector('.popover').setAttribute('aria-label','Recoupements et preuves de la chronologie');
 const container=popup.root.querySelector('.info-content');
 const render=()=>{
  const selected=kind==='all'?relations:relations.filter(r=>r.kind===kind);
  container.innerHTML=`<div class="connections-intro"><p class="eyebrow">LES FILS QUI SE REJOIGNENT</p><h3>Chaque moment a un contexte.</h3><p>Comparer les traces, retrouver une transition, éclaircir une date. Les liens restent des propositions à relire avec leurs sources.</p></div><div class="connection-tabs" aria-label="Types de recoupements">${[['all',{label:'Tous',symbol:'✳'}],...Object.entries(connectionKinds)].map(([key,type])=>{const count=key==='all'?relations.length:relations.filter(r=>r.kind===key).length;return `<button type="button" data-connection-kind="${key}" aria-pressed="${kind===key}" ${count?'':'disabled'}>${type.symbol} ${escape(type.label)} <span>${number(count)}</span></button>`;}).join('')}</div><div class="connection-list">${selected.map(r=>{
   const type=connectionKinds[r.kind],events=r.eventIds.map(id=>state.events.find(e=>e.id===id)).filter(Boolean).sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')),revised=events.some(e=>e.reviewUpdatedAt&&e.reviewUpdatedAt>r.checkedAt);
   return `<article class="connection-card connection-${r.kind}" data-connection-card="${escape(r.id)}"><div class="connection-card-heading"><span class="connection-symbol" aria-hidden="true">${type.symbol}</span><div><p class="connection-kind">${escape(type.label)}</p><h4>${escape(r.title)}</h4></div></div><p class="connection-summary">${escape(r.summary)}</p><div class="connection-moments">${events.map(e=>`<button type="button" data-open-moment="${escape(e.id)}"><time>${escape(dateLabel(e))}</time><strong>${escape(e.title)}</strong><small>${escape(reviewLabel(e))}${reviewState(e)==='dismissed'?' · conservé pour le contexte':''}</small><span aria-hidden="true">↗</span></button>`).join('')}</div>${r.rationale?`<p class="connection-rationale">${escape(r.rationale)}</p>`:''}<p class="connection-limit">${escape(r.limits||'La confirmation de ce rapprochement reste ouverte.')}</p>${revised?'<p class="connection-limit">Un moment a reçu des précisions depuis cette analyse : relis le rapprochement avec sa version actuelle.</p>':''}<div class="connection-actions"><button type="button" class="secondary-button" data-explore-connection="${escape(r.id)}">${icon('calendar')} Explorer cette période</button><button type="button" class="text-button" data-connection-evidence="${escape(r.id)}" aria-expanded="false">${r.quoteCount?`${number(r.quoteCount)} extraits contrôlés · voir les preuves ⌄`:`${number(r.sourceIds?.length||0)} source${(r.sourceIds?.length||0)>1?'s':''} archivée${(r.sourceIds?.length||0)>1?'s':''} · lire ⌄`}</button></div><section class="connection-evidence" data-evidence-for="${escape(r.id)}" hidden><p class="connection-evidence-note">${r.quoteCount?`Les citations sont retrouvées dans les textes archivés. ${number(r.nativeRecordCount)} documents natifs distincts; l’indépendance des déclarations n’est pas établie automatiquement.`:'Messages archivés dans AgentX Core, lus avec leur empreinte. Leur indépendance n’est pas établie automatiquement.'}</p>${(r.quoteCount?[]:r.sourceIds||[]).map((id,i)=>`<figure><figcaption>Source ${i+1}<button type="button" class="text-button" data-read-connection-source="${escape(id)}">Lire la source complète ↗</button></figcaption></figure>`).join('')}${(r.claimsWithExactQuotes||[]).map(c=>`<figure><blockquote>${escape(c.quote)}</blockquote><figcaption>${escape(c.label||'Extrait archivé')}<button type="button" class="text-button" data-read-connection-source="${escape(c.sourceId)}">Lire la source complète ↗</button></figcaption></figure>`).join('')}<div data-connection-source></div></section></article>`;
  }).join('')||'<p class="connection-empty">Aucun recoupement avec ces filtres. Les zones peu documentées restent à explorer.</p>'}</div><p class="connection-footer">Concordance de documents, réalisation d’un projet et confirmation personnelle sont des informations distinctes. Les copies d’un même message ne constituent pas des témoignages supplémentaires.</p>`;
  container.querySelectorAll('[data-connection-kind]').forEach(b=>b.addEventListener('click',()=>{kind=b.dataset.connectionKind;render();container.querySelector(`[data-connection-kind="${kind}"]`)?.focus({preventScroll:true});}));
  container.querySelectorAll('[data-open-moment]').forEach(b=>b.addEventListener('click',()=>{const e=state.events.find(e=>e.id===b.dataset.openMoment);if(!e)return;popup.open([e],anchor,true);const back=document.createElement('button');back.type='button';back.className='text-button connection-back';back.dataset.backConnections='';back.textContent='← Retour aux recoupements';back.addEventListener('click',()=>showConnections(popup,api,anchor,{eventId,relationId,kind}));popup.root.querySelector('.popup-body').prepend(back);}));
  container.querySelectorAll('[data-explore-connection]').forEach(b=>b.addEventListener('click',()=>{const relation=relations.find(r=>r.id===b.dataset.exploreConnection),events=relation.eventIds.map(id=>state.events.find(e=>e.id===id)).filter(Boolean);if(!events.some(e=>e.date)){api.toast('Ces moments attendent une date pour être placés sur la frise.');return;}if(api.focusConnection)api.focusConnection(relation);else api.focus(events);popup.close();}));
  container.querySelectorAll('[data-connection-evidence]').forEach(b=>b.addEventListener('click',()=>{const target=[...container.querySelectorAll('[data-evidence-for]')].find(e=>e.dataset.evidenceFor===b.dataset.connectionEvidence);target.hidden=!target.hidden;b.setAttribute('aria-expanded',String(!target.hidden));popup.position();}));
  container.querySelectorAll('[data-read-connection-source]').forEach(b=>b.addEventListener('click',async()=>{
   const target=b.closest('.connection-evidence').querySelector('[data-connection-source]');b.disabled=true;
   try{let source=sourceCache.get(b.dataset.readConnectionSource);if(!source){source=await readSource(b.dataset.readConnectionSource);sourceCache.set(b.dataset.readConnectionSource,source);}if(target.isConnected){target.innerHTML=sourcePanel(source);target.scrollIntoView({block:'nearest'});}}
   catch(error){if(target.isConnected)target.textContent=error.message;}finally{b.disabled=false;}
  }));
  popup.position();
 };
 render();popup.root.querySelector('[data-close-info]')?.focus({preventScroll:true});
}
