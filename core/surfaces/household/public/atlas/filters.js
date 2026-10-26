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
export function matchesReview(event,filter='active'){
 const state=event.reviewState||'unreviewed';
 if(filter==='all')return true;
 if(filter==='active')return state!=='dismissed';
 if(filter==='pending')return ['unreviewed','hypothesis'].includes(state);
 if(filter==='documented')return !['hypothesis','dismissed'].includes(state);
 return state===filter;
}
