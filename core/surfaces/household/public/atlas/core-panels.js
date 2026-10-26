// Panels that read AgentX Core directly: source search through the owner's
// private recall (the same corpus as Nestor's mail_recall) and the people registry.
import {escape,icon,number,dateLabel} from './ui.js';
import {sourcePanel} from './evidence.js';
import * as data from './data.js';
import {sourceId} from './projection.js';

const day=value=>{const t=Date.parse(value);return Number.isFinite(t)?new Intl.DateTimeFormat('fr-CA',{dateStyle:'medium',timeZone:'America/Toronto'}).format(t):'';};
function bindSources(container,popup){
 container.querySelectorAll('[data-read-source]').forEach(b=>b.addEventListener('click',async()=>{
  const target=b.closest('[data-source-row]').querySelector('[data-source-text]');
  if(!target.hidden){target.hidden=true;return;}
  target.hidden=false;target.textContent='Lecture de la source archivée…';b.disabled=true;
  try{target.innerHTML=sourcePanel(await data.readSource(b.dataset.readSource));}catch(error){target.textContent=error.message;}
  finally{b.disabled=false;popup.position();}
 }));
}

export function showRecall(popup,api,anchor){
 popup.info(`<h3>Chercher dans mes archives</h3><p>Recherche dans le rappel privé d’AgentX : courriels, pièces lues, souvenirs et personnes. C’est le même corpus que Nestor consulte.</p><form class="date-picker" data-recall-form><input type="search" name="q" minlength="2" maxlength="300" placeholder="Un nom, un lieu, un événement…" aria-label="Chercher dans mes archives" required><button type="submit" class="primary-button">Chercher</button></form><p class="popup-status" data-recall-status role="status"></p><div class="popup-list" data-recall-results></div>`,anchor);
 popup.makeModal();
 const root=popup.root,form=root.querySelector('[data-recall-form]'),status=root.querySelector('[data-recall-status]'),list=root.querySelector('[data-recall-results]');
 form.querySelector('input').focus();
 form.addEventListener('submit',async e=>{
  e.preventDefault();const q=new FormData(form).get('q').trim();if(q.length<2)return;
  status.textContent='Recherche dans AgentX…';list.replaceChildren();
  try{
   const sources=await data.recall(q);
   status.textContent=sources.length?`${number(sources.length)} résultat${sources.length>1?'s':''} · du plus proche au moins proche`:'Aucun résultat dans le rappel privé.';
   list.innerHTML=sources.map(s=>`<article class="recall-row" data-source-row><p><time>${escape(day(s.date))}</time> <strong>${escape(s.subject)}</strong>${s.from?` · ${escape(s.from)}`:''}</p><p class="recall-excerpt">${escape(s.excerpt)}</p>${/^gmail\|/.test(s.id||'')?`<button type="button" class="text-button" data-read-source="${escape(s.id)}">Lire la source ${s.filename?'(message qui porte la pièce) ':''}↗</button>`:''}${s.personId?`<button type="button" class="text-button" data-open-person="${escape(s.personId)}" data-person-name="${escape(s.subject)}">Voir la fiche ↗</button>`:''}<div data-source-text hidden></div></article>`).join('');
   bindSources(list,popup);
   list.querySelectorAll('[data-open-person]').forEach(b=>b.addEventListener('click',()=>showPerson(popup,api,b.dataset.personName,anchor,b.dataset.openPerson)));
  }catch(error){status.textContent=error.message;}
  popup.position();
 });
}

export async function showPerson(popup,api,name,anchor,personId=null){
 popup.info(`<h3>${escape(name)}</h3><p class="popup-status" data-person-status>Recherche dans le registre des personnes d’AgentX…</p><div data-person-body></div>`,anchor);
 popup.makeModal();
 const status=popup.root.querySelector('[data-person-status]'),body=popup.root.querySelector('[data-person-body]');
 const moments=api.state.events.filter(e=>(e.people||[]).includes(name)).sort((a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999')));
 const momentList=moments.length?`<h3 class="related-heading">Dans cet atlas · ${number(moments.length)} moment${moments.length>1?'s':''}</h3><div class="popup-list">${moments.slice(0,40).map(e=>`<button class="related-event" type="button" data-event="${escape(e.id)}"><time>${escape(dateLabel(e,true))}</time><strong>${escape(e.title)}</strong></button>`).join('')}</div>`:'';
 const bindMoments=()=>body.querySelectorAll('[data-event]').forEach(b=>b.addEventListener('click',()=>popup.open([api.state.events.find(e=>e.id===b.dataset.event)],anchor,true)));
 try{
  const {people}=personId?{people:[{id:personId,names:[name],displayName:name}]}:await data.people(name);
  if(!people.length){status.textContent='Cette personne n’est pas encore dans le registre (nom écrit autrement ?).';body.innerHTML=momentList;bindMoments();popup.position();return;}
  const match=people.find(p=>(p.names||[]).some(n=>n.toLowerCase()===name.toLowerCase()))||people[0];
  const raw=await data.person(match.id);const detail={...raw,souvenirs:(raw.souvenirs||[]).map(s=>({text:s.text,eventDate:s.eventDate})),exchanges:(raw.exchanges||[]).map(x=>({occurredAt:x.occurredAt,direction:x.direction,sourceId:sourceId({system:'gmail',messageId:x.ref?.messageId,sourceSha256:x.ref?.sourceSha256})}))};
  const p=detail.person;
  status.textContent=`${p.displayName} · ${number(p.exchanges||0)} échange${p.exchanges>1?'s':''} archivé${p.exchanges>1?'s':''}${p.firstSeen?` · de ${day(p.firstSeen)} à ${day(p.lastSeen)}`:''}`;
  body.innerHTML=`${people.length>1?`<p class="popup-footer-note">Autres fiches proches : ${people.filter(x=>x.id!==match.id).map(x=>escape(x.displayName)).join(', ')}. Les fusions se décident dans AgentX.</p>`:''}${(p.names||[]).length>1?`<p>Aussi écrit : ${p.names.map(escape).join(', ')}</p>`:''}${(p.organizations||[]).length?`<p>${icon('briefcase')} ${p.organizations.map(escape).join(', ')}</p>`:''}${detail.souvenirs.length?`<h3 class="related-heading">Souvenirs gardés</h3><ul>${detail.souvenirs.map(s=>`<li>${s.eventDate?`<time>${escape(String(s.eventDate).slice(0,10))}</time> · `:''}${escape(s.text)}</li>`).join('')}</ul>`:''}${momentList}${detail.exchanges.length?`<h3 class="related-heading">Derniers échanges archivés</h3>${detail.exchanges.slice(0,10).map(x=>`<article class="recall-row" data-source-row><p><time>${escape(day(x.occurredAt))}</time> · ${x.direction==='sent'?'envoyé':'reçu'}${x.sourceId?` <button type="button" class="text-button" data-read-source="${escape(x.sourceId)}">Lire ↗</button>`:''}</p><div data-source-text hidden></div></article>`).join('')}`:''}`;
  bindMoments();bindSources(body,popup);
 }catch(error){status.textContent=error.message;body.innerHTML=momentList;bindMoments();}
 popup.position();
}
