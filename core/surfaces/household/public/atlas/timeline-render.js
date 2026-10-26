import {categories,icon,escape,number,dateLabel} from './ui.js';
import {reviewState,reviewStates} from './review.js';
import {DAY,YEAR,temporalExtent,intersects,periodGeometry,packPeriods,groupPoints} from './temporal.js';
import {photosInRange,photoDate,collectPhotos} from './gallery.js';

const layer=event=>['hypothesis','dismissed'].includes(reviewState(event))?reviewState(event):'main';
export function renderTimeline(chart){
 const s=chart.api.state;if(!s.range)return;clearTimeout(chart.hoverTimer);chart.api.hidePreview?.();
 const [start,end]=s.range,span=end-start;
 chart.width=chart.root.clientWidth;chart.left=chart.width<700?104:135;
 const left=chart.left,plotWidth=Math.max(70,chart.width-left-22),x=time=>left+(time-start)/span*plotWidth;
 const coarse=matchMedia('(pointer:coarse)').matches,compact=!coarse&&span>20*YEAR&&innerHeight<1300,rowStep=coarse?44:compact?22:29;
 const items=s.filtered.filter(e=>s.categories.has(e.category)).map(event=>({event,extent:temporalExtent(event)})).filter(i=>intersects(i.extent,start,end));
 chart.visible=items.map(i=>i.event);chart.clusters=[];
 chart.root.classList.add('temporal-timeline');chart.root.classList.toggle('is-overview',compact);chart.root.style.setProperty('--label-width',`${left-10}px`);
 const html=[];
 if(s.scope==='life')for(const gap of s.meta.pass2?.gapIntervals||[]){const a=Math.max(start,Date.parse(gap.start)),b=Math.min(end,Date.parse(gap.end));if(b>a&&x(b)-x(a)>110)html.push(`<div class="coverage-gap" style="left:${x(a)}px;width:${x(b)-x(a)}px" aria-hidden="true"><span>${escape(gap.label)}</span></div>`);}
 if(span<=1.1*DAY)html.push(`<div class="time-header major" style="left:${left}px">${escape(new Intl.DateTimeFormat('fr-CA',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(start)))} · heures non précisées</div>`);
 else for(const tick of chart.ticks(start,end,plotWidth)){const px=x(tick.time);html.push(`<div class="grid-line" style="left:${px}px"></div><div class="time-header ${tick.major?'major':''}" style="left:${Math.min(chart.width-62,px+4)}px">${escape(tick.label)}</div>`);}
 const score=e=>(s.favorites.has(e.id)?20:0)+(reviewState(e)==='confirmed'?10:0)+(e.importance||1);
 const register=events=>{const lead=[...events].sort((a,b)=>score(b)-score(a)||a.ts-b.ts)[0],index=chart.clusters.length;chart.clusters.push({events,lead});return {lead,index};};
 let top=32;
 const photos=s.dataset==='demo'?[]:photosInRange(collectPhotos(s.events),s.range).sort((a,b)=>a.date.localeCompare(b.date));
 chart.photoGroups=[];
 if(photos.length){
  html.push(`<div class="timeline-photo-lane" style="top:${top}px"><span class="timeline-photo-label"><span>◇</span>Images</span></div>`);
  const groups=[];
  for(const photo of photos){const px=x(Date.parse(photo.date.slice(0,10)+'T12:00:00Z'));const previous=groups.at(-1);if(previous&&px-previous.x<42)previous.photos.push(photo);else groups.push({x:px,photos:[photo]});}
  for(const group of groups){const photo=group.photos[0],index=chart.photoGroups.length;chart.photoGroups.push(group.photos);html.push(`<button type="button" class="timeline-photo" data-timeline-photo="${escape(photo.id)}" data-photo-group="${index}" style="left:${Math.max(left,Math.min(left+plotWidth-36,group.x-18))}px;top:${top+6}px" aria-label="${group.photos.length>1?number(group.photos.length)+' images':'Photo'} : ${escape((photo.album||photo.caption||photo.filename))}, ${escape(photoDate(photo))}. Association proposée." title="${escape((photo.album||photo.caption||photo.filename))} · ${escape(photoDate(photo))}"><img src="${escape(photo.url)}" alt="" loading="lazy">${group.photos.length>1?`<span>+${group.photos.length-1}</span>`:''}</button>`);}
  top+=45;
 }
 for(const key of Object.keys(categories).filter(k=>s.categories.has(k))){
  const lane=items.filter(i=>i.event.category===key),cat=categories[key];
  const showEmptyLanes=span>2*YEAR&&['active','all'].includes(s.reviewFilter)&&(!s.evidenceFilter||s.evidenceFilter==='all')&&!s.query&&!s.favoritesOnly;
  if(!lane.length&&!showEmptyLanes)continue;
  let offset=top+(compact?8:12);const laneHtml=[];
  for(const kind of ['main','hypothesis','dismissed']){
   const current=lane.filter(i=>layer(i.event)===kind);if(!current.length)continue;
   const periods=current.filter(i=>i.extent.kind==='period').map(i=>({...i,...periodGeometry(i.extent,start,end,left,plotWidth,coarse?40:14)}));
   const bars=periods.filter(i=>i.width>=8),short=periods.filter(i=>i.width<8);
   const packed=packPeriods(bars,kind==='main'?3:2,coarse?8:5);
   for(const item of packed.placed){
    const {event,extent}=item,{index}=register([event]),state=reviewState(event);
    const classes=['moment','time-band',`is-${state}`,item.clippedStart?'continues-before':'',item.clippedEnd?'continues-after':'',extent.startApproximate?'approx-start':'',extent.endApproximate?'approx-end':'',extent.ongoing?'is-ongoing':'',event.occurrenceStatus==='planned'?'is-planned':'',s.connectedIds?.has(event.id)?'is-connected':'',chart.api.selectedId===event.id?'selected':''].filter(Boolean).join(' ');
    const fuzzStart=extent.startApproximate?Math.max(0,Math.min(item.width,x(Math.min(end,extent.startWindowEnd))-item.left)):0;
    const fuzzEnd=extent.endApproximate?Math.max(0,Math.min(item.width,item.left+item.width-x(Math.max(start,extent.endWindowStart)))):0;
    laneHtml.push(`<button type="button" class="${classes}" data-cluster="${index}" data-event-id="${escape(event.id)}" data-review="${state}" data-temporal="period" aria-haspopup="dialog" aria-expanded="${chart.api.selectedId===event.id}" style="left:${item.hitLeft}px;top:${offset+item.row*rowStep}px;width:${item.hitWidth}px;--cat-color:${cat.color};--fill-offset:${item.fillOffset}px;--fill-width:${item.width}px;--start-fuzz:${fuzzStart}px;--end-fuzz:${fuzzEnd}px" aria-label="${escape(event.title)}, ${escape(dateLabel(event))}, ${escape(reviewStates[state].label)}"><span class="band-span"></span>${item.width>=50?`<span class="band-label" style="left:${item.fillOffset+8}px;max-width:${Math.max(0,item.width-16)}px">${state==='hypothesis'?'◇ ':''}${escape(event.title)}</span>`:''}${extent.ongoing?'<span class="ongoing-arrow" aria-hidden="true">›</span>':''}</button>`);
   }
   offset+=packed.rows*rowStep;
   const points=current.filter(i=>i.extent.kind==='point').map(i=>({...i,x:Math.max(left+7,Math.min(left+plotWidth-7,x(i.extent.anchor)))}));
   for(const item of [...short,...packed.overflow])points.push({...item,x:Math.max(left+7,Math.min(left+plotWidth-7,x(item.extent.anchor))),compressedPeriod:true});
   const groups=groupPoints(points,coarse?44:22);
   const pointEnds=[];
   for(const group of groups){const hit=coarse?44:20,position=group.x-hit/2,gap=coarse?0:2;let row=pointEnds.findIndex(end=>end+gap<=position);if(row<0)row=pointEnds.length;pointEnds[row]=position+hit;group.row=row;}
   if(groups.length&&packed.rows)offset+=5;
   groups.forEach((group,n)=>{
    const events=group.items.map(i=>i.event),{lead,index}=register(events),state=kind==='main'?(events.every(e=>reviewState(e)==='confirmed')?'confirmed':'unreviewed'):kind;
    const single=group.items.length===1,item=group.items[0],approximate=single&&item.extent.approximate&&item.extent.kind==='point';
    const rowTop=offset+group.row*rowStep;
    if(approximate){const a=Math.max(start,item.extent.start),b=Math.min(end,item.extent.end);if(x(b)-x(a)>18)laneHtml.push(`<div class="date-window" style="left:${x(a)}px;top:${rowTop+11}px;width:${x(b)-x(a)}px;--cat-color:${cat.color}" aria-hidden="true"></div>`);}
    const next=groups.slice(n+1).find(g=>g.row===group.row)?.x??left+plotWidth,space=Math.min(175,next-group.x-25),showLabel=single&&space>65;
    const count=events.length,label=single?lead.title:`${number(count)} moments proches`;
    laneHtml.push(`<button type="button" class="moment time-point is-${state} ${kind==='hypothesis'?'is-subtle':''} ${single&&item.compressedPeriod?'short-period':''} ${events.some(e=>s.connectedIds?.has(e.id))?'is-connected':''} ${events.some(e=>e.id===chart.api.selectedId)?'selected':''}" data-cluster="${index}" data-event-id="${escape(lead.id)}" data-review="${state}" data-temporal="${single?item.extent.kind:'cluster'}" aria-haspopup="dialog" aria-expanded="${events.some(e=>e.id===chart.api.selectedId)}" style="left:${group.x-10}px;top:${rowTop}px;--cat-color:${cat.color}" aria-label="${escape(label)}, ${escape(dateLabel(lead))}, ${escape(reviewStates[state].label)}"><span class="time-dot">${count>99?'99+':count>1?number(count):state==='hypothesis'?'◇':approximate?'~':'<span class="point-core"></span>'}</span>${showLabel?`<span class="point-label" style="max-width:${space}px">${escape(lead.title)}</span>`:''}</button>`);
   });
   if(groups.length)offset+=rowStep*pointEnds.length;
   if(kind==='main')offset+=4;
  }
  const height=Math.max(compact?54:65,offset-top+(compact?6:10)),periodCount=lane.filter(i=>i.extent.kind==='period').length;
  html.push(`<div class="lane" style="top:${top}px;height:${height}px;--cat-color:${cat.color}"><div class="lane-label">${icon(cat.icon)}<div><strong>${escape(cat.label)}</strong><small>${periodCount?`${number(periodCount)} période${periodCount>1?'s':''}<br>`:''}${number(lane.length-periodCount)} repère${lane.length-periodCount>1?'s':''}</small></div></div><div class="lane-line"></div></div>`,...laneHtml);
  top+=height;
 }
 const height=Math.max(items.length?220:240,top+16);chart.root.style.height=`${height}px`;chart.root.style.minHeight=`${height}px`;
 const now=Date.now();if(now>=start&&now<=end&&span>DAY)html.push(`<div class="now-line" style="left:${x(now)}px"><span class="now-label">Aujourd’hui</span></div>`);
 html.push('<div class="time-cursor" hidden><span></span></div>');
 if(!items.length)html.push(`<div class="empty-view"><strong>${s.query?'Aucun souvenir pour cette recherche.':'Une page encore à explorer.'}</strong><span>Cette fenêtre ne contient pas de période ou de repère avec ces filtres.</span><br><button class="secondary-button" type="button" data-fit>Revenir à la vue globale</button></div>`);
 chart.root.innerHTML=html.join('');chart.root.querySelector('[data-fit]')?.addEventListener('click',()=>chart.api.fit());
 const periods=items.filter(i=>i.extent.kind==='period').length;
 document.getElementById('visible-count').textContent=`${number(periods)} période${periods>1?'s':''} · ${number(items.length-periods)} repère${items.length-periods>1?'s':''} · ${number(chart.clusters.length)} éléments à explorer`;
 chart.drawMinimap();
}
