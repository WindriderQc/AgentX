import {escape,number} from './ui.js';
import {photoSearch} from './data.js';
import {collectPhotos} from './gallery.js';

// Metadata search in Core's existing library. It performs no image analysis,
// creates no binding, and only shows people already named in the library.
export function libraryPhoto(item,events=[]){
 const binding=collectPhotos(events).find(p=>p.assetId===item.id);
 return {id:item.id,assetId:item.id,url:`/api/photos/assets/${encodeURIComponent(item.id)}/thumbnail?size=preview`,
  thumbnail:item.thumbnail||`/api/photos/assets/${encodeURIComponent(item.id)}/thumbnail?size=thumbnail`,
  caption:item.description||'',album:[item.city,item.country].filter(Boolean).join(' · ')||item.fileName||'Image de ta bibliothèque',
  filename:item.fileName||'Photo',date:item.takenAt?.slice(0,10)||null,precision:item.takenAt?'day':'unknown',
  eventIds:binding?.eventIds||[],associationBasis:binding?.associationBasis||'Aucun rapprochement avec un moment n’a été ajouté par cette recherche.',
  dateNote:'Date indiquée dans les métadonnées de la bibliothèque; elle ne confirme ni la prise de vue ni la présence d’une personne.'};
}

export function showLibrary(popup,api,anchor,previous){
 const range=api.state.range,from=new Date(range[0]).toISOString().slice(0,10),to=new Date(range[1]-1).toISOString().slice(0,10);
 const state=previous||{photos:[],cursor:null,text:'',city:'',person:'',whole:false,loading:false,error:''};
 popup.info('',anchor);popup.makeModal();const box=popup.root.querySelector('.popover');box.classList.add('library-popover');box.setAttribute('aria-label','Explorer ta photothèque');
 const root=box.querySelector('.info-content');
 function render(){
  root.innerHTML=`<p class="eyebrow">TA PHOTOTHÈQUE · AGENTX</p><h3>Revoir cette époque.</h3><p>${state.whole?'Toute la bibliothèque':`Du ${escape(from)} au ${escape(to)}`} · dates des métadonnées. Les liens avec les moments restent proposés.</p><form class="library-search"><label>Description<input name="text" value="${escape(state.text)}" placeholder="Rechercher les descriptions…"></label><label>Ville<input name="city" value="${escape(state.city)}"></label><label>Personne nommée<input name="person" value="${escape(state.person)}"></label><button type="submit" class="primary-button" ${state.loading?'disabled':''}>Retrouver →</button><label class="library-whole"><input type="checkbox" name="whole" ${state.whole?'checked':''}>Toute la photothèque, toutes dates</label></form><p class="library-status" role="status">${escape(state.error|| (state.loading?'Ouverture de la bibliothèque…':`${number(state.photos.length)} images affichées`))}</p><div class="library-grid">${state.photos.map(p=>`<button type="button" data-library-photo="${escape(p.id)}"><img src="${escape(p.thumbnail)}" alt="${escape(p.caption||p.album)}" loading="lazy"><span><time>${escape(p.date||'À dater')}</time><strong>${escape(p.album)}</strong></span></button>`).join('')}</div>${!state.loading&&!state.error&&!state.photos.length?'<p class="library-empty">Aucune image avec ces dates et ces filtres. Essaie toute la photothèque ou une autre recherche.</p>':''}${state.cursor?`<button type="button" class="secondary-button" data-library-more ${state.loading?'disabled':''}>Afficher les suivantes →</button>`:''}`;
  root.querySelector('form').addEventListener('submit',e=>{e.preventDefault();if(state.loading)return;const values=new FormData(e.currentTarget);for(const key of ['text','city','person'])state[key]=String(values.get(key)||'').trim();state.whole=values.has('whole');state.photos=[];state.cursor=null;load();});
  root.querySelectorAll('[data-library-photo]').forEach(b=>b.addEventListener('click',()=>api.photoOpen(b.dataset.libraryPhoto,b,{pool:state.photos,onBack:()=>showLibrary(popup,api,anchor,state)})));
  root.querySelector('[data-library-more]')?.addEventListener('click',()=>load(true));popup.position();
 }
 async function load(more=false){
  if(state.loading)return;state.loading=true;state.error='';render();
  try{const answer=await photoSearch({...(!state.whole?{from,to}:{}),text:state.text,city:state.city,person:state.person,cursor:more?state.cursor:null});
   if(!root.isConnected)return;const items=answer.items.map(item=>libraryPhoto(item,api.state.events));
   state.photos=[...new Map([...(more?state.photos:[]),...items].map(p=>[p.id,p])).values()];state.cursor=answer.nextCursor;
  }catch(error){if(root.isConnected)state.error=error.message;}
  finally{state.loading=false;if(root.isConnected)render();}
 }
 render();if(!previous)load();box.querySelector('[data-close-info]').focus({preventScroll:true});
}
