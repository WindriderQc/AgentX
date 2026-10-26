import {escape,icon,dateLabel,number} from './ui.js';
import {reviewState,reviewLabel} from './review.js';
import {milestone} from './highlights.js';
import {sourcePanel} from './evidence.js';
import {readSource} from './data.js';

export function reviewCandidates(events){
 return events.filter(e=>['hypothesis','unreviewed'].includes(reviewState(e))).sort((a,b)=>{
  const score=e=>(e.confirmationBasis==='owner-tentative'?100:0)+(milestone(e)?30:0)+(e.extractionPass>=3?10:0)+(e.reviewState==='hypothesis'?5:0);
  return score(b)-score(a)||String(a.date||'9999').localeCompare(String(b.date||'9999'))||a.id.localeCompare(b.id);
 });
}

export function startReview(popup,api,anchor,{seen=new Set()}={}){
 const batch=reviewCandidates(api.state.filtered.filter(e=>api.state.categories.has(e.category))).filter(e=>!seen.has(e.id)).slice(0,5);
 let cursor=0,confirmed=0,skipped=0,discarded=0;
 const dataset=api.state.dataset;
 function show(){
  if(api.state.dataset!==dataset)return;
  if(cursor>=batch.length){
   popup.info(`<div class="review-complete"><span class="review-complete-icon">✓</span><p class="eyebrow">UNE HISTOIRE QUI SE PRÉCISE</p><h3>${batch.length?'Voilà, une petite passe de faite.':'Tout est à jour dans cette sélection.'}</h3><p>${confirmed?`${number(confirmed)} confirmé${confirmed>1?'s':''}. `:''}${skipped?`${number(skipped)} gardé${skipped>1?'s':''} pour plus tard. `:''}${discarded?`${number(discarded)} écarté${discarded>1?'s':''}.`:''}</p>${batch.length?`<button class="primary-button" type="button" data-next-batch>Encore cinq ? ${icon('arrow')}</button>`:''}</div>`,anchor);popup.makeModal();popup.root.querySelector('[data-next-batch]')?.addEventListener('click',()=>startReview(popup,api,anchor,{seen}));popup.root.querySelector('[data-close-info]').focus();return;
  }
  const event=api.state.events.find(e=>e.id===batch[cursor].id)||batch[cursor];
  const quotes=(event.claimsWithExactQuotes||[]).filter(e=>e.quote).slice(0,2);
  popup.info(`<div class="review-sprint"><div class="review-sprint-top"><span class="eyebrow">CINQ MOMENTS, À TON RYTHME</span><span>${cursor+1} / ${batch.length}</span></div><div class="review-progress" aria-label="${cursor} sur ${batch.length} examinés">${batch.map((_,i)=>`<i class="${i<cursor?'done':i===cursor?'current':''}"></i>`).join('')}</div><p class="review-sprint-date">${escape(dateLabel(event))} <span>· ${escape(reviewLabel(event))}</span></p><h3>${escape(event.title)}</h3><p>${escape(event.description)}</p>${event.dateEstimateNote||event.ageDateNote?`<p class="review-estimate">${escape(event.dateEstimateNote||event.ageDateNote)}</p>`:''}${event.reviewQuestions?.length?`<p class="review-question">${escape(event.reviewQuestions[0])}</p>`:''}<div class="review-sprint-quotes">${quotes.map(q=>`<blockquote>${escape(q.quote)}</blockquote>`).join('')}</div><button type="button" class="text-button" data-sprint-source>Lire les sources (${event.sourceIds.length}) ↗</button><div data-sprint-sources hidden></div><p class="review-sprint-error" role="alert" hidden></p><div class="review-sprint-actions"><button type="button" class="primary-button" data-sprint-confirm>✓ C’est juste</button><button type="button" class="secondary-button" data-sprint-edit>Préciser / corriger</button><button type="button" class="text-button" data-sprint-skip>Plus tard →</button></div><button type="button" class="text-button review-sprint-dismiss" data-sprint-dismiss>Écarter cet élément</button><p class="review-sprint-note">Confirmer valide le contenu et sa précision actuelle. Tu peux garder une date approximative.</p></div>`,anchor);
  popup.makeModal();popup.root.querySelector('.popover').classList.add('review-session-popover');popup.position();
  const confirm=popup.root.querySelector('[data-sprint-confirm]');
  async function save(state){
   const sequence=popup.sequence,buttons=[...popup.root.querySelectorAll('.review-sprint button')];buttons.forEach(b=>b.disabled=true);
   try{await api.saveEvent(event,{reviewState:state});seen.add(event.id);if(state==='confirmed')confirmed++;else discarded++;cursor++;if(sequence===popup.sequence)show();api.toast(state==='confirmed'?'Moment confirmé.':'Élément écarté.');}
   catch(error){if(sequence===popup.sequence){const box=popup.root.querySelector('.review-sprint-error');box.textContent=error.message;box.hidden=false;buttons.forEach(b=>b.disabled=false);}}
  }
  confirm.addEventListener('click',()=>save('confirmed'));
  popup.root.querySelector('[data-sprint-dismiss]').addEventListener('click',()=>save('dismissed'));
  popup.root.querySelector('[data-sprint-skip]').addEventListener('click',()=>{seen.add(event.id);skipped++;cursor++;show();});
  popup.root.querySelector('[data-sprint-edit]').hidden=true;
  popup.root.querySelector('[data-sprint-source]').addEventListener('click',async e=>{
   const target=popup.root.querySelector('[data-sprint-sources]'),sequence=popup.sequence;target.hidden=!target.hidden;if(target.hidden)return;
   target.textContent='Ouverture des sources…';
   try{const sources=await Promise.all(event.sourceIds.slice(0,4).map(id=>readSource(id)));if(sequence===popup.sequence){target.innerHTML=sources.map(sourcePanel).join('');popup.position();}}
   catch(error){if(sequence===popup.sequence)target.textContent=error.message;}
  });
  popup.root.querySelector('[data-close-info]').focus({preventScroll:true});
 }
 show();
}
