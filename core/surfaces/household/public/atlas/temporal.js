// Calendar precision is an uncertainty window, never an invented duration.
export const DAY=86400000;
export const YEAR=365.2425*DAY;

export function dateBounds(value,precision='day'){
 if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
 const [y,m,d]=value.split('-').map(Number),check=new Date(Date.UTC(y,m-1,d));
 if(check.getUTCFullYear()!==y||check.getUTCMonth()!==m-1||check.getUTCDate()!==d)return null;
 const start=precision==='year'?Date.UTC(y,0,1):precision==='month'?Date.UTC(y,m-1,1):check.getTime();
 const end=precision==='year'?Date.UTC(y+1,0,1):precision==='month'?Date.UTC(y,m,1):start+DAY;
 return {start,end,precision};
}

// An age can span two calendar years. Keep that window separate from the
// owner's confirmation of the memory; a later date edit supersedes the window.
function eventBounds(event,end=false){
 const value=end?event.endDate:event.date,precision=end?(event.endPrecision||event.precision):event.precision;
 const ordinary=dateBounds(value,precision),window=event[end?'ageEndWindow':'ageStartWindow']||(!end?event.dateWindow:null);
 if(!ordinary||!window||typeof event[end?'endTime':'eventTime']==='string')return ordinary;
 const a=dateBounds(window.start),b=dateBounds(window.end);
 return a&&b&&b.start>a.start?{start:a.start,end:b.start,precision:'range'}:ordinary;
}

export function temporalExtent(event,now=Date.now()){
 const first=eventBounds(event);
 if(!first)return null;
 const last=event.endDate?eventBounds(event,true):null;
 const ongoing=event.ongoing===true;
 const hasDuration=ongoing||!!last&&last.end>first.start&&(event.endDate!==event.date||first.precision!=='day'||last.precision!=='day');
 if(hasDuration){
  const end=ongoing?Math.max(now,first.start):last.precision==='day'?Math.max(first.start+DAY,last.start):last.end;
  if(end<=first.start)return null;
  return {kind:'period',start:first.start,end,anchor:(first.start+end)/2,
   approximate:first.precision!=='day'||!ongoing&&last.precision!=='day',
   startApproximate:first.precision!=='day',endApproximate:!ongoing&&last.precision!=='day',
   startWindowEnd:first.end,endWindowStart:last?.start??end,ongoing};
 }
 return {kind:'point',start:first.start,end:first.end,anchor:(first.start+first.end)/2,
  approximate:first.precision!=='day',startApproximate:first.precision!=='day',endApproximate:false,ongoing:false};
}

export function intersects(extent,start,end){return !!extent&&extent.start<end&&extent.end>start;}

export function durationLabel(event,now=Date.now()){
 const extent=temporalExtent(event,now);
 if(!extent)return 'Date à préciser';
 if(extent.kind==='point')return event.dateWindow&&typeof event.eventTime!=='string'?'Année proposée · à valider':event.ageStartWindow&&typeof event.eventTime!=='string'?'Repère d’âge · date approximative':event.precision==='year'?'Année connue · jour à préciser':event.precision==='month'?'Mois connu · jour à préciser':'Repère daté · durée non renseignée';
 const first=eventBounds(event),last=event.endDate?eventBounds(event,true):null;
 const estimatedStart=extent.startApproximate?(first.start+first.end)/2:extent.start;
 const estimatedEnd=extent.endApproximate?(last.start+last.end)/2:extent.end;
 const days=Math.max(1,(estimatedEnd-estimatedStart)/DAY);
 let label;
 if(days>=365){const totalMonths=Math.round(days/30.4375),years=Math.floor(totalMonths/12),months=totalMonths%12;label=`${years} an${years>1?'s':''}${months?` ${months} mois`:''}`;}
 else if(days>=60)label=`${Math.round(days/30.4375)} mois`;
 else if(days>=2)label=`${Math.round(days)} jours`;
 else label='1 jour';
 return `${extent.approximate?'Environ ':''}${label}${extent.ongoing?' · en cours':''}`;
}

// Pack actual hit geometry; small intervals keep their true drawn width.
export function packPeriods(items,maxRows=3,gap=5){
 const ends=[],placed=[],overflow=[];
 for(const item of [...items].sort((a,b)=>a.hitLeft-b.hitLeft||b.width-a.width||String(a.event.id).localeCompare(String(b.event.id)))){
  let row=ends.findIndex(end=>end+gap<=item.hitLeft);
  if(row<0){if(ends.length>=maxRows){overflow.push(item);continue;}row=ends.length;}
  ends[row]=item.hitLeft+item.hitWidth;
  placed.push({...item,row});
 }
 return {placed,overflow,rows:ends.length};
}

export function groupPoints(items,spacing=20){
 const groups=[];
 for(const item of [...items].sort((a,b)=>a.x-b.x)){
  let group=groups.at(-1);
  if(!group||item.x-group.firstX>=spacing){group={items:[],firstX:item.x,x:0};groups.push(group);}
  group.items.push(item);group.x=group.items.reduce((sum,i)=>sum+i.x,0)/group.items.length;
 }
 return groups;
}

export function periodGeometry(extent,viewStart,viewEnd,left,plotWidth,minHit=14){
 const x=time=>left+(time-viewStart)/(viewEnd-viewStart)*plotWidth;
 const start=Math.max(viewStart,extent.start),end=Math.min(viewEnd,extent.end);
 const drawLeft=x(start),width=Math.max(0,x(end)-drawLeft),hitWidth=Math.max(minHit,width);
 const hitLeft=Math.max(left,Math.min(left+plotWidth-hitWidth,drawLeft+(width-hitWidth)/2));
 return {left:drawLeft,width,hitLeft,hitWidth,fillOffset:drawLeft-hitLeft,
  clippedStart:extent.start<viewStart,clippedEnd:extent.end>viewEnd};
}
