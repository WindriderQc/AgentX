// The Atlas reads and writes the owner's history through Core only. Raw
// entries are kept for the page's lifetime so a decision can be reflected
// without a full reread; nothing is stored in the browser.
import {projectEntry,buildRelations,summarize,parseSourceId,projectArchive,projectOwnerSource,projectRecall} from './projection.js';
import {demoEvents,demoSources} from './demo.js';

const raw=new Map();
let meta=null;

async function call(url,options={}){
 let response;
 try{response=await fetch(url,{credentials:'same-origin',...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});}
 catch{throw new Error('AgentX ne répond pas pour le moment.');}
 const answer=await response.json().catch(()=>({}));
 if(!response.ok||answer.status!=='success'){
  const error=new Error(response.status===409?'Ce moment a changé dans AgentX depuis l’ouverture de la page. Recharge la page avant de décider.'
   :response.status===403?'Cette page est réservée au profil du propriétaire.':answer.message||'AgentX a refusé la demande.');
  error.status=response.status;throw error;
 }
 return answer.data;
}
const post=(url,body)=>call(url,{method:'POST',body:JSON.stringify(body)});

function rebuild(){
 const events=[...raw.values()].map(projectEntry);
 meta={...summarize(events,{readAt:meta?.fetchedAt,total:events.length}),relations:buildRelations(events),ownerContributions:meta?.ownerContributions||null,statements:meta?.statements||[]};
 return {meta,events};
}

// The owner's own story, in the order told: chapters kept with the statements,
// their items mapped to history entries by the importer's finding ids.
function contributions(statements,events){
 const byFinding=new Map(events.filter(e=>e.findingId).map(e=>[e.findingId,e.id]));
 const chapters=statements.map(s=>s.chapter).filter(c=>c&&Array.isArray(c.paths)).map(c=>({...c,
  paths:c.paths.map(p=>({...p,items:(p.items||[]).map(i=>({...i,id:byFinding.get(i.findingId)})).filter(i=>i.id)})),
  pendingDates:(c.pendingDates||[]).map(i=>({...i,id:byFinding.get(i.findingId)})).filter(i=>i.id)}));
 return chapters.length?{chapters,events:events.filter(e=>e.confirmationBasis==='owner-testimony').length}:null;
}

export async function loadHistory(){
 const [timeline,statements]=await Promise.all([call('/api/secretary/history/timeline'),call('/api/secretary/statements').catch(()=>({statements:[]}))]);
 raw.clear();for(const entry of timeline.entries)raw.set(entry.id,entry);
 meta={fetchedAt:timeline.readAt,statements:statements.statements};
 const result=rebuild();
 meta.ownerContributions=contributions(statements.statements,result.events);
 result.meta=meta;
 return result;
}

export function loadDemo(){
 return {meta:{events:demoEvents.length,dated:demoEvents.length,undated:0,source:'Scénario fictif · Camille',demo:true,relations:[]},events:demoEvents};
}

function adopt(entry){raw.set(entry.id,entry);return {...rebuild(),event:projectEntry(entry)};}

// Keep a moment as a souvenir in the owner's memory (Core's own route).
export async function keepSouvenir(event,{eventDate}={}){
 const body={revision:event.core.revision,...(eventDate?{eventDate,eventDatePrecision:'day'}:{})};
 const answer=await post(`/api/secretary/history/${event.core.id}/souvenir`,body);
 const entry=answer.entry;
 // The history row and the new note together give the souvenir's current values.
 const note=await call(`/api/secretary/souvenirs/${answer.souvenirNoteId}`).then(r=>r.souvenir).catch(()=>null);
 return adopt({...entry,...(note?{souvenir:{id:note.id,revision:note.revision,text:note.text,eventDate:note.eventDate,eventDatePrecision:note.eventDatePrecision,people:note.people,places:note.places}}:{})});
}
export async function dismiss(event,reason){
 const answer=await post(`/api/secretary/history/${event.core.id}/review`,{revision:event.core.revision,state:'dismissed',reason:reason||'Écarté depuis Life Atlas'});
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
 return adopt({...entry,souvenir:{id:s.id,revision:s.revision,text:s.text,eventDate:s.eventDate,eventDatePrecision:s.eventDatePrecision,people:s.people,places:s.places}});
}

const sourceCache=new Map();
export async function readSource(id,{offset=0}={}){
 if(demoSources[id])return demoSources[id];
 const key=`${id}@${offset}`;if(sourceCache.has(key))return sourceCache.get(key);
 const ref=parseSourceId(id);if(!ref)throw new Error('Source inconnue.');
 let value;
 if(ref.system==='gmail')value=projectArchive(id,await call(`/api/secretary/archive/${encodeURIComponent(ref.messageId)}?sha256=${ref.sourceSha256}&offset=${offset}`));
 else if(ref.system==='outlook-export')value={id,kind:'mail',subject:'Message Outlook archivé',body:'Ce message vient de l’export Outlook conservé par Secretary. Core garde son empreinte; la lecture de ce format n’est pas encore offerte.',bodySha256:ref.sourceSha256};
 else value=projectOwnerSource(id,await call(`/api/secretary/sources/read?system=${ref.system}&sha256=${ref.sourceSha256}${ref.locator?`&locator=${encodeURIComponent(ref.locator)}`:''}`));
 sourceCache.set(key,value);return value;
}

export async function recall(query){return projectRecall((await call(`/api/secretary/recall/search?limit=12&query=${encodeURIComponent(query)}`)).results);}
export async function people(query,limit=5){return call(`/api/secretary/people?limit=${limit}&query=${encodeURIComponent(query)}`);}
export async function person(id){return call(`/api/secretary/people/${encodeURIComponent(id)}`);}
