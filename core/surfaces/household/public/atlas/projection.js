// Projects Core's personal history onto the Atlas timeline. Nothing is stored:
// every view is rebuilt from Core's entries and souvenirs.

const kindLabels={fact:'Information retrouvée',calendar:'Rendez-vous ou événement',contact:'Contact',deliverable:'Document ou livrable',invoice:'Facture',action:'Action à faire'};
const systemLabels={gmail:'Courriel Gmail','outlook-export':'Courriel Outlook','owner-statement':'Ton témoignage','core-record':'Enregistrement AgentX','owner-file':'Fichier du foyer'};
export const fold=value=>String(value||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();

// The category is a reading aid proposed from the text, never Core's assertion.
const categoryWords=[
 ['health',['sante','medec','hopital','clinique','dentist','pharmac','vaccin','chirurg','therap','docteur','health','doctor','hospital']],
 ['travel',['voyage','vol ','avion','hotel','vacance','croisiere','aeroport','billet','camping','flight','trip','travel','airbnb']],
 ['home',['maison','appartement','demenag','bail','loyer','hypothe','renovat','condo','propriet','notaire','adresse','rue ','house','mortgage','lease']],
 ['work',['emploi','travail','contrat','client','employeur','embauche','projet','poste','salaire','formation','diplome','ecole','cours','universit','cegep','work','job','contract','school']],
 ['people',['anniversaire','mariage','naissance','bebe','famille','enfant','fille','fils','pere','mere','soeur','frere','ami','funerail','deces','birthday','wedding','family']]
];
export function proposeCategory(entry){
 const text=fold(`${entry.text} ${(entry.places||[]).join(' ')}`);
 for(const [category,words]of categoryWords)if(words.some(w=>text.includes(w)))return category;
 if(entry.kind==='contact'||entry.people?.length)return 'people';
 return 'daily';
}

const torontoDay=iso=>{const t=Date.parse(iso);return Number.isFinite(t)?new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(t):null;};
// Core's event date, else a day, month or year written in the source. Never the
// source's own date: an undated memory stays undated.
export function projectDate(entry){
 if(entry.eventDatePrecision==='day'&&/^\d{4}-\d{2}-\d{2}$/.test(entry.eventDate||''))return {date:entry.eventDate,precision:'day',dateOrigin:'core'};
 if(entry.eventDatePrecision==='instant'&&entry.eventDate){const day=torontoDay(entry.eventDate);if(day)return {date:day,precision:'day',dateOrigin:'core'};}
 const written=String(entry.eventDateAsWritten||'').trim();
 let m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(written);
 if(m&&torontoDay(`${written}T12:00:00Z`)===written)return {date:written,precision:'day',dateOrigin:'written'};
 m=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(written);if(m)return {date:`${m[1]}-${m[2]}-15`,precision:'month',dateOrigin:'written'};
 m=/^(1[89]\d{2}|20\d{2})$/.exec(written);if(m)return {date:`${m[1]}-07-01`,precision:'year',dateOrigin:'written'};
 return {date:null,precision:'unknown',dateOrigin:'none'};
}

// A source id is "<system>|<sha256>|<locator or message id>".
export function sourceId(source){
 if(!source||!/^[a-f0-9]{64}$/.test(source.sourceSha256||''))return null;
 if(source.system==='gmail')return /^[a-zA-Z0-9_-]{8,256}$/.test(source.messageId||'')?`gmail|${source.sourceSha256}|${source.messageId}`:null;
 if(!systemLabels[source.system])return null;
 return `${source.system}|${source.sourceSha256}|${source.locator||''}`;
}
export function parseSourceId(id){
 const [system,sha256,...rest]=String(id||'').split('|'),detail=rest.join('|');
 if(!systemLabels[system]||!/^[a-f0-9]{64}$/.test(sha256||''))return null;
 return system==='gmail'?{system,sourceSha256:sha256,messageId:detail}:{system,sourceSha256:sha256,locator:detail};
}
export const sourceLabel=system=>systemLabels[system]||'Source';
export const isPhotoSource=id=>/^owner-file\|[a-f0-9]{64}\|photos:/.test(id||'');

function reviewStateOf(entry){
 if(entry.reviewState==='dismissed')return 'dismissed';
 if(['retained','resolved'].includes(entry.reviewState)||entry.souvenirNoteId)return 'confirmed';
 return 'unreviewed';
}
const occurrence={planned:'planned',cancelled:'cancelled',reported:'reported',confirmed:'reported'};
function titleOf(text){
 const clean=String(text||'').replace(/^\d{4}-\d{2}-\d{2} : /,'').replace(/\s+/g,' ').trim();
 const sentence=clean.split(/(?<=[.!?])\s/)[0];
 return (sentence.length<=110?sentence:`${clean.slice(0,107).replace(/\s+\S*$/,'')}…`)||'Relevé sans texte';
}

export function projectEntry(raw){
 const s=raw.souvenir;
 const entry=s?{...raw,text:s.text||raw.text,eventDate:s.eventDate,eventDatePrecision:s.eventDatePrecision,people:s.people||raw.people,places:s.places||raw.places}:raw;
 const when=projectDate(entry);
 const cited=[entry.source,...(entry.relatedSources||[])].filter(Boolean);
 const sources=[...new Set(cited.map(sourceId).filter(Boolean))];
 const people=entry.people||[],system=entry.source?.system||'';
 const testimony=system==='owner-statement';
 return {
  id:`core-${entry.id}`,title:titleOf(entry.text),description:String(entry.text||'').replace(/^\d{4}-\d{2}-\d{2} : /,''),
  date:when.date,precision:when.precision,dateOrigin:when.dateOrigin,originalDate:entry.eventDateAsWritten||'',
  category:proposeCategory(entry),importance:entry.souvenirNoteId?5:testimony?4:entry.kind==='fact'?3:2,
  status:testimony?'Ton témoignage':kindLabels[entry.kind]||'Relevé',sourceIds:sources,
  correspondent:entry.actor||people.join(', '),subject:`${sourceLabel(system)}${entry.sourceDate?` · ${torontoDay(entry.sourceDate)||''}`:''}`,
  place:(entry.places||[]).join(', '),people,threadId:entry.source?.threadId||null,sourceDate:entry.sourceDate,attachments:0,origin:'agentx-core',
  reviewState:reviewStateOf(entry),occurrenceStatus:occurrence[entry.assertionState],
  confirmationBasis:testimony?'owner-testimony':undefined,findingId:entry.source?.findingId||'',
  photoSourceIds:sources.filter(isPhotoSource),
  core:{id:entry.id,revision:entry.revision,kind:entry.kind,reviewState:entry.reviewState,assertionState:entry.assertionState,
   souvenirNoteId:entry.souvenirNoteId||'',sourceStatus:entry.sourceStatus||'',sourceSystem:system,
   gmailUrl:entry.gmailUrl||null,decidedAt:entry.decision?.at||null,canKeep:entry.kind!=='action'&&!entry.souvenirNoteId,
   canDismiss:entry.reviewState!=='dismissed'&&!entry.souvenirNoteId,
   souvenir:s?{id:s.id,revision:s.revision??0}:entry.souvenirNoteId?{id:entry.souvenirNoteId,revision:null}:null},
  link:entry.souvenirNoteId?`#souvenir:${entry.souvenirNoteId}`:`#entry:${entry.id}`
 };
}

// Comparisons Core's data supports without a model: entries citing the same
// source, and entries naming the same person on the same day.
export function buildRelations(events,{maxGroup=12}={}){
 const relations=[],seen=new Set(),byId=new Map(events.map(e=>[e.id,e]));
 const add=(kind,key,ids,title,summary,limits,sourceIds=[])=>{
  const eventIds=[...new Set(ids)].sort();if(eventIds.length<2||eventIds.length>maxGroup)return;
  const signature=`${kind}:${eventIds.join(',')}`;if(seen.has(signature))return;seen.add(signature);
  relations.push({id:`${kind}-${relations.length+1}`,kind,key,title,summary,limits,eventIds,sourceIds,quoteCount:0,claimsWithExactQuotes:[],nativeRecordCount:sourceIds.length});
 };
 const bySource=new Map();
 for(const e of events)for(const s of e.sourceIds){if(!bySource.has(s))bySource.set(s,[]);bySource.get(s).push(e.id);}
 for(const [source,ids]of bySource)add('hypothesis',source,ids,`Une même source citée par ${new Set(ids).size} moments`,
  'Ces moments s’appuient sur la même source. La relire aide à voir s’ils décrivent un seul moment ou plusieurs.',
  'Une source peut porter plusieurs informations distinctes : ce lien ne prouve pas qu’elles décrivent le même événement.',[source]);
 const byDay=new Map();
 for(const e of events)if(e.date&&e.precision==='day')for(const p of e.people||[]){const key=`${e.date}|${fold(p)}`;if(!byDay.has(key))byDay.set(key,{person:p,ids:[]});byDay.get(key).ids.push(e.id);}
 for(const [key,{person,ids}]of byDay){
  const sources=[...new Set(ids.flatMap(id=>byId.get(id).sourceIds))];
  add('agreement',key,ids,`${person} · ${key.slice(0,10)}`,`Plusieurs moments nomment ${person} le même jour.`,
   'Des copies d’un même message ne sont pas des témoignages indépendants.',sources.slice(0,12));
 }
 return relations;
}

export function summarize(events,{readAt,total}={}){
 const dated=events.filter(e=>e.date).map(e=>e.date).sort();
 const bySystem={};for(const e of events){const k=e.core.sourceSystem||'autre';bySystem[k]=(bySystem[k]||0)+1;}
 return {source:'AgentX Core · historique personnel',authority:'agentx.core',fetchedAt:readAt,
  events:events.length,dated:dated.length,undated:events.length-dated.length,firstDate:dated[0]||null,lastDate:dated.at(-1)||null,bySystem,
  core:{total:total??events.length,kept:events.filter(e=>e.core.souvenirNoteId).length,candidates:events.filter(e=>e.core.reviewState==='candidate').length,
   retained:events.filter(e=>['retained','resolved'].includes(e.core.reviewState)).length,dismissed:events.filter(e=>e.reviewState==='dismissed').length,
   testimony:events.filter(e=>e.confirmationBasis==='owner-testimony').length}};
}

// The archived original of a mail, as the source panel shows it.
export function projectArchive(id,archive){
 const h=archive.headers||{};
 return {id,kind:'mail',subject:h.Subject||'Sans objet',from:h.From||'',to:h.To||'',date:h.Date||'',
  body:archive.body||'',truncated:!!archive.bodyTruncated,nextOffset:archive.nextOffset??null,
  attachments:(archive.attachments||[]).map(a=>({filename:a.filename})),
  gmailUrl:archive.threadId?`https://mail.google.com/mail/#all/${encodeURIComponent(archive.threadId)}`:null,
  bodySha256:archive.sourceSha256,provenance:'Archive Secretary · vérifiée par empreinte'};
}
// A statement, Core record or household file, as the source panel shows it.
export function projectOwnerSource(id,read){
 const base={id,kind:read.kind,subject:read.title||sourceLabel(read.system),date:read.date||read.modifiedAt||'',bodySha256:id.split('|')[1]};
 if(read.kind==='folder')return {...base,images:read.images||[],body:''};
 if(read.kind==='photo')return {...base,images:[{name:read.title,url:read.url}],body:''};
 if(read.kind==='document')return {...base,body:'',fileUrl:read.url,fileType:read.type,bytes:read.bytes};
 return {...base,body:read.text||'',from:read.kind==='testimony'?'Toi':read.role==='user'?'Toi, dans une conversation':'',statement:read.statement||null};
}

export function projectRecall(results=[]){
 return results.map(r=>({id:r.source?.messageId?sourceId({system:'gmail',messageId:r.source.messageId,sourceSha256:r.source.sourceSha256}):r.documentId,
  subject:r.title||'Document retrouvé',from:(r.people||[]).join(', '),date:r.occurredAt||'',kind:r.kind||'',
  excerpt:String(r.excerpt||'').slice(0,400),score:r.score,filename:r.source?.filename||'',personId:r.personId||null,souvenirNoteId:r.souvenirNoteId||null}));
}
