// Corrects a moment's context in Core (POST /api/secretary/history/:id/context)
// before it is kept. Source records, quotes and review decisions stay immutable.
import {categories,escape,fold,icon,dateLabel} from './ui.js';

function eventTime(event){if(!event.date)return '';return event.precision==='year'?event.date.slice(0,4):event.precision==='month'?event.date.slice(0,7):event.date;}
function endTime(event){return event.ongoing||!event.endDate?'':eventTime({date:event.endDate,precision:event.endPrecision||event.precision});}

export class EventEditor{
 constructor(popup,api){this.popup=popup;this.api=api;this.searchSequence=0;this.sourceLabels=new Map();}
 open(event,anchor){
  clearTimeout(this.sourceTimer);this.searchSequence++;
  this.event=event;this.anchor=anchor;this.related=[...(event.relatedEventIds||[])];this.sources=[...(event.additionalSourceIds||[])];this.links=(event.links||[]).map(l=>({...l}));
  this.initial={title:event.title,description:event.description,eventTime:eventTime(event),endTime:endTime(event),ongoing:event.ongoing===true,category:event.category,place:event.place||'',rationale:event.rationale||'',notes:event.notes||'',relatedEventIds:[...this.related],links:this.links.map(l=>({...l}))};
  const original=event.originalExtraction||event;
  this.popup.info(`<form id="event-editor" class="event-editor"><p class="eyebrow">FAIRE GRANDIR MON HISTOIRE</p><h3>Préciser ce moment</h3><p class="editor-subtitle">Tes précisions sont enregistrées dans AgentX. Les sources et leurs citations restent intactes.</p>
   <label class="editor-label">Titre<input name="title" value="${escape(event.title)}" maxlength="300" required></label>
   <div class="editor-grid"><label class="editor-label">Début / date<input name="eventTime" value="${escape(eventTime(event))}" placeholder="2014, 2014-06 ou 2014-06-28" maxlength="10"><small>Année, mois ou jour. Vide si inconnu.</small></label></div>
   <label class="editor-label">Fin de la période<input name="endTime" value="${escape(endTime(event))}" placeholder="2017, 2017-08 ou 2017-08-31" maxlength="10" ${event.ongoing?'disabled':''}><small>Facultative. Une fin inconnue reste inconnue.</small></label>
   <label class="editor-ongoing"><input name="ongoing" type="checkbox" ${event.ongoing?'checked':''}>Cette période est toujours en cours</label>
   <p class="editor-time-hint">Début + fin : une bande dans le temps. Une date seule : un repère. Les dates approximatives conservent leur précision.</p>
   <div class="editor-grid"><label class="editor-label">Thème<select name="category">${Object.entries(categories).map(([key,c])=>`<option value="${key}" ${event.category===key?'selected':''}>${escape(c.label)}</option>`).join('')}</select></label><label class="editor-label">Lieu<input name="place" value="${escape(event.place||'')}" placeholder="Ville, endroit…" maxlength="500"></label></div>
   <label class="editor-label">Ce qui s’est passé<textarea name="description" rows="3" maxlength="20000">${escape(event.description)}</textarea></label>
   <label class="editor-label">Ce qui motive cette piste<textarea name="rationale" rows="2" maxlength="12000" placeholder="Les indices, les rapprochements, ce qui reste incertain…">${escape(event.rationale||'')}</textarea></label>
   <label class="editor-label">Mes détails complémentaires<textarea name="notes" rows="3" maxlength="12000" placeholder="Un souvenir, une précision, une personne présente…">${escape(event.notes||'')}</textarea></label>
   <section class="editor-section"><h4>${icon('link')} Relier à d’autres moments</h4><div data-linked-events class="editor-linked"></div><input id="event-link-search" type="search" placeholder="Rechercher un moment à associer…" aria-label="Rechercher un moment à associer" autocomplete="off"><div id="event-link-results" class="editor-results"></div></section>
   
   <section class="editor-section"><h4>${icon('external')} Liens et documents complémentaires</h4><div data-linked-urls class="editor-linked"></div><div class="editor-grid"><label class="editor-label">Nom du lien<input id="detail-link-label" maxlength="200" placeholder="Photo, document, contexte…"></label><label class="editor-label">Adresse web<input id="detail-link-url" type="url" placeholder="https://…"></label></div><button class="secondary-button" type="button" id="add-detail-link">+ Ajouter ce lien</button></section>
   <details class="editor-original"><summary>Voir l’extraction initiale</summary><strong>${escape(original.title)}</strong><p>${escape(original.description)}</p><small>Date initiale : ${escape(original.originalDate||original.date||'inconnue')}</small></details>
   <div id="editor-error" class="editor-error" role="alert" hidden></div><div class="editor-save-bar"><button class="secondary-button" type="button" id="editor-cancel">Retour</button><button class="primary-button" type="submit" id="editor-save">Enregistrer les précisions ${icon('arrow')}</button></div>
  </form>`,anchor);
  const box=this.popup.root.querySelector('.popover');box.classList.add('editor-popover');this.popup.makeModal();this.form=this.popup.root.querySelector('#event-editor');
  this.form.elements.ongoing.addEventListener('change',()=>{const end=this.form.elements.endTime;end.disabled=this.form.elements.ongoing.checked;if(end.disabled)end.value='';});
  this.form.addEventListener('submit',e=>{e.preventDefault();this.save();});
  this.form.querySelector('#editor-cancel').addEventListener('click',()=>this.popup.open([this.event],this.anchor,true));
  this.form.querySelector('#event-link-search').addEventListener('input',e=>this.findEvents(e.target.value));
  this.form.querySelector('#add-detail-link').addEventListener('click',()=>this.addLink());
  this.renderLinks();this.popup.position();
 }
 error(message){const el=this.form.querySelector('#editor-error');el.textContent=message;el.hidden=!message;this.popup.position();}
 renderLinks(){
  const linked=this.form.querySelector('[data-linked-events]');
  linked.innerHTML=this.related.map(id=>{const e=this.api.state.events.find(e=>e.id===id);return `<div class="editor-link-chip"><span>${icon('link')}${escape(e?.title||id)}</span><button type="button" data-remove-event="${escape(id)}" aria-label="Retirer ce lien">×</button></div>`;}).join('');
  linked.querySelectorAll('[data-remove-event]').forEach(b=>b.addEventListener('click',()=>{this.related=this.related.filter(id=>id!==b.dataset.removeEvent);this.renderLinks();}));
  const urls=this.form.querySelector('[data-linked-urls]');
  urls.innerHTML=this.links.map((l,i)=>`<div class="editor-link-chip"><span>${icon('external')}${escape(l.label)}</span><button type="button" data-remove-url="${i}" aria-label="Retirer ce lien web">×</button></div>`).join('');
  urls.querySelectorAll('[data-remove-url]').forEach(b=>b.addEventListener('click',()=>{this.links.splice(Number(b.dataset.removeUrl),1);this.renderLinks();}));
 }
 findEvents(query){
  const target=this.form.querySelector('#event-link-results');const terms=fold(query).trim().split(/\s+/).filter(Boolean);
  if(!terms.length){target.replaceChildren();return;}
  const matches=this.api.state.events.filter(e=>e.id!==this.event.id&&!this.related.includes(e.id)&&terms.every(t=>e.search.includes(t))).slice(0,8);
  target.innerHTML=matches.map(e=>`<button type="button" class="editor-result" data-link-event="${escape(e.id)}"><span>${escape(e.title)}<small>${escape(dateLabel(e))}</small></span><span>+</span></button>`).join('')||'<p class="editor-hint">Aucun moment trouvé.</p>';
  target.querySelectorAll('[data-link-event]').forEach(b=>b.addEventListener('click',()=>{this.related.push(b.dataset.linkEvent);this.form.querySelector('#event-link-search').value='';target.replaceChildren();this.renderLinks();this.popup.position();}));
 }
 addLink(){
  const label=this.form.querySelector('#detail-link-label'),url=this.form.querySelector('#detail-link-url');let parsed;
  try{parsed=new URL(url.value);}catch{this.error('Indiquer une adresse web complète pour ce lien.');return false;}
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password){this.error('Utiliser une adresse http ou https sans identifiants.');return false;}
  if(!label.value.trim()){this.error('Donner un nom à ce lien.');label.focus();return false;}
  this.links.push({label:label.value.trim(),href:parsed.href});label.value='';url.value='';this.error('');this.renderLinks();this.popup.position();
  return true;
 }
 async save(){
  if(!this.form.reportValidity())return;
  if((this.form.querySelector('#detail-link-label').value.trim()||this.form.querySelector('#detail-link-url').value.trim())&&!this.addLink())return;
  const f=this.form.elements,patch={},event=this.event;
  const time=value=>{const v=String(value||'').trim();if(!v)return {date:null,precision:'unknown'};
   if(/^\d{4}$/.test(v))return {date:v,precision:'year'};if(/^\d{4}-\d{2}$/.test(v))return {date:v,precision:'month'};if(/^\d{4}-\d{2}-\d{2}$/.test(v))return {date:v,precision:'day'};
   throw new Error('Une date s’écrit 2014, 2014-06 ou 2014-06-28.');};
  try{
   for(const key of ['title','description','category','place','rationale','notes'])if(f[key].value!==this.initial[key])patch[key]=f[key].value;
   if(f.eventTime.value!==this.initial.eventTime){Object.assign(patch,time(f.eventTime.value));patch.dateWindow=null;patch.ageStartWindow=null;}
   const ongoing=f.ongoing.checked,endTime=ongoing?'':f.endTime.value;
   if(endTime!==this.initial.endTime){const t=time(endTime);patch.endDate=t.date;patch.endPrecision=t.precision;patch.ageEndWindow=null;}
   if(ongoing!==this.initial.ongoing)patch.ongoing=ongoing;
   const related=this.related.map(id=>this.api.state.events.find(e=>e.id===id)?.core?.id).filter(Boolean);
   if(JSON.stringify(this.related)!==JSON.stringify(this.initial.relatedEventIds))patch.relatedEventIds=related;
   if(JSON.stringify(this.links)!==JSON.stringify(this.initial.links))patch.links=this.links;
  }catch(error){this.error(error.message);return;}
  const save=this.form.querySelector('#editor-save');save.disabled=true;this.error('');
  try{const updated=Object.keys(patch).length?await this.api.editContext(event,patch):event;this.popup.open([updated],this.anchor,true);this.api.toast(Object.keys(patch).length?'Précisions enregistrées dans AgentX.':'Aucun changement.');}
  catch(error){this.error(error.message);save.disabled=false;}
 }
}
