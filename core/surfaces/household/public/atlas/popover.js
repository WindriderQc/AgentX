import {durationLabel,temporalExtent} from './temporal.js';
import {categories,icon,escape,number,dateLabel} from './ui.js';
import {reviewState,reviewStates,reviewLabel} from './review.js';
import {sourcePanel,evidenceBlock} from './evidence.js';
import {eventConnections,showConnections} from './connections.js';
import {eventPhotoMarkup,photosForEvent,collectPhotos} from './gallery.js';
import {readSource} from './data.js';

// Core events: the decision goes to AgentX Core with the revision on screen.
const fmtDay=value=>{const t=Date.parse(value);return Number.isFinite(t)?new Intl.DateTimeFormat('fr-CA',{dateStyle:'long',timeZone:'America/Toronto'}).format(t):'date inconnue';};
function coreStatus(event){const c=event.core;return c.souvenirNoteId?'Gardé dans ta mémoire : Nestor le retrouve quand tu lui en parles.':c.reviewState==='dismissed'?'Écarté dans AgentX, conservé pour le contexte.':['retained','resolved'].includes(c.reviewState)?'Retenu dans AgentX, pas encore gardé comme souvenir.':'Proposé par la lecture de tes courriels. À relire avec sa source.';}
function coreActions(event){
 const c=event.core;
 const correction=c.souvenirNoteId?`<details class="core-correct"><summary>Corriger ce souvenir</summary><form data-core-correct><label>Date <input type="date" name="eventDate" value="${event.precision==='day'&&event.date?escape(event.date):''}"></label><label>Personnes <input name="people" value="${escape((event.people||[]).join(', '))}" placeholder="Séparées par des virgules"></label><label>Lieux <input name="places" value="${escape(event.place||'')}" placeholder="Séparés par des virgules"></label><label>Texte <textarea name="text" rows="3" maxlength="4000">${escape(event.description)}</textarea></label><button class="confirm-button" type="submit">Enregistrer dans ma mémoire</button><p class="popup-footer-note">Les sources du souvenir ne changent pas.</p></form></details>`:'';
 return `${correction}<div class="review-actions core-actions">${c.canEdit?`<button class="secondary-button" type="button" data-action="edit">Préciser ce moment ${icon('link')}</button>`:''}${c.canKeep?`<label class="core-date">Date du moment <input type="date" data-core-date value="${event.precision==='day'&&event.date?escape(event.date):''}"></label><button class="confirm-button" type="button" data-action="keep">✓ Garder comme souvenir</button>`:''}${c.canDismiss?'<button class="text-button" type="button" data-action="core-dismiss">Écarter</button>':''}</div>`;
}
const systemNames={gmail:'Courriel Gmail','outlook-export':'Courriel Outlook',document:'Document',media:'Photo',ledger:'Grand livre',testimony:'Ton témoignage',conversation:'Conversation',calendar:'Calendrier'};
function coreProvenance(event){
 const c=event.core,dated={core:'Date retenue dans AgentX',written:'Date écrite dans la source',none:'Date à préciser'}[event.dateOrigin]||'Date à préciser';
 const chips=[c.souvenirNoteId?'✦ Souvenir gardé':'◌ À relire',`${systemNames[c.sourceSystem]||'Source'} · ${fmtDay(event.sourceDate)}`,dated,`Révision ${number(c.revision)}`];
 const people=(event.people||[]).map(p=>`<button class="popup-pill core-person" type="button" data-person="${escape(p)}">${icon('heart')}${escape(p)}</button>`).join('');
 return `<section class="core-provenance"><div class="core-chips">${chips.map(t=>`<span>${escape(t)}</span>`).join('')}<button type="button" class="core-link" data-copy-link title="Copier le lien de ce moment">${icon('link')} Lien</button></div>${c.sourceStatus?`<p class="core-status">${escape(c.sourceStatus)}</p>`:''}${people?`<div class="popup-pills core-people">${people}</div>`:''}</section>`;
}

export class Popover {
 constructor(root,api){this.root=root;this.api=api;this.pinned=false;this.cache=new Map();this.sequence=0;this.timer=null;root.addEventListener('pointerenter',()=>clearTimeout(this.timer));root.addEventListener('pointerleave',()=>this.leave());document.addEventListener('pointerdown',e=>{if(this.root.children.length&&!this.root.contains(e.target)&&!e.target.closest('.moment,.discovery-item,.quiet-button,.icon-button,.category-filter'))this.close();});document.addEventListener('keydown',e=>{if(e.key==='Escape')this.close();if(e.key==='Tab'&&this.root.querySelector('[aria-modal=true]')){const items=[...this.root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary')].filter(x=>x.getClientRects().length);if(!items.length)return;const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});window.addEventListener('resize',()=>this.position());}
 leave(){clearTimeout(this.timer);if(!this.pinned)this.timer=setTimeout(()=>this.close(),220);}
 close(restore=true){clearTimeout(this.timer);const focus=this.returnFocus,wasModal=this.locked;this.sequence++;this.root.replaceChildren();this.pinned=false;this.event=null;this.point=null;this.api.select(null);if(this.locked){document.body.style.overflow=this.previousOverflow;this.locked=false;}this.suppressPreviewUntil=Date.now()+180;if(restore&&wasModal&&focus?.isConnected)focus.focus({preventScroll:true});}
 open(events,anchor,pinned=false,point=null){
  if(this.pinned&&!pinned)return;
  if(!pinned){if(Date.now()<(this.suppressPreviewUntil||0))return;return this.preview(events,anchor,point);}
  if(!this.pinned)this.returnFocus=document.activeElement;this.point=null;
  clearTimeout(this.timer);this.anchor=anchor;this.pinned=pinned;this.sequence++;this.events=events;
  const lead=[...events].sort((a,b)=>(this.api.state.favorites.has(b.id)?10:0)+b.importance-((this.api.state.favorites.has(a.id)?10:0)+a.importance)||a.ts-b.ts)[0];
  this.event=lead;this.api.select(lead.id);
  const cat=categories[lead.category],isCluster=events.length>1,state=reviewState(lead);
  this.root.innerHTML=`<div class="detail-backdrop" data-close-detail></div><section aria-modal="true" class="popover detail-popover ${pinned?'is-pinned':''}" style="--cat-color:${cat.color}" role="dialog" aria-label="${escape(lead.title)}"><div class="popup-scroll"><div class="popup-hero"><div class="hero-date">${escape(lead.date?(lead.ageStartWindow&&typeof lead.eventTime!=='string'?'≈ ':'')+lead.date.slice(0,4):'À dater')}<small>${escape(cat.label)}</small></div><div class="hero-icon">${icon(cat.icon)}</div><span class="hero-caption">Illustration symbolique</span><div class="popup-tools"><button type="button" data-action="pin" aria-label="Épingler la fenêtre" aria-pressed="${pinned}">${icon('pin')}</button><button type="button" data-action="close" aria-label="Fermer">${icon('close')}</button></div><span class="pin-note">Dossier de vie · détails et sources</span></div><div class="popup-body"><div class="popup-eyebrow"><span>${escape(dateLabel(lead))}</span><span>${isCluster?number(events.length)+' observations':'Un moment retrouvé'}</span></div><h2 class="popup-title">${escape(lead.title)}</h2><p class="popup-description">${escape(lead.description)}</p><div class="popup-pills"><span class="popup-pill">${icon('mail')}${lead.sourceIds.length} source${lead.sourceIds.length>1?'s':''}</span><span class="popup-pill">${icon('calendar')}${lead.ageStartWindow&&typeof lead.eventTime!=='string'?'Repère d’âge · date estimée':lead.endDate?'Période indiquée':lead.precision==='year'?'Année connue':lead.precision==='month'?'Mois connu':lead.date?'Jour indiqué · heure inconnue':'Date à préciser'}</span>${lead.attachments?`<span class="popup-pill">${icon('file')}${lead.attachments} pièce${lead.attachments>1?'s':''} jointe${lead.attachments>1?'s':''}</span>`:''}</div><dl class="popup-meta"><div><dt>Correspondance</dt><dd>${escape(lead.correspondent||'À préciser')}</dd></div><div><dt>Nature</dt><dd>${escape(lead.status)}</dd></div>${lead.place?`<div><dt>Lieu</dt><dd>${escape(lead.place)}</dd></div>`:''}<div><dt>Source</dt><dd>${escape(lead.subject||'Sans objet')}</dd></div></dl><div class="popup-actions"><button class="primary-button" type="button" data-action="sources">${icon('mail')} Lire les sources</button><button class="secondary-button" type="button" data-action="zoom">${icon('arrow')} Explorer ici</button><button class="secondary-button" type="button" data-action="favorite" aria-label="${this.api.state.favorites.has(lead.id)?'Retirer des repères':'Ajouter aux repères'}" aria-pressed="${this.api.state.favorites.has(lead.id)}">${this.api.state.favorites.has(lead.id)?'★':'☆'}</button></div><div data-sources hidden></div>${isCluster?`<h3 class="related-heading">Dans cette fenêtre du temps</h3><div class="popup-list">${[...events].sort((a,b)=>a.ts-b.ts).slice(0,35).map(e=>`<button class="related-event" type="button" data-event="${escape(e.id)}"><time>${escape(dateLabel(e,true))}</time><strong>${escape(e.title)}</strong></button>`).join('')}</div>${events.length>35?`<p class="cluster-caption">${number(events.length-35)} autres observations. « Explorer ici » permet de les déployer.</p>`:''}`:this.related(lead)}<p class="popup-footer-note">${lead.origin==='demo'?'Scénario entièrement fictif.':lead.core?'Lu dans AgentX Core. Les sources sont les messages archivés, lus avec leur empreinte.':'Moment proposé depuis les archives. Les sources permettent de vérifier le contexte.'}</p></div></div></section>`;
  const body=this.root.querySelector('.popup-body');
  const photos=collectPhotos(this.api.state.events);
  body.querySelector('.popup-description').insertAdjacentHTML('afterend',eventPhotoMarkup(photos,lead));
  body.querySelectorAll('[data-photo]').forEach(b=>b.addEventListener('click',()=>this.api.photoOpen(b.dataset.photo,b,{pool:photosForEvent(photos,lead),event:lead})));
  const review=document.createElement('div');review.className='review-panel';
  review.innerHTML=`<div class="review-status review-${state}"><span class="review-symbol" aria-hidden="true">${reviewStates[state].symbol}</span><div><strong>${escape(reviewLabel(lead))}</strong><span>${lead.core?escape(coreStatus(lead)):state==='hypothesis'?'Un rapprochement proposé par l’analyse.':state==='unreviewed'?'Une observation à relire ou à préciser.':state==='dismissed'?'Conservé pour garder le contexte.':'Cet élément a été validé dans cet atlas.'}</span></div></div>${lead.rationale?`<div class="review-rationale"><strong>Indices et points à vérifier</strong><p>${escape(lead.rationale)}</p></div>`:''}${lead.core?coreActions(lead):`<p class="popup-footer-note">Démonstration en lecture seule.</p>`}<p class="review-error" data-review-error role="alert" hidden></p>`;
  body.querySelector('.popup-description').after(review);
  review.insertAdjacentHTML('afterend',evidenceBlock(lead));
  if(lead.core)review.insertAdjacentHTML('afterbegin',coreProvenance(lead));
  const connectionDetails=document.createElement('div');connectionDetails.innerHTML=`${lead.enrichments?.some(e=>e.summary!==lead.description)?`<section class="enrichment-note"><strong>Ce que la nouvelle passe ajoute</strong>${lead.enrichments.filter(e=>e.summary!==lead.description).map(e=>`<p>${escape(e.summary)}</p>`).join('')}</section>`:''}`+eventConnections(lead,this.api.state);body.querySelector('.review-panel').before(connectionDetails);
  const details=document.createElement('div');details.className='personal-details';
  const linked=(lead.relatedEventIds||[]).map(id=>this.api.state.events.find(e=>e.id===id)).filter(Boolean);
  details.innerHTML=`${lead.notes?`<section class="personal-note"><h3>Mes détails</h3><p>${escape(lead.notes)}</p></section>`:''}${linked.length?`<h3 class="related-heading">Moments associés</h3>${linked.map(e=>`<button class="related-event" type="button" data-event="${escape(e.id)}"><time>${escape(dateLabel(e,true))}</time><strong>${escape(e.title)}</strong></button>`).join('')}`:''}${lead.links?.length?`<h3 class="related-heading">Liens complémentaires</h3><div class="detail-links">${lead.links.map(l=>this.detailLink(l)).join('')}</div>`:''}${lead.reviewUpdatedAt?`<p class="review-updated">Précisions enregistrées le ${escape(new Intl.DateTimeFormat('fr-CA',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Toronto'}).format(new Date(lead.reviewUpdatedAt)))}</p>`:''}`;
  body.querySelector('[data-sources]').after(details);
  const timing=document.createElement('div');timing.className='temporal-summary';timing.innerHTML=icon('calendar')+escape(durationLabel(lead));body.querySelector('.popup-title').after(timing);
  this.lockPage();this.bind();this.position();this.root.querySelector('[data-action=close]')?.focus({preventScroll:true});
 }
 related(event){
  const excluded=new Set([event.id,...event.relatedEventIds||[]]);
  let rows=this.api.state.events.filter(e=>!excluded.has(e.id)&&!!event.threadId&&e.threadId===event.threadId).slice(0,4);
  let heading='Le même fil de correspondance';
  if(!rows.length&&event.ts){rows=this.api.state.events.filter(e=>!excluded.has(e.id)&&e.ts&&e.category===event.category&&Math.abs(e.ts-event.ts)<180*86400000).sort((a,b)=>Math.abs(a.ts-event.ts)-Math.abs(b.ts-event.ts)).slice(0,3).sort((a,b)=>a.ts-b.ts);heading='Autour de ce moment';}
  if(!rows.length)return '';
  return `<h3 class="related-heading">${heading}</h3>${rows.map(e=>`<button class="related-event" type="button" data-event="${escape(e.id)}"><time>${escape(dateLabel(e,true))}</time><strong>${escape(e.title)}</strong></button>`).join('')}`;
 }
 bind(){
  this.root.querySelectorAll('[data-connection]').forEach(b=>b.addEventListener('click',()=>showConnections(this,this.api,this.anchor,{eventId:this.event.id,relationId:b.dataset.connection})));
  this.root.querySelector('[data-close-detail]')?.addEventListener('click',()=>this.close());
  this.root.querySelector('[data-action=close]')?.addEventListener('click',()=>this.close());
  this.root.querySelector('[data-action=pin]')?.addEventListener('click',()=>{this.pinned=!this.pinned;this.root.querySelector('.popover').classList.toggle('is-pinned',this.pinned);this.root.querySelector('[data-action=pin]').setAttribute('aria-pressed',String(this.pinned));this.root.querySelector('.pin-note').textContent=this.pinned?'Fenêtre épinglée':'Cliquer pour garder cette fenêtre ouverte';});
  this.root.querySelector('.popup-hero')?.addEventListener('click',e=>{if(e.target.closest('button'))return;this.pinned=true;this.root.querySelector('.popover').classList.add('is-pinned');this.root.querySelector('.pin-note').textContent='Dossier de vie · détails et sources';});
  this.root.querySelector('[data-action=zoom]')?.addEventListener('click',()=>{const dates=this.events.map(e=>e.ts).filter(Boolean);if(!dates.length){this.api.toast('Ce souvenir attend encore une date.');return;}this.api.focus(this.events);this.close();});
  this.root.querySelector('[data-action=favorite]')?.addEventListener('click',e=>{this.api.favorite(this.event.id);const favorite=this.api.state.favorites.has(this.event.id);e.currentTarget.textContent=favorite?'★':'☆';e.currentTarget.setAttribute('aria-pressed',String(favorite));e.currentTarget.setAttribute('aria-label',favorite?'Retirer des repères':'Ajouter aux repères');this.pinned=true;});
  this.root.querySelector('[data-action=sources]')?.addEventListener('click',()=>this.showSources());
  for(const [action,state]of [['confirm','confirmed'],['dismiss','dismissed'],['reconsider','unreviewed']])this.root.querySelector(`[data-action=${action}]`)?.addEventListener('click',e=>this.changeReview(state,e.currentTarget));
  this.root.querySelector('[data-action=keep]')?.addEventListener('click',e=>this.coreDecision('souvenir',e.currentTarget));
  this.root.querySelector('[data-action=core-dismiss]')?.addEventListener('click',e=>this.coreDecision('dismiss',e.currentTarget));
  this.root.querySelectorAll('[data-person]').forEach(b=>b.addEventListener('click',()=>this.api.showPerson(b.dataset.person,this.anchor)));
  this.root.querySelector('[data-core-correct]')?.addEventListener('submit',e=>{e.preventDefault();this.coreCorrect(e.currentTarget);});
  this.root.querySelector('[data-action=edit]')?.addEventListener('click',()=>this.api.edit(this.event,this.anchor));
  this.root.querySelector('[data-copy-link]')?.addEventListener('click',async()=>{const url=`${location.origin}${location.pathname}${this.event.link}`;try{await navigator.clipboard.writeText(url);this.api.toast('Lien copié.');}catch{window.prompt('Lien de ce moment',url);}});
  if(this.event?.link&&location.hash!==this.event.link)history.replaceState(null,'',this.event.link);
  this.root.querySelectorAll('[data-event]').forEach(b=>{const e=this.api.state.events.find(e=>e.id===b.dataset.event);if(e){const mark=document.createElement('span');mark.className='review-mini';mark.textContent=reviewStates[reviewState(e)].symbol;mark.setAttribute('aria-label',reviewLabel(e));b.append(mark);}b.addEventListener('click',()=>{if(e)this.open([e],this.anchor,true);});});
 }
 async changeReview(state,button){
  const sequence=this.sequence,event=this.event,anchor=this.anchor;this.pinned=true;button.disabled=true;
  try{const updated=await this.api.saveEvent(event,{reviewState:state});if(sequence===this.sequence)this.open([updated],anchor,true);this.api.toast(state==='confirmed'?'Moment confirmé.':state==='dismissed'?'Élément écarté, toujours retrouvable avec le filtre.':'Élément remis à vérifier.');}
  catch(error){if(sequence===this.sequence){const target=this.root.querySelector('[data-review-error]');target.textContent=error.message;target.hidden=false;button.disabled=false;this.position();}}
 }
  async coreCorrect(form){
  const sequence=this.sequence,event=this.event,anchor=this.anchor,values=new FormData(form);
  const list=value=>String(value||'').split(',').map(v=>v.trim()).filter(Boolean);
  const changes={},date=values.get('eventDate')||'',people=list(values.get('people')),places=list(values.get('places')),text=String(values.get('text')||'').trim();
  if(date!==(event.precision==='day'&&event.date?event.date:''))changes.eventDate=date;
  if(people.join('|')!==(event.people||[]).join('|'))changes.people=people;
  if(places.join('|')!==list(event.place).join('|'))changes.places=places;
  if(text&&text!==event.description)changes.text=text;
  if(!Object.keys(changes).length){this.api.toast('Aucune correction à enregistrer.');return;}
  if(!window.confirm('Enregistrer cette correction dans ta mémoire ? Nestor verra le souvenir corrigé.'))return;
  const button=form.querySelector('button');button.disabled=true;
  try{const updated=await this.api.correct(event,changes);if(sequence===this.sequence)this.open([updated],anchor,true);this.api.toast('Souvenir corrigé dans AgentX.');}
  catch(error){if(sequence===this.sequence){const target=this.root.querySelector('[data-review-error]');target.textContent=error.message;target.hidden=false;button.disabled=false;this.position();}}
 }
 async coreDecision(action,button){
  const sequence=this.sequence,event=this.event,anchor=this.anchor;this.pinned=true;
  let extra={};
  if(action==='souvenir'){
   const date=this.root.querySelector('[data-core-date]')?.value||'';
   if(!window.confirm(`Garder ce moment comme souvenir permanent dans ta mémoire ?\n\n${event.description.slice(0,240)}${date?`\n\nDate : ${date}`:''}`))return;
   if(date&&!(event.precision==='day'&&event.date===date))extra={eventDate:date};
  }else{
   const reason=window.prompt('Pourquoi écarter ce moment ? (gardé dans AgentX avec la décision)','Pas un moment de ma vie');
   if(reason===null)return;extra={reason};
  }
  button.disabled=true;
  try{const updated=await this.api.decide(event,action,extra);if(sequence===this.sequence)this.open([updated],anchor,true);this.api.toast(action==='souvenir'?'Souvenir gardé dans AgentX : Nestor peut maintenant le retrouver.':'Moment écarté dans AgentX, toujours retrouvable avec le filtre.');}
  catch(error){if(sequence===this.sequence){const target=this.root.querySelector('[data-review-error]');target.textContent=error.message;target.hidden=false;button.disabled=false;this.position();}}
 }
 detailLink(link){try{const url=new URL(link.href);return ['http:','https:'].includes(url.protocol)?`<a href="${escape(url.href)}" target="_blank" rel="noreferrer">${icon('external')}${escape(link.label)}</a>`:'';}catch{return '';}}
 lockPage(){if(!this.locked){this.previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';this.locked=true;}}
 makeModal(){const box=this.root.querySelector('.popover');if(!box)return;this.returnFocus=this.anchor;this.lockPage();box.classList.add('detail-popover');box.setAttribute('aria-modal','true');if(!this.root.querySelector('.detail-backdrop')){const backdrop=document.createElement('div');backdrop.className='detail-backdrop';backdrop.addEventListener('click',()=>this.close());this.root.prepend(backdrop);}this.position();}
 preview(events,anchor,point){
  clearTimeout(this.timer);this.sequence++;this.anchor=anchor;this.point=point;this.events=events;this.pinned=false;
  const lead=[...events].sort((a,b)=>b.importance-a.importance||a.ts-b.ts)[0],cat=categories[lead.category],state=reviewState(lead);this.event=lead;this.api.select(lead.id);
  const count=events.length,sourceCount=new Set(events.flatMap(e=>e.sourceIds)).size;
  const extent=temporalExtent(lead),time=count===1?dateLabel(lead):`${Math.min(...events.map(e=>new Date(e.date).getUTCFullYear()))} — ${Math.max(...events.map(e=>new Date(e.endDate||e.date).getUTCFullYear()))}`;
  this.root.innerHTML=`<section class="popover preview-popover" style="--cat-color:${cat.color}" role="dialog" aria-label="Aperçu de ${escape(lead.title)}"><div class="preview-body"><div class="preview-category">${icon(cat.icon)}${escape(cat.label)}<span>· ${count>1?number(count)+' éléments':extent?.kind==='period'?'Période':'Repère'}</span></div><h2 class="preview-title">${escape(count>1?number(count)+' moments dans cette zone':lead.title)}</h2><p class="preview-dates">${escape(time)}</p>${count===1?`<p class="preview-duration">${escape(durationLabel(lead))}</p><p class="preview-description">${escape(lead.description)}</p>`:`<div class="preview-list">${events.slice(0,3).map(e=>`<div>${escape(e.title)}</div>`).join('')}${count>3?`<div>+ ${number(count-3)} autres éléments</div>`:''}</div>`}<div class="preview-status"><strong>${escape(reviewLabel(lead))}</strong><span>${number(sourceCount)} source${sourceCount>1?'s':''}</span>${lead.occurrenceStatus==='planned'?'<span>Prévu · présence à vérifier</span>':lead.occurrenceStatus==='documented'?'<span>Document daté</span>':''}${count===1&&lead.evidenceCheck?.status==='passed'?`<span>${number(lead.evidenceCheck.quoteCount)} extraits contrôlés</span>`:''}${count===1&&this.api.state.connectionIndex?.get(lead.id)?.length?`<span>${number(this.api.state.connectionIndex.get(lead.id).length)} recoupements</span>`:''}</div><div class="preview-footer"><span>Cliquer sur la frise pour tout voir</span><button class="text-button" type="button" data-open-detail>Ouvrir le dossier ↗</button></div></div></section>`;
  this.root.querySelector('[data-open-detail]').addEventListener('click',()=>this.open(events,anchor,true));this.position();
 }
 position(){
  const box=this.root.querySelector('.popover');if(!box)return;
  const width=box.offsetWidth,height=Math.min(box.scrollHeight,innerHeight-24);
  if(box.classList.contains('detail-popover')){box.style.left=Math.max(10,(innerWidth-width)/2)+'px';box.style.top=Math.max(10,(innerHeight-Math.min(box.offsetHeight,innerHeight-40))/2)+'px';return;}
  const rect=this.point?{left:this.point.x,top:this.point.y,right:this.point.x+4,bottom:this.point.y+4}:this.anchor?.isConnected?this.anchor.getBoundingClientRect():{left:innerWidth/2,top:120,right:innerWidth/2,bottom:160};
  let left=rect.right+14,top=rect.top-20;if(innerWidth<760){left=(innerWidth-width)/2;top=Math.max(12,Math.min(rect.bottom+10,innerHeight-height-12));}else{if(left+width>innerWidth-12)left=rect.left-width-14;if(left<12)left=Math.min(innerWidth-width-12,rect.left);top=Math.max(12,Math.min(top,innerHeight-height-12));}
  box.style.left=Math.max(12,left)+'px';box.style.top=Math.max(12,top)+'px';
 }

 async showSources(loadMore=false){
  const target=this.root.querySelector('[data-sources]');if(!target)return;
  if(!target.hidden&&!loadMore){target.hidden=true;this.root.querySelector('[data-action=sources]').innerHTML=icon('mail')+' Lire les sources';this.position();return;}
  this.sourceLimit=loadMore?(this.sourceLimit||6)+6:6;
  this.pinned=true;this.root.querySelector('.popover').classList.add('is-pinned');this.root.querySelector('.pin-note').textContent='Dossier de vie · détails et sources';target.hidden=false;target.innerHTML='<div class="popup-status">Ouverture des sources…</div>';this.root.querySelector('[data-action=sources]').innerHTML=icon('mail')+' Masquer les sources';
  const sequence=this.sequence;
  try{
   const items=await Promise.all(this.event.sourceIds.filter(Boolean).slice(0,this.sourceLimit).map(async id=>{if(this.cache.has(id))return this.cache.get(id);const value=await readSource(id);this.cache.set(id,value);return value;}));
   if(sequence!==this.sequence)return;
   target.innerHTML=items.map(sourcePanel).join('')||'<p class="popup-status">Aucune source liée disponible.</p>';
   if(this.event.sourceIds.length>this.sourceLimit){const more=document.createElement('button');more.type='button';more.className='secondary-button';more.textContent=`Afficher les sources suivantes (${this.event.sourceIds.length-this.sourceLimit} restantes)`;more.addEventListener('click',()=>this.showSources(true));target.append(more);}
   this.position();
  }catch(error){if(sequence===this.sequence)target.innerHTML=`<p class="popup-status">${escape(error.message)}</p>`;}
 }
 gmailLink(source){try{const u=new URL(source.gmailUrl);return u.protocol==='https:'&&u.hostname==='mail.google.com'?`<a href="${escape(u.href)}" target="_blank" rel="noreferrer">Ouvrir le fil dans Gmail ↗</a>`:'';}catch{return '';}}
 info(html,anchor){this.close(false);this.anchor=anchor;this.pinned=true;this.root.innerHTML=`<section class="popover is-pinned" role="dialog" aria-label="Informations"><div class="popup-scroll"><div class="popup-tools"><button type="button" data-close-info aria-label="Fermer">${icon('close')}</button></div><div class="info-content">${html}</div></div></section>`;this.root.querySelector('[data-close-info]').addEventListener('click',()=>this.close());this.position();}
}
