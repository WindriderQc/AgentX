// "Les traces et les blancs": what Core holds for this history, and what is left to do.
import {escape,number} from './ui.js';
import {sourceLabel} from './projection.js';
import {readCoverage} from './data.js';
import {annualCoverage} from './annual-coverage.js';

export function coverageNotice(meta){return meta?.truncated?`Au moins ${number(meta.events)} relevés chargés. Core a limité cette réponse : une partie de l’historique n’est pas affichée. Les comptes et les périodes visibles décrivent uniquement cette sélection.`:'';}

export function activeLifeReviews(reviews){return (reviews||[]).filter(o=>o.objectiveId==='life-timeline'&&!['superseded','cancelled'].includes(o.phase)).sort((a,b)=>String(b.version).localeCompare(String(a.version),'en',{numeric:true})).slice(0,1);}

export function rejectedCopyNotice(counts){const n=counts?.deferredRejectedCopyPages||0;return n?`<p class="coverage-limit">${number(n)} passages de copies reportés après le rejet d’un texte strictement identique. Ces copies n’ont pas été relues par le modèle et restent hors couverture, avec une revue de source à faire.</p>`:'';}

export function nativeCoverage(c,options={}){
 const last=c.lastCatchup||{},archive=c.archiveProgress;
 const phase={planned:'Préparée',reviewing:'Lecture en cours',running:'En cours',done:'Textes du périmètre couverts',completed:'Lecture terminée',paused:'En attente de reprise',stopped:'Lecture partielle',uncertain:'Résultat à réconcilier',error:'À reprendre',failed:'À reprendre',partial:'Lecture partielle','validation-error':'Analyse à reprendre','source-error':'Une source à vérifier'};
 const objectives=activeLifeReviews(c.objectiveReviews);
 const equivalence=objectives.some(o=>o.counts?.equivalentPages)?`<p class="coverage-limit">${number(objectives.reduce((n,o)=>n+(o.counts?.equivalentPages||0),0))} passages sont couverts par équivalence vérifiée avec un texte déjà relu. Ce sont des copies, sans nouvelle inférence ni témoignage supplémentaire.</p>`:'';
 return `${equivalence}${objectives.map(o=>{const n=o.counts||{};return `<h4>Nouvelle passe · ton histoire · ${escape(o.version)}</h4><p>${escape(phase[o.phase]||'État à préciser')} · ${number(n.sourcesTextReviewed||0)} textes de source relus au complet sur ${number(n.targetSources||0)} fichiers ciblés.${n.sourcesTextCovered>n.sourcesTextReviewed?` ${number(n.sourcesTextCovered)} fichiers sont couverts en incluant les copies vérifiées.`:''}</p><div class="info-stats"><div><strong>${number(n.reviewedPages||0)}</strong><small>passages relus</small></div><div><strong>${number(n.extractedMoments||0)}</strong><small>moments proposés</small></div><div><strong>${number(n.sourcesWithGaps||0)}</strong><small>sources avec limites</small></div><div><strong>${number(n.sourceErrors||0)}</strong><small>sources à reprendre</small></div></div>${rejectedCopyNotice(n)}<p class="coverage-limit">Les passages connus s’ajoutent à mesure de la lecture. Les textes relus ne valent pas validation personnelle.${o.allTargetTextReviewed?' Tous les textes du périmètre figé ont un reçu de lecture.':o.allTargetTextCovered?' Tous les textes ciblés sont couverts par lecture ou équivalence vérifiée.':''}</p>${annualCoverage(o.annualCoverage,options)}`;}).join('')}${archive?`<h4>Relecture générale des archives</h4><p>${number(archive.reviewedPages||0)} passages avec reçu · ${number(archive.pendingTextPages||0)} passages connus à traiter${archive.uncollectedThreads?` · ${number(archive.uncollectedThreads)} fils à collecter`:''}.</p><p class="coverage-limit">Cette lecture générale répond à un autre objectif que la reconstruction de ta vie.</p>`:''}<h4>Dernière reprise des courriels</h4><p>${number(last.reviewed||0)} pages traitées dans ce lot · ${number(last.remaining||0)} restantes dans ce lot · ${number(last.failed||0)} échecs.</p>${last.finishedAt?`<p>Fin enregistrée le ${escape(new Intl.DateTimeFormat('fr-CA',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Toronto'}).format(new Date(last.finishedAt)))}.</p>`:''}${(c.limits||[]).map(t=>`<p class="coverage-limit">${escape(t)}</p>`).join('')}`;
}


export async function showCoverage(popup,state,anchor){
 const m=state.meta;if(!m?.core)return;
 const c=m.core,systems=Object.entries(m.bySystem||{}).sort((a,b)=>b[1]-a[1]);
 const decades=new Map();for(const e of state.events)if(e.date){const d=Math.floor(Number(e.date.slice(0,4))/10)*10;decades.set(d,(decades.get(d)||0)+1);}
 const peak=Math.max(1,...decades.values());
 popup.info(`<h3>Les traces et les blancs</h3>${m.truncated?`<p class="coverage-warning">${escape(coverageNotice(m))}</p>`:''}<p>Tout ce que montre cet atlas vient d’AgentX : ton historique, tes souvenirs, tes sources. Rien n’est copié ici.</p>
 <div class="info-stats"><div><strong>${number(c.kept)}</strong><small>souvenirs gardés</small></div><div><strong>${number(c.toReview??c.candidates)}</strong><small>moments à relire</small></div><div><strong>${number(m.dated)}</strong><small>moments datés</small></div><div><strong>${number(m.undated)}</strong><small>à dater</small></div></div>
 <section data-native-coverage><p>Lecture de l’état natif…</p></section><h4 class="coverage-title">D’où viennent les moments</h4><ul class="coverage-list">${systems.map(([system,count])=>`<li><span>${escape(sourceLabel(system))}</span><strong>${number(count)}</strong></li>`).join('')}</ul>
 <h4 class="coverage-title">Densité des moments chargés par décennie</h4><div class="coverage-bars">${[...decades].sort((a,b)=>a[0]-b[0]).map(([d,n])=>`<div><span>${d}</span><i style="--w:${Math.max(4,Math.round(100*n/peak))}%"></i><small>${number(n)}</small></div>`).join('')}</div>
 <p>Ces barres décrivent les repères chargés, indépendamment de la couverture des archives. Un creux ne prouve ni l’absence d’un événement ni l’absence de sources. Tes témoignages (${number(c.testimony)}) et tes photos peuvent enrichir cette autre vue.</p>`,anchor);
 popup.makeModal();const target=popup.root.querySelector('[data-native-coverage]');
 try{const coverage=await readCoverage();if(target.isConnected){const startYear=Number.isFinite(state.domain?.[0])?new Date(state.domain[0]).getUTCFullYear():undefined;target.innerHTML=coverage?nativeCoverage(coverage,{startYear}):'<p>État de lecture indisponible.</p>';popup.position();}}
 catch(error){if(target.isConnected)target.textContent=error.message;}
}
