import {contextualIssues,lifeDomain} from './life-view.js';
import {escape,number,dateLabel} from './ui.js';

const kinds={all:'Tout',undated:'À dater',before:'Avant les premiers repères',future:'Dates futures',planned:'Prévu / réservé',cancelled:'Annulé',subject:'Personne concernée',action:'Actions'};
export function contextRows(events){const domain=lifeDomain(events);return events.filter(e=>e.reviewState!=='dismissed').map(event=>({event,issues:contextualIssues(event,domain)})).filter(r=>r.issues.length);}
export function showContextReview(popup,api,anchor){
 const rows=contextRows(api.state.events);let filter='all',limit=40;
 popup.info('',anchor);popup.makeModal();popup.root.querySelector('.popover').classList.add('context-review-popover');
 const target=popup.root.querySelector('.info-content');
 const render=()=>{
  const selected=rows.filter(r=>filter==='all'||r.issues.some(i=>i.kind===filter));
  target.innerHTML=`<p class="eyebrow">LES DÉTAILS QUI MÉRITENT UN REGARD</p><h3>Donner le bon contexte.</h3><p>Une date peut concerner un proche, une réservation ou un document. Ces repères sont conservés; leur place dans ton histoire reste à préciser.</p><div class="context-tabs">${Object.entries(kinds).map(([kind,label])=>{const count=kind==='all'?rows.length:rows.filter(r=>r.issues.some(i=>i.kind===kind)).length;return `<button type="button" data-context-kind="${kind}" aria-pressed="${filter===kind}" ${count?'':'disabled'}>${escape(label)} <span>${number(count)}</span></button>`;}).join('')}</div><div class="context-events">${selected.slice(0,limit).map(({event:e,issues})=>`<button type="button" data-context-event="${escape(e.id)}"><span>${issues.map(i=>`<small>${escape(i.label)}</small>`).join('')}</span><time>${escape(dateLabel(e))}</time><strong>${escape(e.title)}</strong>${e.reviewQuestions?.length?`<p>${escape(e.reviewQuestions[0])}</p>`:''}<span class="context-open">Lire et préciser ↗</span></button>`).join('')||'<p>Aucun relevé dans cette sélection.</p>'}</div>${selected.length>limit?`<button type="button" class="secondary-button" data-context-more>Afficher les suivants · ${number(selected.length-limit)} restants</button>`:''}<p class="context-footer">Ce repérage ne modifie aucune date et ne confirme aucun événement.</p>`;
  target.querySelectorAll('[data-context-kind]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.contextKind;limit=40;render();}));
  target.querySelectorAll('[data-context-event]').forEach(b=>b.addEventListener('click',()=>{
   const event=api.state.events.find(e=>e.id===b.dataset.contextEvent);api.open([event],anchor,true);
   const back=document.createElement('button');back.type='button';back.className='text-button connection-back';back.textContent='← Retour aux repères à préciser';back.addEventListener('click',()=>showContextReview(popup,api,anchor));popup.root.querySelector('.popup-body').prepend(back);
  }));
  target.querySelector('[data-context-more]')?.addEventListener('click',()=>{limit+=40;render();});popup.position();
 };
 render();popup.root.querySelector('[data-close-info]').focus({preventScroll:true});
}
