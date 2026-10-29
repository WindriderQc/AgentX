// Corrections Nestor proposed for moments of the owner's history. Nothing is
// applied until the owner accepts here; accepting goes through Core, at the
// revision Nestor saw, so a moment changed since then is never overwritten.
import {escape,icon,number,toast} from './ui.js';
import * as data from './data.js';

const labels={title:'Titre',description:'Récit',date:'Date',precision:'Précision de la date',endDate:'Fin',endPrecision:'Précision de la fin',
 ongoing:'Toujours en cours',category:'Thème',place:'Lieu',notes:'Notes',eventDate:'Date du souvenir',people:'Personnes',places:'Lieux',text:'Texte du souvenir',
 dateWindow:'Fenêtre de date',ageStartWindow:'Repère d’âge',ageEndWindow:'Repère d’âge de fin'};
const precisions={year:'année',month:'mois',day:'jour',instant:'instant',unknown:'inconnue'};
const categoryNames={home:'Lieux & maison',people:'Liens & famille',work:'Travail & études',travel:'Voyages & sorties',health:'Santé & équilibre',daily:'Petits & grands jours'};
export function show(key,value){
 if(value===null||value===undefined||value==='')return '—';
 if(Array.isArray(value))return value.length?value.join(', '):'—';
 if(typeof value==='boolean')return value?'oui':'non';
 if(typeof value==='object')return value.start&&value.end?`${value.start} → ${value.end}`:JSON.stringify(value);
 if(key==='precision'||key==='endPrecision')return precisions[value]||value;
 if(key==='category')return categoryNames[value]||value;
 return String(value);
}
const when=value=>{const t=Date.parse(value);return Number.isFinite(t)?new Intl.DateTimeFormat('fr-CA',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Toronto'}).format(t):'';};

export class ProposalInbox{
 constructor(popup,api,button){this.popup=popup;this.api=api;this.button=button;this.items=[];this.byEntry=new Map();
  button.addEventListener('click',e=>this.open(e.currentTarget));}
 async refresh(){
  if(this.api.state.dataset!=='real'){this.render();return;}
  try{const answer=await data.proposals();this.items=answer.proposals;this.pending=answer.pending;}catch{this.items=[];this.pending=0;}
  this.byEntry=new Map();for(const p of this.items)this.byEntry.set(`core-${p.entryId}`,[...(this.byEntry.get(`core-${p.entryId}`)||[]),p]);
  this.render();
 }
 render(){
  const n=this.api.state.dataset==='real'?this.pending||0:0;
  this.button.hidden=!n;this.button.innerHTML=`✦ Nestor propose <span>${number(n)}</span>`;
  this.button.setAttribute('aria-label',`${n} correction${n>1?'s':''} proposée${n>1?'s':''} par Nestor`);
 }
 // A notice in a moment's dossier when Nestor proposed something for it.
 banner(event){
  const list=this.byEntry.get(event.id)||[];if(!list.length)return '';
  return `<button type="button" class="proposal-banner" data-open-proposals>${icon('link')}<span><strong>Nestor propose ${list.length>1?`${list.length} corrections`:'une correction'}</strong><small>${escape(list[0].rationale.slice(0,140))}</small></span><span aria-hidden="true">↗</span></button>`;
 }
 card(p){
  const event=this.api.state.events.find(e=>e.id===`core-${p.entryId}`);
  const rows=Object.keys(p.changes).filter(k=>!['dateWindow','ageStartWindow','ageEndWindow'].includes(k)||p.before[k]);
  return `<article class="proposal-card" data-proposal="${escape(p.id)}"><header><p class="eyebrow">${p.target==='souvenir'?'SOUVENIR GARDÉ':'MOMENT À PRÉCISER'} · ${escape(when(p.createdAt))}</p><h4>${escape(event?.title||p.title)}</h4></header>
  <table class="proposal-diff"><thead><tr><th>Champ</th><th>Aujourd’hui</th><th>Nestor propose</th></tr></thead><tbody>${rows.map(k=>`<tr><th>${escape(labels[k]||k)}</th><td>${escape(show(k,p.before[k]))}</td><td class="proposal-new">${escape(show(k,p.changes[k]))}</td></tr>`).join('')}</tbody></table>
  <p class="proposal-why"><strong>Pourquoi :</strong> ${escape(p.rationale)}</p>${p.evidence.length?`<div class="proposal-evidence">${p.evidence.map(e=>`<figure><blockquote>${escape(e.quote)}</blockquote>${e.source?`<figcaption>${escape(e.source)}</figcaption>`:''}</figure>`).join('')}</div>`:''}
  <div class="proposal-actions"><button type="button" class="confirm-button" data-accept>✓ Accepter</button><button type="button" class="secondary-button" data-refuse>Refuser</button>${event?'<button type="button" class="text-button" data-open-moment>Ouvrir le moment ↗</button>':''}</div><p class="review-error" data-proposal-error role="alert" hidden></p></article>`;
 }
 async open(anchor){
  await this.refresh();
  const pending=this.items.filter(p=>p.state==='pending');
  this.popup.info(`<div class="proposals"><p class="eyebrow">NESTOR · PROPOSITIONS</p><h3>${pending.length?'Des précisions à valider.':'Rien en attente.'}</h3><p>Nestor propose des corrections à partir de vos conversations ou de tes sources. Rien ne change dans ta mémoire tant que tu n’acceptes pas.</p>${pending.map(p=>this.card(p)).join('')||'<p class="proposal-empty">Quand Nestor remarquera une date ou un détail à corriger, il le déposera ici.</p>'}</div>`,anchor);
  this.popup.makeModal();this.popup.root.querySelector('.popover').classList.add('proposals-popover');this.popup.position();
  for(const card of this.popup.root.querySelectorAll('[data-proposal]')){
   const p=pending.find(x=>x.id===card.dataset.proposal),error=card.querySelector('[data-proposal-error]');
   const busy=on=>card.querySelectorAll('button').forEach(b=>{b.disabled=on;});
   card.querySelector('[data-accept]').addEventListener('click',async()=>{
    busy(true);error.hidden=true;
    try{const result=await data.acceptProposal(p);this.api.adoptResult?.(result);toast('Correction appliquée dans AgentX.');card.classList.add('is-done');card.querySelector('.proposal-actions').innerHTML='<p class="proposal-done">✓ Acceptée</p>';}
    catch(e){error.textContent=e.message;error.hidden=false;busy(false);if(e.status===409)card.classList.add('is-stale');}
    await this.refresh();
   });
   card.querySelector('[data-refuse]').addEventListener('click',async()=>{
    const reason=window.prompt('Pourquoi refuser ? (Nestor verra ta réponse)','Ce n’est pas exact');if(reason===null)return;
    busy(true);error.hidden=true;
    try{await data.refuseProposal(p,reason);card.classList.add('is-done');card.querySelector('.proposal-actions').innerHTML='<p class="proposal-done">Refusée</p>';}
    catch(e){error.textContent=e.message;error.hidden=false;busy(false);}
    await this.refresh();
   });
   card.querySelector('[data-open-moment]')?.addEventListener('click',()=>{const event=this.api.state.events.find(e=>e.id===`core-${p.entryId}`);if(event)this.api.open([event],anchor,true);});
  }
 }
}
