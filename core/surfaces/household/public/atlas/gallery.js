// Photos bound to moments in their history context. Core serves each original
// from the household library's read-only mount, after checking its hash.
import {escape,icon,dateLabel,fold,number} from './ui.js';
import {collectMedia} from './projection.js';

const RAIL_LIMIT=30;
let cache={events:null,photos:[]};
export function collectPhotos(events){if(cache.events!==events)cache={events,photos:collectMedia(events)};return cache.photos;}
export const photoDate=photo=>photo.date?dateLabel({date:photo.date,precision:photo.precision||'day'}):'Date à préciser';
export function photosInRange(photos,range){
 return photos.filter(p=>{
  if(!p.date||!range)return false;
  const start=Date.parse(p.date+'T00:00:00Z');
  const end=p.precision==='year'?Date.UTC(new Date(start).getUTCFullYear()+1,0,1):p.precision==='month'?Date.UTC(new Date(start).getUTCFullYear(),new Date(start).getUTCMonth()+1,1):start+86400000;
  return start<range[1]&&end>range[0];
 });
}
export const photosForEvent=(photos,event)=>photos.filter(p=>p.eventIds.includes(event.id));
const label=p=>p.album||p.caption||p.filename;

export function eventPhotoMarkup(photos,event){
 const matches=photosForEvent(photos,event);if(!matches.length)return '';
 return `<section class="event-photo-section"><div><strong>${icon('file')} Images de ta bibliothèque</strong><small>Liens proposés · à confirmer</small></div><div class="event-photo-strip">${matches.slice(0,12).map(p=>`<button type="button" data-photo="${escape(p.id)}" aria-label="Voir la photo : ${escape(label(p))}"><img src="${escape(p.url)}" alt="${escape(label(p))}" loading="lazy"><span>${escape(photoDate(p))}</span></button>`).join('')}</div></section>`;
}

export class Gallery{
 constructor(root,popup,api){this.root=root;this.popup=popup;this.api=api;this.signature='';}
 async load(){this.render(true);}
 render(force=false){
  const {state}=this.api,all=collectPhotos(state.events);
  this.root.hidden=state.dataset==='demo'||!all.length;if(this.root.hidden)return;
  const terms=fold(state.query).split(/\s+/).filter(Boolean);
  const photos=photosInRange(all,state.range).filter(p=>terms.every(t=>fold([p.caption,p.album,...p.eventIds.map(id=>state.events.find(e=>e.id===id)?.title||'')].join(' ')).includes(t)))
   .sort((a,b)=>a.date.localeCompare(b.date));
  const shown=photos.length>RAIL_LIMIT?photos.filter((_,i)=>i%Math.ceil(photos.length/RAIL_LIMIT)===0):photos;
  const undated=all.filter(p=>!p.date);const signature=shown.map(p=>p.id).join('|')+'|undated:'+undated.map(p=>p.id).join('|');
  if(!force&&signature===this.signature)return;this.signature=signature;
  const whole=state.range&&state.domain&&(state.range[1]-state.range[0])/(state.domain[1]-state.domain[0])>.98;
  this.root.innerHTML=`<div class="gallery-heading"><div><p class="eyebrow">LES IMAGES RETROUVÉES</p><h2>${whole?'Des fragments, bien vivants.':'Cette époque, en images.'}</h2></div><div class="gallery-heading-meta"><strong>${number(photos.length)} photo${photos.length>1?'s':''}</strong><span>De ta bibliothèque · associations proposées</span>${undated.length?`<button type="button" class="text-button" data-gallery-undated>${number(undated.length)} image${undated.length>1?'s':''} sans date · ouvrir ↗</button>`:''}</div></div>${shown.length?`<div class="photo-rail" tabindex="0" aria-label="Photos de la période affichée; faire défiler horizontalement">${shown.map(p=>`<button type="button" class="photo-tile" data-gallery-photo="${escape(p.id)}"><img src="${escape(p.url)}" loading="lazy" alt="${escape(label(p))}"><span class="photo-tile-overlay"><time>${escape(photoDate(p))}</time><strong>${escape(label(p))}</strong><span>Ouvrir l’image ↗</span></span><span class="photo-proposal" title="La date et le lien avec ta vie restent à confirmer">◇</span></button>`).join('')}</div>`:`<div class="gallery-empty"><span class="gallery-empty-icon">${icon('file')}</span><div><strong>${state.query?'Aucune photo de cette sélection ne correspond.':'Pas d’image liée à cette période.'}</strong><span>Les moments et leurs sources restent sur la frise.</span></div>${!whole?'<button type="button" class="text-button" data-gallery-all>Voir toute la vie ↗</button>':''}</div>`}`;
  this.root.querySelectorAll('[data-gallery-photo]').forEach(b=>b.addEventListener('click',()=>this.open(b.dataset.galleryPhoto,b,{pool:photos})));
  this.root.querySelectorAll('.photo-tile img').forEach(img=>img.addEventListener('error',()=>img.closest('.photo-tile')?.remove(),{once:true}));
  this.root.querySelector('[data-gallery-undated]')?.addEventListener('click',e=>this.open(undated[0].id,e.currentTarget,{pool:undated}));
  this.root.querySelector('[data-gallery-all]')?.addEventListener('click',()=>this.api.fit());
 }
 open(id,anchor,{pool=collectPhotos(this.api.state.events),event=null,onBack=null}={}){
  const p=pool.find(p=>p.id===id)||collectPhotos(this.api.state.events).find(p=>p.id===id);if(!p)return;
  const list=pool.includes(p)?pool:[p],index=list.indexOf(p),state=this.api.state;
  const matches=p.eventIds.map(eid=>state.events.find(e=>e.id===eid)).filter(Boolean);
  this.popup.info(`<div class="photo-viewer"><div class="photo-viewer-stage"><img src="${escape(p.url)}" alt="${escape(label(p))}">${list.length>1?'<button type="button" class="photo-nav prev" aria-label="Photo précédente" data-photo-prev>←</button><button type="button" class="photo-nav next" aria-label="Photo suivante" data-photo-next>→</button>':''}<span class="photo-counter">${index+1} / ${list.length}</span></div><div class="photo-viewer-body"><p class="eyebrow">UNE IMAGE DE TA BIBLIOTHÈQUE</p><h3>${escape(label(p))}</h3><p class="photo-viewer-date">${icon('calendar')}${escape(photoDate(p))}<span>◇ Date et liens à confirmer</span></p>${p.caption&&p.caption!==p.album?`<p>${escape(p.caption)}</p>`:''}<div class="photo-provenance"><strong>Ce qui relie cette image</strong><p>${escape(p.associationBasis||'Le dossier et la date du fichier suggèrent ce rapprochement. Ils ne confirment pas qui était présent.')}</p>${p.dateNote?`<p>${escape(p.dateNote)}</p>`:''}</div>${matches.length?`<div class="photo-event-links"><small>Moments associés · propositions</small>${matches.map(e=>`<button type="button" class="related-event" data-photo-event="${escape(e.id)}"><time>${escape(dateLabel(e,true))}</time><strong>${escape(e.title)}</strong>↗</button>`).join('')}</div>`:''}<p class="photo-viewer-file">${escape(p.filename)} · ${p.assetId?'Bibliothèque native AgentX':'original vérifié par empreinte'}</p>${event||onBack?'<button class="text-button photo-back" type="button" data-photo-back>← Retour</button>':''}</div></div>`,anchor);
  this.popup.makeModal();const box=this.popup.root.querySelector('.popover');box.classList.add('photo-viewer-popover');this.popup.position();
  const move=step=>this.open(list[(index+step+list.length)%list.length].id,anchor,{pool:list,event,onBack});
  box.querySelector('[data-photo-prev]')?.addEventListener('click',()=>move(-1));box.querySelector('[data-photo-next]')?.addEventListener('click',()=>move(1));
  box.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select'))return;if(e.key==='ArrowLeft'){e.preventDefault();move(-1);}if(e.key==='ArrowRight'){e.preventDefault();move(1);}});
  box.querySelectorAll('[data-photo-event]').forEach(b=>b.addEventListener('click',()=>this.api.open([state.events.find(e=>e.id===b.dataset.photoEvent)],anchor,true)));
  box.querySelector('[data-photo-back]')?.addEventListener('click',()=>onBack?onBack():this.api.open([event],anchor,true));
  box.querySelector('[data-close-info]')?.focus({preventScroll:true});
 }
}
