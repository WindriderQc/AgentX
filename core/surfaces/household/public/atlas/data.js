// The Atlas reads and writes the owner's history through Core only. Raw
// entries are kept for the page's lifetime so a decision can be reflected
// without a full reread; nothing is stored in the browser.
import {projectEntry,buildRelations,collectMedia,summarize,parseSourceId,projectArchive,projectContextSource,projectRecall} from './projection.js';
import {demoEvents,demoSources} from './demo.js';

const raw=new Map();
let meta=null;

async function call(url,options={}){
 let response;
 try{response=await fetch(url,{credentials:'same-origin',...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});}
 catch{throw new Error('AgentX ne répond pas pour le moment.');}
 const answer=await response.json().catch(()=>({}));
 if(!response.ok||!(answer.status==='success'||answer.ok===true)){
  const error=new Error(response.status===409?'Ce moment a changé dans AgentX depuis l’ouverture de la page. Recharge la page avant de continuer.'
   :response.status===403?'Cette page est réservée au profil du propriétaire.':answer.message||answer.error?.message||'AgentX a refusé la demande.');
  error.status=response.status;throw error;
 }
 return answer.data;
}
const post=(url,body)=>call(url,{method:'POST',body:JSON.stringify(body)});

// The owner's story in the order told: narrative paths kept in each moment's context.
function contributions(events){
 const chapters=new Map();
 for(const e of events){
  const n=e.narrative;if(!n?.chapterId)continue;
  const chapter=chapters.get(n.chapterId)||{id:n.chapterId,title:n.title||'Ton récit',summary:n.summary||'',paths:new Map(),pendingDates:[]};
  if(n.pendingDate)chapter.pendingDates.push({id:e.id,label:n.label||e.title,context:n.context||''});
  else{const key=n.pathId||'path';const path=chapter.paths.get(key)||{label:n.pathLabel||'Étapes',items:[]};path.items.push({id:e.id,label:n.label||e.title,context:n.context||'',order:n.order??9999});chapter.paths.set(key,path);}
  chapters.set(n.chapterId,chapter);
 }
 const list=[...chapters.values()].map(c=>({...c,paths:[...c.paths.values()].map(p=>({...p,items:p.items.sort((a,b)=>a.order-b.order)}))}));
 return list.length?{chapters:list,events:events.filter(e=>['owner-testimony','owner-tentative'].includes(e.confirmationBasis)).length}:null;
}

function rebuild(){
 const events=[...raw.values()].map(projectEntry);
 const media=collectMedia(events);for(const event of events)event.photoIds=media.filter(p=>p.eventIds.includes(event.id)).map(p=>p.id);
 meta={...summarize(events,{readAt:meta?.fetchedAt,total:events.length}),truncated:meta?.truncated===true,displayPreferences:meta?.displayPreferences||{},relations:buildRelations(events),ownerContributions:contributions(events)};
 return {meta,events};
}

export async function loadHistory(){
 const timeline=await call('/api/secretary/history/timeline');
 raw.clear();for(const entry of timeline.entries)raw.set(entry.id,entry);
 meta={fetchedAt:timeline.readAt,truncated:timeline.truncated===true,displayPreferences:timeline.displayPreferences||{}};
 return rebuild();
}

export function loadDemo(){
 return {meta:{events:demoEvents.length,dated:demoEvents.length,undated:0,source:'Scénario fictif · Camille',demo:true,relations:[]},events:demoEvents};
}

// Core's answer to a decision is the entry without its souvenir join; keep the known souvenir.
function adopt(entry,souvenir){
 const previous=raw.get(entry.id);
 const next={...entry,...(souvenir?{souvenir}:previous?.souvenir&&entry.souvenirNoteId?{souvenir:previous.souvenir}:{})};
 raw.set(entry.id,next);
 const rebuilt=rebuild();return {...rebuilt,event:rebuilt.events.find(event=>event.core.id===next.id)};
}
const fence=event=>event.core.contextual?{contextRevision:event.contextRevision}:{};

// Factual confirmation is separate from keeping a souvenir. Core checks both
// the decision revision and the exact displayed context revision atomically.
export async function confirm(event){
 if(event.core.canConfirm===false)throw new Error('Ce souvenir diffère du relevé actuel. Relis le contexte original avant de le confirmer.');
 const answer=await post(`/api/secretary/history/${event.core.id}/review`,{revision:event.core.revision,...fence(event),
  state:'retained',assertionState:'confirmed',reason:'Contenu et précision confirmés explicitement depuis Life Atlas'});
 return adopt(answer.entry);
}

// Keep a moment as a souvenir in the owner's memory (Core's own route).
export async function keepSouvenir(event,{eventDate}={}){
 const answer=await post(`/api/secretary/history/${event.core.id}/souvenir`,
  {revision:event.core.revision,...fence(event),...(eventDate?{eventDate,eventDatePrecision:'day'}:{})});
 const note=answer.souvenir||await call(`/api/secretary/souvenirs/${answer.souvenirNoteId}`).then(r=>r.souvenir).catch(()=>null);
 return adopt(answer.entry,note?{id:note.id,revision:note.revision??0,text:note.text,eventDate:note.eventDate,eventDatePrecision:note.eventDatePrecision,people:note.people,places:note.places,historyContext:note.historyContext||null}:null);
}
export async function dismiss(event,reason){
 const answer=await post(`/api/secretary/history/${event.core.id}/review`,{revision:event.core.revision,state:'dismissed',reason:reason||'Écarté depuis Life Atlas'});
 return adopt(answer.entry);
}
// Correct a moment before keeping it: its context timeline (title, dates, period, place, notes, links).
export async function editContext(event,timeline){
 const answer=await post(`/api/secretary/history/${event.core.id}/context`,{revision:event.contextRevision,changes:{timeline}});
 return adopt(answer.entry);
}
// Correct a kept souvenir: date, people, places or text; its sources never change.
export async function correctSouvenir(event,changes){
 const id=event.core.souvenirNoteId,entry=raw.get(event.core.id);
 if(!id||!entry)throw new Error('Ce moment n’est pas encore un souvenir gardé.');
 const body={revision:event.core.souvenir?.revision??0};
 if(changes.eventDate!==undefined)Object.assign(body,changes.eventDate?{eventDate:changes.eventDate,eventDatePrecision:'day'}:{eventDate:'',eventDatePrecision:'unknown'});
 for(const key of ['people','places','text'])if(changes[key]!==undefined)body[key]=changes[key];
 const {souvenir:s}=await post(`/api/secretary/souvenirs/${id}`,body);
 return adopt(entry,{...entry.souvenir,id:s.id,revision:s.revision,text:s.text,eventDate:s.eventDate,eventDatePrecision:s.eventDatePrecision,people:s.people,places:s.places,historyContext:s.historyContext||entry.souvenir?.historyContext||null});
}

const sourceCache=new Map();
export async function readSource(id,{offset=0}={}){
 if(demoSources[id])return demoSources[id];
 const key=`${id}@${offset}`;if(sourceCache.has(key))return sourceCache.get(key);
 const ref=parseSourceId(id);if(!ref)throw new Error('Source inconnue.');
 let value;
 if(ref.system==='gmail')value=projectArchive(id,await call(`/api/secretary/archive/${encodeURIComponent(ref.messageId)}?sha256=${ref.sourceSha256}&offset=${offset}`));
 else if(ref.system==='outlook-export')value={id,kind:'mail',subject:'Message Outlook archivé',body:'Ce message vient de l’export Outlook conservé par Secretary. Core garde son empreinte; la lecture de ce format n’est pas encore offerte.',bodySha256:ref.sourceSha256};
 else{
  const {source}=await call(`/api/secretary/history/${ref.entryId}/sources/${encodeURIComponent(ref.sourceId)}`);
  // The original file, when the household library or the Datalake still holds it unchanged.
  const file=source.nativePath?await call(`/api/secretary/files/read?nativePath=${encodeURIComponent(source.nativePath)}&sha256=${source.contentSha256||''}`).catch(()=>null):null;
  value=projectContextSource(id,source,file);
 }
 sourceCache.set(key,value);return value;
}

export async function recall(query){return projectRecall((await call(`/api/secretary/recall/search?limit=12&query=${encodeURIComponent(query)}`)).results);}
export async function people(query,limit=5){return call(`/api/secretary/people?limit=${limit}&query=${encodeURIComponent(query)}`);}
export async function person(id){return call(`/api/secretary/people/${encodeURIComponent(id)}`);}
export async function readCoverage(){return (await call('/api/secretary/desk')).mail?.catchup||null;}
export async function photoCount(){return call('/api/photos/count');}
export async function photoSearch(filters={}){
 const query=new URLSearchParams({limit:'30',order:'asc'});
 for(const key of ['text','city','person','from','to','cursor'])if(filters[key])query.set(key,filters[key]);
 return call(`/api/photos/search?${query}`);
}
