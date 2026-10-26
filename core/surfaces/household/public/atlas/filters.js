// Filters describe recorded attribution and occurrence. Unknown stays unknown;
// neither a calendar status nor a retained memory establishes attendance.
export function matchesSubject(event,filter='all'){
 const subject=event.metadata?.subject;
 if(filter==='all')return true;
 if(filter==='unknown')return subject==='unknown'||!subject;
 return subject===filter;
}
export function matchesIntent(event,filter='all'){
 const intention=event.core?.kind==='action'||['planned','cancelled'].includes(event.occurrenceStatus);
 if(filter==='intentions')return intention;
 if(filter==='without-intentions')return !intention;
 if(filter==='reported')return !intention&&['reported','occurred','confirmed'].includes(event.occurrenceStatus);
 return true;
}
