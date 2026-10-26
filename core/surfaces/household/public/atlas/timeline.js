import {renderTimeline} from './timeline-render.js';
import {temporalExtent} from './temporal.js';
import {categories,icon,escape,number,DAY,YEAR,dateLabel} from './ui.js';
import {reviewState,reviewStates} from './review.js';

export class Timeline {
 constructor(root,api){
  this.root=root;this.api=api;this.width=root.clientWidth;this.hoverTimer=null;this.drag=null;
  this.observer=new ResizeObserver(()=>{this.width=root.clientWidth;this.schedule();});this.observer.observe(root);
  root.addEventListener('click',e=>{const b=e.target.closest('[data-timeline-photo]');if(b&&!this.justDragged)this.api.photoOpen(b.dataset.timelinePhoto,b,{pool:this.photoGroups[Number(b.dataset.photoGroup)]});});
  root.addEventListener('click',e=>{if(this.justDragged)return;const card=e.target.closest('[data-cluster]'),cluster=card&&this.clusters?.[Number(card.dataset.cluster)];if(cluster)this.api.open(cluster.events,card,true);});
  root.addEventListener('pointerover',e=>{const card=e.target.closest('[data-cluster]');if(!card||card.contains(e.relatedTarget)||e.pointerType==='touch'||this.drag)return;const cluster=this.clusters?.[Number(card.dataset.cluster)];if(!cluster)return;clearTimeout(this.hoverTimer);const point={x:e.clientX,y:e.clientY};this.hoverTimer=setTimeout(()=>{if(card.isConnected)this.api.open(cluster.events,card,false,point);},260);});
  root.addEventListener('pointermove',e=>this.updateCursor(e));
  root.addEventListener('pointerleave',()=>{const cursor=root.querySelector('.time-cursor');if(cursor)cursor.hidden=true;});
  root.addEventListener('pointerout',e=>{const card=e.target.closest('[data-cluster]');if(!card||card.contains(e.relatedTarget))return;clearTimeout(this.hoverTimer);this.api.leave();});
  root.addEventListener('focusin',e=>{const card=e.target.closest('[data-cluster]');const cluster=card&&this.clusters?.[Number(card.dataset.cluster)];if(cluster)this.api.open(cluster.events,card,false);});
  root.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button'))return;this.drag={x:e.clientX,start:[...this.api.state.range]};root.setPointerCapture(e.pointerId);});
  root.addEventListener('pointermove',e=>{if(!this.drag)return;const dx=e.clientX-this.drag.x;if(Math.abs(dx)<4)return;this.justDragged=true;root.classList.add('dragging');this.api.close();const span=this.drag.start[1]-this.drag.start[0];const shift=dx/(this.width-this.left-20)*span;this.api.setRange(this.drag.start.map(v=>v-shift));});
  const end=()=>{this.drag=null;root.classList.remove('dragging');setTimeout(()=>this.justDragged=false,40);};root.addEventListener('pointerup',end);root.addEventListener('pointercancel',end);
  root.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();const rect=root.getBoundingClientRect();this.api.zoom(Math.exp(e.deltaY*.004),Math.max(0,Math.min(1,(e.clientX-rect.left-this.left)/(this.width-this.left-20))));}else if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)){e.preventDefault();const s=this.api.state.range;const d=(e.deltaX||e.deltaY)/(this.width-this.left)*(s[1]-s[0]);this.api.setRange(s.map(v=>v+d));}},{passive:false});
  const map=document.getElementById('minimap');const navigate=e=>{const rect=map.getBoundingClientRect();const p=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));const state=this.api.state;const center=state.domain[0]+p*(state.domain[1]-state.domain[0]);const half=(state.range[1]-state.range[0])/2;this.api.setRange([center-half,center+half]);};
  map.addEventListener('pointerdown',e=>{this.mapDrag=true;map.setPointerCapture(e.pointerId);navigate(e);});map.addEventListener('pointermove',e=>{if(this.mapDrag)navigate(e);});map.addEventListener('pointerup',()=>this.mapDrag=false);map.addEventListener('pointercancel',()=>this.mapDrag=false);
 }
 updateCursor(event){
  const cursor=this.root.querySelector('.time-cursor'),s=this.api.state;if(!cursor||!s.range)return;
  if(this.drag||event.pointerType==='touch'){cursor.hidden=true;return;}
  const px=event.clientX-this.root.getBoundingClientRect().left;
  if(px<this.left||px>this.width-22){cursor.hidden=true;return;}
  const at=s.range[0]+(px-this.left)/(this.width-this.left-22)*(s.range[1]-s.range[0]);
  cursor.hidden=false;cursor.style.left=px+'px';cursor.classList.toggle('cursor-at-end',px>this.width-150);
  cursor.querySelector('span').textContent=new Intl.DateTimeFormat('fr-CA',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(at));
 }
 schedule(){if(this.raf)return;this.raf=requestAnimationFrame(()=>{this.raf=null;this.render();});}
 render(){renderTimeline(this);}

 ticks(start,end,width){
  const span=end-start,out=[];let current,unit,step;
  if(span>2*YEAR){unit='year';step=span/YEAR>40?10:span/YEAR>20?5:span/YEAR>9?2:1;const year=new Date(start).getUTCFullYear();current=Date.UTC(Math.ceil(year/step)*step,0,1);}
  else if(span>75*DAY){unit='month';step=span>YEAR?3:span>190*DAY?2:1;const d=new Date(start);current=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);}
  else{unit='day';step=span>40*DAY?7:span>20*DAY?5:span>9*DAY?2:1;current=Math.ceil(start/DAY)*DAY;}
  const minGap=width<350?65:70;let previous=-100;
  while(current<=end&&out.length<40){const date=new Date(current),px=(current-start)/span*width;if(px>=0&&px-previous>minGap){const label=unit==='year'?String(date.getUTCFullYear()):new Intl.DateTimeFormat('fr-CA',{timeZone:'UTC',...(unit==='month'?{month:'short',...(date.getUTCMonth()===0?{year:'numeric'}:{})}:{day:'numeric',month:'short'})}).format(date);out.push({time:current,label,major:unit==='year'||date.getUTCMonth()===0});previous=px;}current=unit==='year'?Date.UTC(date.getUTCFullYear()+step,0,1):unit==='month'?Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+step,1):current+step*DAY;}
  return out;
 }
 drawMinimap(){
  const canvas=document.getElementById('minimap-canvas'),parent=canvas.parentElement,width=parent.clientWidth,height=32,dpr=devicePixelRatio||1;
  if(!width)return;canvas.width=width*dpr;canvas.height=height*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const s=this.api.state,span=s.domain[1]-s.domain[0],bins=new Array(Math.max(1,Math.floor(width/5))).fill(0);
  for(const e of s.filtered)if(s.categories.has(e.category)){const t=temporalExtent(e);if(!t)continue;if(t.kind==='period'){const a=Math.max(0,Math.floor((t.start-s.domain[0])/span*bins.length)),b=Math.min(bins.length-1,Math.floor((t.end-s.domain[0])/span*bins.length));for(let i=a;i<=b;i++)bins[i]+=.4;}else{const i=Math.floor((t.anchor-s.domain[0])/span*bins.length);if(i>=0&&i<bins.length)bins[i]++;}}
  const max=Math.max(1,...bins),style=getComputedStyle(document.documentElement);ctx.fillStyle=style.getPropertyValue('--accent').trim();ctx.globalAlpha=.24;
  bins.forEach((count,i)=>{const h=count?Math.max(2,Math.sqrt(count/max)*25):1;ctx.fillRect(i/bins.length*width,height-h,width/bins.length-2,h);});
  const left=Math.max(0,(s.range[0]-s.domain[0])/span*100),right=Math.min(100,(s.range[1]-s.domain[0])/span*100);const windowEl=document.getElementById('minimap-window');windowEl.style.left=left+'%';windowEl.style.width=Math.max(.3,right-left)+'%';
 }
}
