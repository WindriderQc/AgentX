// Projects Core's personal history onto the Atlas timeline. Nothing is stored:
// every view is rebuilt from Core's entries and souvenirs.

const kindLabels={fact:'Information retrouvée',calendar:'Rendez-vous ou événement',contact:'Contact',deliverable:'Document ou livrable',invoice:'Facture',action:'Action à faire'};
const systemLabels={gmail:'Courriel Gmail','outlook-export':'Courriel Outlook',document:'Document',media:'Photo',ledger:'Grand livre',testimony:'Ton témoignage',conversation:'Conversation',calendar:'Calendrier'};
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
 if(['year','month'].includes(entry.eventDatePrecision)&&entry.eventDate){const a=anchor(entry.eventDate,entry.eventDatePrecision);if(a.date)return {...a,dateOrigin:'core'};}
 if(entry.eventDatePrecision==='day'&&/^\d{4}-\d{2}-\d{2}$/.test(entry.eventDate||''))return {date:entry.eventDate,precision:'day',dateOrigin:'core'};
 if(entry.eventDatePrecision==='instant'&&entry.eventDate){const day=torontoDay(entry.eventDate);if(day)return {date:day,precision:'day',dateOrigin:'core'};}
 const written=String(entry.eventDateAsWritten||'').trim();
 let m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(written);
 if(m&&torontoDay(`${written}T12:00:00Z`)===written)return {date:written,precision:'day',dateOrigin:'written'};
 m=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(written);if(m)return {date:`${m[1]}-${m[2]}-15`,precision:'month',dateOrigin:'written'};
 m=/^(1[89]\d{2}|20\d{2})$/.exec(written);if(m)return {date:`${m[1]}-07-01`,precision:'year',dateOrigin:'written'};
 return {date:null,precision:'unknown',dateOrigin:'none'};
}

// A source id is "gmail|<sha256>|<message id>", "outlook-export|<sha256>|", or
// "ctx|<entry id>|<source id>" for a source record kept in a history context.
export function sourceId(source){
 if(!source||!/^[a-f0-9]{64}$/.test(source.sourceSha256||''))return null;
 if(source.system==='gmail')return /^[a-zA-Z0-9_-]{8,256}$/.test(source.messageId||'')?`gmail|${source.sourceSha256}|${source.messageId}`:null;
 if(source.system==='outlook-export')return `outlook-export|${source.sourceSha256}|`;
 return null;
}
export const contextSourceId=(entryId,id)=>`ctx|${entryId}|${id}`;
export function parseSourceId(id){
 const [system,first,...rest]=String(id||'').split('|'),detail=rest.join('|');
 if(system==='ctx')return /^[a-f0-9]{24}$/.test(first||'')&&detail?{system,entryId:first,sourceId:detail}:null;
 if(!['gmail','outlook-export'].includes(system)||!/^[a-f0-9]{64}$/.test(first||''))return null;
 return {system,sourceSha256:first,messageId:detail};
}
const kindNames={mail:'Courriel',document:'Document',media:'Photo ou vidéo',ledger:'Écriture du grand livre',testimony:'Ton témoignage',conversation:'Conversation',calendar:'Calendrier',unknown:'Source'};
export const sourceLabel=system=>systemLabels[system]||kindNames[system]||'Source';

// Partial dates keep their precision; the timeline draws an uncertainty window.
function anchor(value,precision){
 const text=String(value||'');
 if(precision==='year'&&/^\d{4}/.test(text))return {date:`${text.slice(0,4)}-07-01`,precision:'year'};
 if(precision==='month'&&/^\d{4}-\d{2}/.test(text))return {date:`${text.slice(0,7)}-15`,precision:'month'};
 if(['day','instant'].includes(precision)&&/^\d{4}-\d{2}-\d{2}/.test(text))return {date:precision==='instant'?torontoDay(text)||text.slice(0,10):text.slice(0,10),precision:'day'};
 return {date:null,precision:'unknown'};
}

function reviewStateOf(entry,displayMatchesContext=true){
 if(entry.reviewState==='dismissed')return 'dismissed';
 if(displayMatchesContext&&entry.assertionState==='confirmed'&&entry.confirmationCurrent!==false)return 'confirmed';
 if(entry.timeline?.hypothesis||entry.timeline?.claimType==='hypothesis'||entry.timeline?.reviewState==='hypothesis'||entry.timeline?.confirmationBasis==='owner-tentative')return 'hypothesis';
 return 'unreviewed';
}
const occurrence={planned:'planned',cancelled:'cancelled',reported:'reported'};
function titleOf(text){
 const clean=String(text||'').replace(/^\d{4}-\d{2}-\d{2} : /,'').replace(/\s+/g,' ').trim();
 const sentence=clean.split(/(?<=[.!?])\s/)[0];
 return (sentence.length<=110?sentence:`${clean.slice(0,107).replace(/\s+\S*$/,'')}…`)||'Relevé sans texte';
}

export function projectEntry(raw){
 const s=raw.souvenir,tl=raw.timeline,ctx=raw.context;
 // A newly kept souvenir snapshots the typed temporal context; keeping it is
 // not an exact date correction, nor a factual confirmation.
 const snapshot=s?.historyContext;
 const keptTime=snapshot?.temporal;
 const sameKeptDate=keptTime&&s.eventDatePrecision===keptTime.precision&&String(s.eventDate||'')===String(keptTime.date||'').slice(0,keptTime.precision==='year'?4:keptTime.precision==='month'?7:10);
 const useTimeline=Boolean(tl)&&(!s||snapshot&&sameKeptDate);
 const useContextText=Boolean(tl)&&(!s||snapshot&&!(s.revision>0)&&snapshot.contextRevision===raw.contextRevision);
 const time=useTimeline&&s?keptTime:tl;
 const base=s?{...raw,text:s.text||raw.text,eventDate:s.eventDate,eventDatePrecision:s.eventDatePrecision,people:s.people||raw.people,places:s.places||raw.places}:raw;
 const system=raw.source?.system||'';
 const contextSources=(ctx?.sources||[]).map(src=>({...src,atlasId:contextSourceId(raw.id,src.id)}));
 const byContextId=new Map(contextSources.map(src=>[src.id,src.atlasId]));
 const native=[raw.source,...(raw.relatedSources||[])].filter(Boolean).map(sourceId).filter(Boolean);
 const sources=[...new Set([...native,...contextSources.map(src=>src.atlasId)])];
 let when=projectDate(base),end=null;
 if(useTimeline){const a=anchor(time.date,time.precision);when={...a,dateOrigin:a.date?'core':'none'};}
 else if(s&&['year','month'].includes(s.eventDatePrecision)){const a=anchor(s.eventDate,s.eventDatePrecision);when={...a,dateOrigin:'core'};}
 if(time?.endDate)end=anchor(time.endDate,time.endPrecision||time.precision);
 const testimony=tl?.confirmationBasis==='owner-testimony';
 const text=String(base.text||'').replace(/^\d{4}(?:-\d{2}){0,2} : /,'');
 const quotes=(tl?.claimsWithExactQuotes||[]).map(q=>({...q,sourceId:byContextId.get(q.sourceId)||q.sourceId}));
 const calendarCorrected=Boolean(s)&&!useTimeline;
 const canConfirm=!s||Boolean(snapshot&&snapshot.contextRevision===raw.contextRevision&&!(s.revision>0)&&sameKeptDate);
 return {
  id:`core-${raw.id}`,title:useContextText?tl.title:titleOf(text),description:useContextText?(tl.description||text):text,
  date:when.date,precision:when.precision,dateOrigin:when.dateOrigin,originalDate:tl?.originalDate||raw.eventDateAsWritten||'',
  endDate:end?.date||null,endPrecision:end?.precision,ongoing:time?.ongoing===true,
  dateWindow:calendarCorrected?null:time?.dateWindow||null,ageStartWindow:calendarCorrected?null:time?.ageStartWindow||null,ageEndWindow:time?.ageEndWindow||null,
  ageDateNote:calendarCorrected?null:time?.ageDateNote,dateEstimateNote:calendarCorrected?null:time?.dateEstimateNote,ownerTimeLabel:calendarCorrected?null:time?.ownerTimeLabel,
  eventTime:calendarCorrected?undefined:tl?.eventTime,metadata:tl?.metadata||{},claimType:tl?.claimType,
  category:tl?.category||proposeCategory(base),importance:raw.souvenirNoteId?5:testimony?4:raw.kind==='fact'?3:2,
  status:testimony?'Ton témoignage':tl?.status||kindLabels[raw.kind]||'Relevé',sourceIds:sources,
  correspondent:raw.actor||(base.people||[]).join(', '),subject:`${sourceLabel(system)}${raw.sourceDate?` · ${torontoDay(raw.sourceDate)||''}`:''}`,
  place:tl&&!s?(tl.place||(base.places||[]).join(', ')):(base.places||[]).join(', '),people:base.people||[],
  threadId:raw.source?.threadId||null,sourceDate:raw.sourceDate,attachments:0,origin:'agentx-core',
  reviewState:reviewStateOf(raw,canConfirm),
  occurrenceStatus:tl?.occurrenceStatus&&tl.occurrenceStatus!=='unknown'?tl.occurrenceStatus:occurrence[raw.assertionState],
  confirmationBasis:testimony?'owner-testimony':tl?.confirmationBasis==='owner-tentative'?'owner-tentative':undefined,
  rationale:tl?.rationale,notes:tl?.notes,reviewQuestions:tl?.reviewQuestions||[],contradictions:tl?.contradictions||[],links:tl?.links||[],
  relatedEventIds:(tl?.relatedEventIds||[]).map(id=>`core-${id}`),claimsWithExactQuotes:quotes,
  evidenceCheck:quotes.length?{status:'passed',quoteCount:quotes.length}:undefined,
  legacyId:tl?.legacyId||'',legacyIds:tl?.legacyIds||[],curated:Boolean(tl),narrative:tl?.narrative||null,findingId:raw.source?.findingId||'',
  contextSources,media:ctx?.media||[],contextRelations:ctx?.relations||[],
  contextRevision:raw.contextRevision||0,reviewUpdatedAt:ctx?.ownerEditedAt||null,
  core:{id:raw.id,revision:raw.revision,kind:raw.kind,reviewState:raw.reviewState,assertionState:raw.assertionState,
   confirmationCurrent:raw.confirmationCurrent,recordedAssertionState:raw.recordedAssertionState,
   souvenirContextCurrent:snapshot? snapshot.contextRevision===raw.contextRevision:null,
   canConfirm,
   souvenirNoteId:raw.souvenirNoteId||'',sourceStatus:raw.sourceStatus||'',sourceSystem:system,contextual:Boolean(tl),
   gmailUrl:raw.gmailUrl||null,decidedAt:raw.decision?.at||null,canKeep:raw.kind!=='action'&&!raw.souvenirNoteId,
   canDismiss:raw.reviewState!=='dismissed'&&!raw.souvenirNoteId,canEdit:Boolean(tl)&&!raw.souvenirNoteId,
   souvenir:s?{id:s.id,revision:s.revision??0}:raw.souvenirNoteId?{id:raw.souvenirNoteId,revision:null}:null},
  link:raw.souvenirNoteId?`#souvenir:${raw.souvenirNoteId}`:`#entry:${raw.id}`
 };
}

// Photos bound to moments in their history context, served from the household library.
export function eventAliases(events){
 return new Map(events.flatMap(e=>[e.id,e.core?.id,e.legacyId,...e.legacyIds||[]].filter(Boolean).map(id=>[id,e.id])));
}
export function collectMedia(events){
 const byLegacy=eventAliases(events);
 const photos=new Map();
 for(const e of events)for(const m of e.media||[]){
  const assetId=m.assetId||m.provenance?.assetId;
  const native=m.provenance?.system==='agentx.photos'&&/^[a-f0-9-]{36}$/.test(assetId||'');
  if(!native&&(!m.originalPath||!/^[a-f0-9]{64}$/.test(m.sourceContentSha256||'')))continue;
  const row=photos.get(m.id)||{id:m.id,assetId:native?assetId:null,eventIds:new Set(),url:native?`/api/photos/assets/${assetId}/thumbnail?size=preview`:`/api/secretary/files/content?nativePath=${encodeURIComponent(m.originalPath)}&sha256=${m.sourceContentSha256}`,
   caption:m.caption||'',album:m.album||'',date:null,precision:'unknown',associationBasis:m.associationBasis||'',dateBasis:m.dateBasis||'',dateNote:m.dateNote||'',cover:m.cover===true,filename:m.filename||m.originalPath?.split('/').pop()||'Photo'};
  for(const legacy of m.candidateEventIds||[])if(byLegacy.has(legacy))row.eventIds.add(byLegacy.get(legacy));
  const a=anchor(m.date,m.datePrecision);if(a.date&&(!row.date||a.date<row.date)){row.date=a.date;row.precision=a.precision;}
  photos.set(m.id,row);
 }
 return [...photos.values()].map(p=>({...p,eventIds:[...p.eventIds]}));
}

// Comparisons Core's data supports without a model: entries citing the same
// source, and entries naming the same person on the same day.
export function buildRelations(events,{maxGroup=12}={}){
 const relations=[],seen=new Set(),byId=new Map(events.map(e=>[e.id,e]));
 const add=(kind,key,ids,title,summary,limits,sourceIds=[],extra={})=>{
  const eventIds=[...new Set(ids)].sort();if(eventIds.length<(extra.recorded?1:2)||eventIds.length>maxGroup&&!extra.recorded)return;
  const signature=extra.recorded?`recorded:${key}`:`${kind}:${eventIds.join(',')}`;if(seen.has(signature))return;seen.add(signature);
  relations.push({id:`${kind}-${relations.length+1}`,kind,key,title,summary,limits,eventIds,sourceIds,quoteCount:0,claimsWithExactQuotes:[],nativeRecordCount:null,...extra});
 };
 // Relations recorded with the history context, with their quoted evidence.
 const byLegacy=eventAliases(events),known=new Set();
 for(const e of events)for(const r of e.contextRelations||[]){
  if(known.has(r.id))continue;known.add(r.id);
  const ids=(r.eventIds||[]).map(legacy=>byLegacy.get(legacy)).filter(Boolean);
  const claims=(r.claimsWithExactQuotes||[]).map(q=>({...q,sourceId:contextSourceId(e.core.id,q.sourceId)}));
  add(r.kind,r.id,ids,r.title,r.summary||'',r.limits||'',[...new Set(claims.map(q=>q.sourceId))],{id:`recorded-${r.id}`,recorded:true,rationale:r.rationale||'',sourceIndependence:r.sourceIndependence,checkedAt:r.provenance?.checkedAt,nativeRecordCount:r.provenance?.nativeRecordCount??null,contextLegacyEventRefs:r.contextLegacyEventRefs||[],claimsWithExactQuotes:claims,quoteCount:claims.length});
 }
 const bySource=new Map();
 for(const e of events)for(const s of e.sourceIds){if(!bySource.has(s))bySource.set(s,[]);bySource.get(s).push(e.id);}
 for(const [source,ids]of bySource)add('hypothesis',source,ids,`Une même source citée par ${new Set(ids).size} moments`,
  'Ces moments s’appuient sur la même source. La relire aide à voir s’ils décrivent un seul moment ou plusieurs.',
  'Une source peut porter plusieurs informations distinctes : ce lien ne prouve pas qu’elles décrivent le même événement.',[source]);
 const byDay=new Map();
 for(const e of events)if(e.date&&e.precision==='day')for(const p of e.people||[]){const key=`${e.date}|${fold(p)}`;if(!byDay.has(key))byDay.set(key,{person:p,ids:[]});byDay.get(key).ids.push(e.id);}
 for(const [key,{person,ids}]of byDay){
  const sources=[...new Set(ids.flatMap(id=>byId.get(id).sourceIds))];
  add('hypothesis',key,ids,`${person} · ${key.slice(0,10)}`,`Plusieurs moments nomment ${person} le même jour.`,
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
   toReview:events.filter(e=>['unreviewed','hypothesis'].includes(e.reviewState)).length,
   retained:events.filter(e=>['retained','resolved'].includes(e.core.reviewState)).length,dismissed:events.filter(e=>e.reviewState==='dismissed').length,
   testimony:events.filter(e=>['owner-testimony','owner-tentative'].includes(e.confirmationBasis)).length}};
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
// A source record kept in a history context, as the source panel shows it.
export function projectContextSource(id,source,file){
 const base={id,kind:source.kind==='media'?'photo':source.kind,subject:source.subject||kindNames[source.kind]||'Source',date:source.date||'',
  body:source.body||'',metadataOnly:source.metadataOnly===true,bodySha256:source.bodySha256,from:source.authority==='direct-owner-statement'?'Toi':'',
  bodyScope:source.provenance?.bodyScope||'',nativeRef:source.nativeRef||null,originalBinaryRead:source.provenance?.originalBinaryRead};
 if(file?.kind==='folder')return {...base,images:file.images||[]};
 if(file?.kind==='photo')return {...base,images:[{name:file.title,url:file.url}]};
 if(file?.kind==='document')return {...base,fileUrl:file.url,fileType:file.type,bytes:file.bytes};
 return base;
}

export function projectRecall(results=[]){
 return results.map(r=>({id:r.source?.messageId?sourceId({system:'gmail',messageId:r.source.messageId,sourceSha256:r.source.sourceSha256}):r.documentId,
  subject:r.title||'Document retrouvé',from:(r.people||[]).join(', '),date:r.occurredAt||'',kind:r.kind||'',
  excerpt:String(r.excerpt||'').slice(0,400),score:r.score,filename:r.source?.filename||'',personId:r.personId||null,souvenirNoteId:r.souvenirNoteId||null}));
}
