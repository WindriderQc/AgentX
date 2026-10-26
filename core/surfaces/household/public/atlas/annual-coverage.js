import {escape,number} from './ui.js';

const fields=['targetedSources','availableSources','reviewedSources','coveredSources','rejectedSources','gapSources','sourceErrors','metadataErrors'];
const labels={targetedSources:'Fichiers ciblés',availableSources:'Présents',reviewedSources:'Relus au complet',coveredSources:'Couverts',rejectedSources:'Avec rejet',gapSources:'Avec limites',sourceErrors:'Erreur de lecture',metadataErrors:'Date à vérifier'};
const systems=[['gmail','Gmail'],['outlook-export','Outlook']];
const empty=()=>Object.fromEntries(fields.map(k=>[k,0]));
const blank=year=>({year,totals:empty(),bySystem:Object.fromEntries(systems.map(([s])=>[s,empty()]))});

export function yearState(row){
 const n=row.totals;
 if(!n.targetedSources)return {key:'empty',label:'Aucun fichier ciblé'};
 if(n.rejectedSources||n.sourceErrors||n.availableSources<n.targetedSources)return {key:'attention',label:'Limites à examiner'};
 if(n.coveredSources===n.targetedSources)return {key:'covered',label:'Textes couverts'};
 if(n.coveredSources||n.reviewedSources)return {key:'partial',label:'Lecture partielle'};
 return {key:'pending',label:'Lecture à faire'};
}

export function annualRows(annual,{startYear,endYear,nowYear=new Date().getFullYear()}={}){
 const years=annual.years||[],known=years.map(y=>y.year),last=Number.isInteger(endYear)?Math.max(nowYear,endYear):nowYear;
 const proposed=Number.isInteger(startYear)?startYear:Math.min(nowYear,...known);
 const first=Math.max(1,Math.min(proposed,last)),limitedStart=Math.max(first,last-511);
 const index=new Map(years.map(row=>[row.year,row]));
 return {start:limitedStart,end:last,limited:limitedStart!==first,
  rows:Array.from({length:last-limitedStart+1},(_,i)=>index.get(limitedStart+i)||blank(limitedStart+i)),
  outside:years.filter(row=>row.year<limitedStart||row.year>last)};
}

function sourceDetails(row){
 return `<div class="annual-source-details">${systems.map(([key,label])=>`<section><h5>${label}</h5><dl>${fields.map(k=>`<div><dt>${labels[k]}</dt><dd>${number(row.bySystem?.[key]?.[k]||0)}</dd></div>`).join('')}</dl></section>`).join('')}</div>`;
}
function yearCard(row){
 const n=row.totals,status=yearState(row),year=row.year===null?'Année inconnue':String(row.year);
 const detail=`${year} · ${number(n.targetedSources)} fichiers ciblés · ${number(n.availableSources)} présents · ${number(n.reviewedSources)} relus · ${number(n.coveredSources)} couverts · ${number(n.rejectedSources)} avec rejet · ${number(n.gapSources)} avec limites`;
 const ratio=n.targetedSources?Math.min(100,100*n.coveredSources/n.targetedSources):0;
 return `<details class="annual-year annual-${status.key}${row.year===null?' annual-unknown':''}"><summary title="${escape(detail)}" aria-label="${escape(detail)}"><span class="annual-year-label">${escape(year)}</span><strong>${number(n.targetedSources)}</strong><small>${escape(status.label)}</small><i aria-hidden="true" style="--covered:${ratio}%"></i></summary><div class="annual-year-body"><p>${escape(detail)}.</p>${sourceDetails(row)}</div></details>`;
}

export function annualCoverage(annual,options={}){
 if(!annual||annual.status!=='available')return '<p class="coverage-limit">La couverture annuelle des archives n’est pas encore disponible pour cette passe.</p>';
 const view=annualRows(annual,options),n=annual.totals,m=annual.metadata;
 const outsideFiles=view.outside.reduce((sum,row)=>sum+row.totals.targetedSources,0);
 return `<section class="annual-coverage" aria-label="Couverture annuelle des courriels"><header><span class="annual-eyebrow">LES ARCHIVES · PAR ANNÉE DU COURRIEL</span><h4>Les années et leurs sources</h4><p>Les dates des courriels ne datent pas les événements de ta vie. Ici : l’inventaire figé et sa lecture.</p></header>
 <div class="annual-overview"><div><strong>${number(n.targetedSources)}</strong><small>fichiers ciblés</small></div><div><strong>${number(n.availableSources)}</strong><small>présents dans l’archive</small></div><div><strong>${number(n.coveredSources)}</strong><small>textes couverts</small></div><div><strong>${number(annual.unknown.totals.targetedSources)}</strong><small>année inconnue</small></div></div>
 <details class="annual-method"><summary>Comment lire ces comptages</summary><p>Présence = fichier trouvé et taille attendue, sans contrôle d’intégrité supplémentaire. Les copies physiques comptent séparément ; elles ne sont pas des témoignages indépendants.</p><p>Les compteurs se recoupent : un fichier peut être couvert et garder des limites. « Relu » indique un reçu complet au contrat, sans valider les faits extraits. « Couvert » inclut les copies vérifiées. L’inventaire se met à jour à la fin d’une tranche.</p></details>
 <div class="annual-key" aria-label="Légende"><span class="annual-empty">Aucun fichier ciblé</span><span class="annual-pending">À lire</span><span class="annual-partial">Partiel</span><span class="annual-covered">Couvert</span><span class="annual-attention">À examiner</span></div>
 <p class="annual-range">${view.start} — ${view.end} · Ouvre une année pour le détail Gmail / Outlook.</p>
 <div class="annual-years">${view.rows.map(yearCard).join('')}</div>
 ${view.limited?'<p class="coverage-limit">La grille est bornée à 512 années. Les années avec fichiers hors de cette fenêtre restent accessibles ci-dessous.</p>':''}
 ${view.outside.length?`<details class="annual-outside"><summary>${number(outsideFiles)} fichiers sur ${number(view.outside.length)} années hors de la fenêtre affichée</summary><div class="annual-years">${view.outside.map(yearCard).join('')}</div></details>`:''}
 <div class="annual-undated">${yearCard(annual.unknown)}<p>${number(m.missingDates)} dates absentes · ${number(m.invalidDates)} dates invalides · ${number(m.identityMismatches)} métadonnées non raccordées à l’original ciblé.</p></div></section>`;
}
