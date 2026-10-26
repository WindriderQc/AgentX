// Chapters are navigation windows built from the owner's own data: one per
// decade that holds dated moments, named by its most cited places and people.
// They make no claim about life periods; the code holds no personal detail.
import {temporalExtent} from './temporal.js';
import {escape,icon,categories} from './ui.js';
import {reviewState} from './review.js';
import {collectPhotos} from './gallery.js';
import {isLifeMoment} from './life-view.js';

const MINIMUM=3;
const top=(values,count)=>[...values.reduce((map,v)=>map.set(v,(map.get(v)||0)+1),new Map())].sort((a,b)=>b[1]-a[1]).slice(0,count).map(([v])=>v);

export function buildChapters(events){
 const byDecade=new Map();
 for(const e of events){
  if(!isLifeMoment(e)||!e.date||reviewState(e)==='dismissed')continue;
  const decade=Math.floor(Number(e.date.slice(0,4))/10)*10;
  if(!byDecade.has(decade))byDecade.set(decade,[]);byDecade.get(decade).push(e);
 }
 const now=new Date().getUTCFullYear();
 return [...byDecade].filter(([decade,members])=>members.length>=MINIMUM&&decade<=now).sort((a,b)=>a[0]-b[0]).map(([decade,members])=>{
  const extents=members.map(e=>temporalExtent(e)).filter(Boolean);
  const first=Math.min(...extents.map(t=>t.start)),last=Math.max(...extents.map(t=>t.end));
  const places=top(members.flatMap(e=>String(e.place||'').split(',').map(p=>p.trim()).filter(Boolean)),2);
  const people=top(members.flatMap(e=>e.people||[]),1);
  const category=top(members.map(e=>e.category),1)[0]||'daily';
  const kept=members.filter(e=>e.core?.souvenirNoteId).length;
  return {id:`decade-${decade}`,decade,members,first,last,range:[Date.UTC(decade,0,1),Date.UTC(decade+10,0,1)],
   title:decade+10>now?'Aujourd’hui':`Les années ${decade}`,subtitle:[...places,...people].join(' · ')||categories[category].label,
   icon:categories[category].icon,color:categories[category].color,
   label:`${new Date(first).getUTCFullYear()} — ${new Date(last-1).getUTCFullYear()} · ${members.length} moment${members.length>1?'s':''}${kept?` · ${kept} souvenir${kept>1?'s':''}`:''}`};
 });
}

export function renderChapters(root,api){
 const state=api.state,chapters=buildChapters(state.events);
 root.hidden=state.dataset==='demo'||chapters.length<2;
 if(root.hidden)return;
 const photos=collectPhotos(state.events);
 root.innerHTML=`<div class="chapter-heading"><span class="eyebrow">UNE VIE À PARCOURIR</span><span>Une époque par décennie · clique pour l’explorer</span></div><div class="chapter-rail">${chapters.map((c,i)=>`<button type="button" class="chapter-tile" data-chapter="${c.id}" aria-pressed="${state.activeChapter===c.id}" style="--chapter-color:${c.color}"><span class="chapter-art" aria-hidden="true">${icon(c.icon)}<i></i><i></i></span><span class="chapter-number">${String(i+1).padStart(2,'0')}</span><span class="chapter-copy"><small>${escape(c.label)}</small><strong>${escape(c.title)}</strong><span>${escape(c.subtitle)}</span></span><span class="chapter-enter" aria-hidden="true">↗</span></button>`).join('')}</div>`;
 root.querySelectorAll('[data-chapter]').forEach(b=>{
  const c=chapters.find(c=>c.id===b.dataset.chapter);
  b.addEventListener('click',()=>{api.close();state.activeChapter=c.id;api.setRange(c.range);
   root.querySelectorAll('[data-chapter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
   document.querySelector('.atlas').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});});
  // A cover from a photo folder of that decade, once Core has listed it.
  const inDecade=photos.filter(p=>p.date&&Math.floor(Number(p.date.slice(0,4))/10)*10===c.decade);
  const cover=inDecade.find(p=>p.cover)||inDecade[Math.floor(inDecade.length/2)];
  if(cover){const img=document.createElement('img');img.src=cover.url;img.alt='';img.loading='lazy';
   img.addEventListener('load',()=>{b.querySelector('.chapter-art')?.replaceWith(img);b.classList.add('has-photo');},{once:true});}
 });
}

export function syncChapterRange(root,state){
 if(!state.range)return;
 const active=buildChapters(state.events).find(c=>Math.abs(c.range[0]-state.range[0])<86400000&&Math.abs(Math.min(c.range[1],state.domain[1])-state.range[1])<86400000);
 state.activeChapter=active?.id||null;
 root.querySelectorAll('[data-chapter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.chapter===state.activeChapter)));
}
