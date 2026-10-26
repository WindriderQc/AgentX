import {reviewState} from './review.js';
import {fold} from './ui.js';

// These are explainable suggestions, not a measure of personal importance.
// Imported importance, source counts and factual confirmation do not affect them.
const rules=[
 {kind:'family',reason:'Naissance · famille',score:100,categories:['people'],test:/\b(?:naissance|est ne|est nee|bebe est arrive|accouchement)\b/},
 {kind:'family',reason:'Transition familiale',score:100,categories:['people'],test:/\b(?:mariage|se marie|adoption|separation|divorce|deces|funerailles|vie (?:de|en) couple)\b/},
 {kind:'education',reason:'Diplôme obtenu',score:98,categories:['work'],test:/\b(?:diplome|baccalaureat|maitrise|doctorat|dec)\b.*\b(?:obtenu|decerne|termine|recu)\b|\bobtention (?:du|d.un|de (?:mon|son)) (?:diplome|dec|baccalaureat)/},
 {kind:'home',reason:'Changement de lieu de vie',score:96,categories:['home'],test:/\b(?:demenag\w*|emmenag\w*|nouvel appartement|nouvelle maison|achat (?:de (?:la|ma|notre|sa)|d.une) (?:maison|propriete|condo)|premier (?:logement|appartement)|prise de possession)\b/},
 {kind:'career',reason:'Création d’entreprise',score:92,categories:['work'],test:/\b(?:constitution|creation|fondation|lancement)\b.*\b(?:entreprise|societe|compagnie)\b/},
 {kind:'career',reason:'Nouvel emploi',score:90,categories:['work'],test:/\b(?:premier emploi|nouvel emploi|nouveau poste|embauche|offre d.emploi acceptee|debut (?:d.emploi|de mandat|chez)|integration chez)\b/},
 {kind:'career',reason:'Transition professionnelle',score:88,categories:['work'],test:/\b(?:fin (?:du|de|d.) (?:mandat|contrat|emploi)|demission|depart de l.entreprise|perte d.emploi|mise a pied|retraite)\b/},
 {kind:'education',reason:'Qualification obtenue',score:86,categories:['work','travel'],test:/\b(?:certification|certificat|permis|brevet|licence)\b.*\b(?:obtenu|obtenue|reussi|completee?|recu)\b/},
 {kind:'achievement',reason:'Compétition ou exploit',score:85,categories:['work','travel','health'],test:/\b(?:championnat|competition|coupe|marathon|triathlon|medaille|podium|record)\b/},
 {kind:'turning-point',reason:'Événement marquant possible',score:84,categories:['daily','home','health'],test:/\b(?:accident|perte totale|sinistre|hospitalisation|intervention chirurgicale|chirurgie|urgence)\b/},
 {kind:'education',reason:'Parcours d’études',score:82,categories:['work'],test:/\b(?:etudes en|entree (?:au|a l.) (?:cegep|universite|ecole)|rentree scolaire|inscription (?:au|a l.) (?:cegep|universite))\b/},
 {kind:'experience',reason:'Voyage',score:80,categories:['travel'],test:/\b(?:voyage|sejour|vacances|croisiere|road trip)\b.*\b(?:a|au|aux|en)\b/}
];
const tentative=/\b(?:prevu(?:e|es|s)?|planifie(?:e|es|s)?|reserve(?:e|es|s)?|possible|annule(?:e|es|s)?|a venir|a completer|a eclaircir|a preciser)\b/;
const routine=/\b(?:garantie|facture|soumission|immatriculation|rendez.vous|renouvellement|versements?|virement|preparation|candidature)\b/;

export function milestone(event){
 const title=fold(event.title);
 if(tentative.test(title)||routine.test(title)||/^(?:piste|album|projet|vers)\b/.test(title))return null;
 const text=fold(`${event.title} ${event.description||''}`.slice(0,400));
 const rule=rules.find(r=>r.categories.includes(event.category)&&r.test.test(text));
 return rule?{kind:rule.kind,reason:rule.reason,score:rule.score}:null;
}

function timestamp(event){return event.date?Date.parse(event.date+'T00:00:00Z'):NaN;}
function occurred(event,now){
 return !['hypothesis','dismissed'].includes(reviewState(event))&&
  !['planned','cancelled','unknown','documented'].includes(event.occurrenceStatus)&&timestamp(event)<=now;
}

// Build successive varied pages from the eligible pool. Rotating cannot reach
// routine paperwork just because it is farther down the complete archive.
export function selectHighlights(events,{favorites=new Set(),mode='milestones',query='',page=0,limit=3,now=Date.now()}={}){
 const terms=fold(query).split(/\s+/).filter(Boolean),seen=new Set(),candidates=[];
 // Prefer the explicitly starred record if equivalent records share a date/title.
 for(const event of [...events].sort((a,b)=>Number(favorites.has(b.id))-Number(favorites.has(a.id)))){
  if(!Number.isFinite(timestamp(event)))continue;
  const favorite=favorites.has(event.id),type=milestone(event),review=reviewState(event);
  if(mode==='favorites'&&!favorite)continue;
  if(mode==='milestones'&&(review==='dismissed'||(!favorite&&(!type||!occurred(event,now)))))continue;
  if(mode==='hypotheses'&&review!=='hypothesis')continue;
  if(mode==='dismissed'&&review!=='dismissed')continue;
  const key=fold(event.title)+'|'+event.date;
  if(seen.has(key))continue;
  seen.add(key);
  const reason=favorite?'Mon repère':mode==='hypotheses'?'Piste à confirmer':mode==='dismissed'?'Élément écarté':mode==='search'?'Résultat de recherche':type.reason;
  candidates.push({event,reason,kind:type?.kind||event.category,score:(favorite?1000:0)+(type?.score||0)+(mode==='search'?terms.filter(t=>fold(event.title).includes(t)).length*2000:0)});
 }
 candidates.sort((a,b)=>b.score-a.score||timestamp(a.event)-timestamp(b.event)||a.event.id.localeCompare(b.event.id));
 const pageCount=Math.ceil(candidates.length/limit),currentPage=pageCount?((Math.trunc(page)%pageCount)+pageCount)%pageCount:0;
 const remaining=[...candidates];let items=[];
 for(let p=0;p<=currentPage;p++){
  items=[];
  while(items.length<limit&&remaining.length){
   let bestIndex=0,bestScore=-Infinity;
   remaining.forEach((candidate,i)=>{
    const penalty=items.reduce((sum,item)=>sum+(item.kind===candidate.kind?30:0)+(item.event.category===candidate.event.category?6:0)+(Math.abs(timestamp(item.event)-timestamp(candidate.event))<2*365.25*86400000?4:0),0);
    const score=candidate.score-penalty;
    if(score>bestScore){bestScore=score;bestIndex=i;}
   });
   items.push(...remaining.splice(bestIndex,1));
  }
 }
 // The strip is still a small timeline, so show the chosen moments in time order.
 return {items:items.sort((a,b)=>timestamp(a.event)-timestamp(b.event)),candidateCount:candidates.length,pageCount,page:currentPage};
}

export function highlightStatus(event,now=Date.now()){
 if(event.occurrenceStatus==='cancelled')return 'Annulé';
 if(event.occurrenceStatus==='planned')return 'Prévu · réalisation à vérifier';
 if(event.occurrenceStatus==='unknown')return 'Réalisation à préciser';
 if(event.occurrenceStatus==='documented')return 'Document daté';
 if(timestamp(event)>now)return 'À venir';
 return '';
}
