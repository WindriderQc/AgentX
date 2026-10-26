import {escape,fold,number,dateLabel} from './ui.js';
import {reviewState,reviewLabel} from './review.js';
import {isLifeMoment} from './life-view.js';

// Owner-selected subjects guide discovery; they do not create or confirm events.
export function storyThreads(value){return (Array.isArray(value)?value:[]).slice(0,12).filter(t=>t&&/^[a-z0-9-]{1,80}$/.test(t.id)&&typeof t.label==='string').map(t=>({id:t.id,label:t.label.slice(0,120),hint:String(t.hint||'').slice(0,500),eventIds:(Array.isArray(t.eventIds)?t.eventIds:[]).filter(id=>typeof id==='string').slice(0,30),queries:(Array.isArray(t.queries)?t.queries:[]).filter(Array.isArray).slice(0,10).map(q=>q.filter(v=>typeof v==='string'&&v.trim()).slice(0,5).map(v=>fold(v.slice(0,100)))).filter(q=>q.length)}));}
export function matchesStoryThread(event,thread){
 if(thread.eventIds?.some(id=>event.id===id||event.core?.id===id||event.legacyId===id||event.legacyIds?.includes(id)))return true;
 const text=fold([event.title,event.description,event.originalDate].join(' '));
 return thread.queries?.some(q=>q.every(term=>text.includes(fold(term))))||false;
}
export function threadMatches(events,thread){return events.filter(e=>isLifeMoment(e)&&reviewState(e)!=='dismissed'&&matchesStoryThread(e,thread));}
export function renderStoryThreads(root,popup,api){
 const threads=storyThreads(api.state.meta.displayPreferences?.storyThreads);root.hidden=api.state.dataset==='demo'||!threads.length;
 root.innerHTML=`<span class="eyebrow">TES FILS ROUGES</span><div class="story-thread-rail">${threads.map(t=>{const found=threadMatches(api.state.events,t);return `<button type="button" data-story-thread="${t.id}"><strong>${escape(t.label)}</strong><small>${found.length?`${number(found.length)} trace${found.length>1?'s':''}${found.every(e=>!e.date)?' · à dater':''}`:'À retrouver'}</small><span aria-hidden="true">↗</span></button>`;}).join('')}</div>`;
 function show(thread,anchor){
  const matches=threadMatches(api.state.events,thread).sort((a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999')));
  popup.info(`<p class="eyebrow">UN FIL QUE TU AS CHOISI</p><h3>${escape(thread.label)}</h3>${thread.hint?`<p>${escape(thread.hint)}</p>`:''}<p>${number(matches.length)} traces retrouvées dans les moments de vie. Les dates et la validation de chaque trace restent visibles dans son dossier.</p><div class="story-thread-events">${matches.slice(0,80).map(e=>`<button type="button" class="related-event" data-thread-event="${escape(e.id)}"><time>${escape(dateLabel(e))}</time><span><strong>${escape(e.title)}</strong><small>${escape(reviewLabel(e))}</small></span><span>↗</span></button>`).join('')||'<p>Ce début de chapitre reste à retrouver dans les sources. Aucune date n’a été déduite pour le remplir.</p>'}</div><p class="popup-footer-note">Un regroupement par sujet, choisi par toi. Les correspondances ne sont pas des confirmations supplémentaires.</p>`,anchor);
  popup.makeModal();popup.root.querySelector('.popover').classList.add('story-thread-popover');
  popup.root.querySelectorAll('[data-thread-event]').forEach(b=>b.addEventListener('click',()=>{const event=api.state.events.find(e=>e.id===b.dataset.threadEvent);api.open([event],anchor,true);const back=document.createElement('button');back.type='button';back.className='text-button';back.textContent='← Retour à ce fil';back.addEventListener('click',()=>show(thread,anchor));popup.root.querySelector('.popup-body').prepend(back);}));
  popup.root.querySelector('[data-close-info]').focus({preventScroll:true});
 }
 root.querySelectorAll('[data-story-thread]').forEach(b=>b.addEventListener('click',()=>show(threads.find(t=>t.id===b.dataset.storyThread),b)));
}
