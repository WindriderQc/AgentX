// Photos come from the household photo library, through the photo files and
// folders that history entries cite. Core serves them from its read-only
// mount after checking each cited identity; nothing is copied.
import {escape,icon,dateLabel,fold,number} from './ui.js';
import {readSource} from './data.js';

const RAIL_LIMIT=24;
const loaded=new Map();

// One photo source (a file or a folder) with the moments that cite it.
export function collectPhotos(events){
 const byId=new Map();
 for(const e of events)for(const id of e.photoSourceIds||[]){
  const row=byId.get(id)||{id,eventIds:[],date:null,precision:'day',title:''};
  row.eventIds.push(e.id);
  if(e.date&&(!row.date||e.date<row.date)){row.date=e.date;row.precision=e.precision;row.title=e.title;}
  if(!row.title)row.title=e.title;
  byId.set(id,row);
 }
 return [...byId.values()];
}
export function photosInRange(photos,range){
 return photos.filter(p=>{
  if(!p.date||!range)return false;
  const start=Date.parse(p.date+'T00:00:00Z');
  const end=p.precision==='year'?Date.UTC(new Date(start).getUTCFullYear()+1,0,1):p.precision==='month'?Date.UTC(new Date(start).getUTCFullYear(),new Date(start).getUTCMonth()+1,1):start+86400000;
  return start<range[1]&&end>range[0];
 });
}
// The images behind a photo source, read once per page.
export async function imagesOf(id){
 if(!loaded.has(id))loaded.set(id,readSource(id).then(source=>({title:source.subject,images:source.images||[]})).catch(()=>({title:'',images:[]})));
 return loaded.get(id);
}
export const coverOf=id=>loaded.get(id);
export const photoDate=photo=>photo.date?dateLabel({date:photo.date,precision:photo.precision||'day'}):'Date à préciser';
// Fills timeline thumbnails once Core has listed each cited folder.
export function hydrateCovers(root){
 root.querySelectorAll('img[data-photo-cover]:not([src])').forEach(img=>imagesOf(img.dataset.photoCover).then(set=>{const image=set.images[0];if(image&&img.isConnected)img.src=image.url;}));
}

export function eventPhotoMarkup(event){
 if(!event.photoSourceIds?.length)return '';
 return `<section class="event-photo-section" data-event-photos><div><strong>${icon('file')} Images de ta bibliothèque</strong><small>Dossiers cités par ce moment</small></div><div class="event-photo-strip" data-event-photo-strip><span class="photo-loading">Ouverture des images…</span></div></section>`;
}
export async function hydrateEventPhotos(root,event,api){
 const strip=root.querySelector('[data-event-photo-strip]');if(!strip)return;
 const sets=await Promise.all(event.photoSourceIds.slice(0,6).map(async id=>({id,...await imagesOf(id)})));
 if(!strip.isConnected)return;
 const tiles=sets.flatMap(set=>set.images.slice(0,8).map((image,index)=>({set,image,index})));
 strip.innerHTML=tiles.length?tiles.map(({set,image,index})=>`<button type="button" data-photo="${escape(set.id)}" data-photo-index="${index}" aria-label="Voir ${escape(image.name)}"><img src="${escape(image.url)}" alt="${escape(set.title||image.name)}" loading="lazy"><span>${escape(set.title)}</span></button>`).join('')
  :'<span class="photo-loading">Les images citées ne sont plus disponibles dans la bibliothèque.</span>';
 strip.querySelectorAll('[data-photo]').forEach(b=>b.addEventListener('click',()=>api.photoOpen(b.dataset.photo,b,{event,index:Number(b.dataset.photoIndex)})));
}

export class Gallery{
 constructor(root,popup,api){this.root=root;this.popup=popup;this.api=api;this.signature='';}
 async load(){this.render(true);}
 render(force=false){
  const {state}=this.api;
  const all=collectPhotos(state.events);
  this.root.hidden=state.dataset==='demo'||!all.length;if(this.root.hidden)return;
  const terms=fold(state.query).split(/\s+/).filter(Boolean);
  const photos=photosInRange(all,state.range).filter(p=>terms.every(t=>fold([p.title,...p.eventIds.map(id=>state.events.find(e=>e.id===id)?.title||'')].join(' ')).includes(t)))
   .sort((a,b)=>a.date.localeCompare(b.date));
  const shown=photos.length>RAIL_LIMIT?photos.filter((_,i)=>i%Math.ceil(photos.length/RAIL_LIMIT)===0).slice(0,RAIL_LIMIT):photos;
  const signature=shown.map(p=>p.id).join('|');
  if(!force&&signature===this.signature)return;this.signature=signature;
  const whole=state.range&&state.domain&&(state.range[1]-state.range[0])/(state.domain[1]-state.domain[0])>.98;
  this.root.innerHTML=`<div class="gallery-heading"><div><p class="eyebrow">LES IMAGES RETROUVÉES</p><h2>${whole?'Des fragments, bien vivants.':'Cette époque, en images.'}</h2></div><div class="gallery-heading-meta"><strong>${number(photos.length)} dossier${photos.length>1?'s':''} ou photo${photos.length>1?'s':''}</strong><span>Liés à tes moments · ta bibliothèque, sans copie</span></div></div>${shown.length?`<div class="photo-rail" tabindex="0" aria-label="Photos de la période affichée; faire défiler horizontalement">${shown.map(p=>`<button type="button" class="photo-tile is-loading" data-gallery-photo="${escape(p.id)}"><img alt="" loading="lazy"><span class="photo-tile-overlay"><time>${escape(dateLabel({date:p.date,precision:p.precision}))}</time><strong>${escape(p.title)}</strong><span>Ouvrir ↗</span></span></button>`).join('')}</div>`:`<div class="gallery-empty"><span class="gallery-empty-icon">${icon('file')}</span><div><strong>${state.query?'Aucune image de cette sélection ne correspond.':'Pas d’image liée à cette période.'}</strong><span>Les moments et leurs sources restent sur la frise.</span></div>${!whole?'<button type="button" class="text-button" data-gallery-all>Voir toute la vie ↗</button>':''}</div>`}`;
  this.root.querySelectorAll('[data-gallery-photo]').forEach(tile=>{
   tile.addEventListener('click',()=>this.open(tile.dataset.galleryPhoto,tile));
   imagesOf(tile.dataset.galleryPhoto).then(set=>{const image=set.images[Math.floor(set.images.length/2)];if(!tile.isConnected)return;
    if(image){const img=tile.querySelector('img');img.src=image.url;img.alt=set.title||image.name;tile.classList.remove('is-loading');}else tile.remove();});
  });
  this.root.querySelector('[data-gallery-all]')?.addEventListener('click',()=>this.api.fit());
 }
 async open(id,anchor,{event=null,index=0}={}){
  const set=await imagesOf(id),state=this.api.state;if(!set.images.length){this.api.toast('Ces images ne sont plus disponibles.');return;}
  const i=(index+set.images.length)%set.images.length,image=set.images[i];
  const moments=collectPhotos(state.events).find(p=>p.id===id)?.eventIds.map(eid=>state.events.find(e=>e.id===eid)).filter(Boolean)||[];
  this.popup.info(`<div class="photo-viewer"><div class="photo-viewer-stage"><img src="${escape(image.url)}" alt="${escape(set.title||image.name)}">${set.images.length>1?'<button type="button" class="photo-nav prev" aria-label="Photo précédente" data-photo-prev>←</button><button type="button" class="photo-nav next" aria-label="Photo suivante" data-photo-next>→</button>':''}<span class="photo-counter">${i+1} / ${set.images.length}</span></div><div class="photo-viewer-body"><p class="eyebrow">UNE IMAGE DE TA BIBLIOTHÈQUE</p><h3>${escape(set.title||image.name)}</h3><p class="photo-viewer-date">${icon('file')}${escape(image.name)}</p><div class="photo-provenance"><strong>Ce qui relie cette image</strong><p>Le dossier est cité par ${moments.length>1?`${number(moments.length)} moments`:'ce moment'}. Il ne confirme pas à lui seul qui était présent.</p></div>${moments.length?`<div class="photo-event-links"><small>Moments liés</small>${moments.map(e=>`<button type="button" class="related-event" data-photo-event="${escape(e.id)}"><time>${escape(dateLabel(e,true))}</time><strong>${escape(e.title)}</strong>↗</button>`).join('')}</div>`:''}${event?'<button class="text-button photo-back" type="button" data-photo-back>← Retour au dossier</button>':''}</div></div>`,anchor);
  this.popup.makeModal();const box=this.popup.root.querySelector('.popover');box.classList.add('photo-viewer-popover');this.popup.position();
  const move=step=>this.open(id,anchor,{event,index:i+step});
  box.querySelector('[data-photo-prev]')?.addEventListener('click',()=>move(-1));box.querySelector('[data-photo-next]')?.addEventListener('click',()=>move(1));
  box.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){e.preventDefault();move(-1);}if(e.key==='ArrowRight'){e.preventDefault();move(1);}});
  box.querySelectorAll('[data-photo-event]').forEach(b=>b.addEventListener('click',()=>this.api.open([state.events.find(e=>e.id===b.dataset.photoEvent)],anchor,true)));
  box.querySelector('[data-photo-back]')?.addEventListener('click',()=>this.api.open([event],anchor,true));
  box.querySelector('[data-close-info]')?.focus({preventScroll:true});
 }
}
