import {temporalExtent,DAY} from './temporal.js';

// Reading scopes change the view, never the source or a person's review state.
export function isLifeMoment(event){if(event.core?.souvenirNoteId)return true;if(['thirdparty','unknown'].includes(event.metadata?.subject))return false;return !!event.curated||!!event.timeline?.legacyId||event.extractionPass>=2;}
export function lifeDomain(events,{now=Date.now(),all=false}={}){
 const candidates=(all?events:events.filter(isLifeMoment)).map(e=>temporalExtent(e,now)).filter(Boolean);
 const bounds=(candidates.length?candidates:events.map(e=>temporalExtent(e,now)).filter(Boolean));
 const starts=bounds.map(t=>t.start).filter(t=>all||t<=now);
 const ends=bounds.map(t=>t.end-1).filter(t=>all||t<=now);
 const start=starts.length?Math.min(...starts):now;
 const end=Math.max(now,...ends);
 return [Date.UTC(new Date(start).getUTCFullYear(),0,1),Date.UTC(new Date(end).getUTCFullYear()+1,0,1)];
}
export function contextualIssues(event,domain,{now=Date.now()}={}){
 const issues=[],extent=temporalExtent(event);
 if(!extent)issues.push({kind:'undated',label:'Date à préciser'});
 if(extent&&extent.end<=domain[0])issues.push({kind:'before',label:'Antérieur aux premiers repères de vie'});
 if(extent&&extent.start>now+DAY)issues.push({kind:'future',label:'Date future · réalisation à vérifier'});
 if(event.core?.kind==='action')issues.push({kind:'action',label:'Action à faire · événement à distinguer'});
 if(event.occurrenceStatus==='planned')issues.push({kind:'planned',label:'Prévu · présence à confirmer'});
 if(event.occurrenceStatus==='cancelled')issues.push({kind:'cancelled',label:'Annulé dans la source'});
 if(event.metadata?.subject==='thirdparty')issues.push({kind:'subject',label:'Concerne une autre personne'});
 if(event.metadata?.subject==='unknown')issues.push({kind:'subject',label:'Personne concernée à préciser'});
 return issues;
}
