// "Les traces et les blancs": what Core holds for this history, and what is left to do.
import {escape,number} from './ui.js';
import {sourceLabel} from './projection.js';

export function showCoverage(popup,state,anchor){
 const m=state.meta;if(!m?.core)return;
 const c=m.core,systems=Object.entries(m.bySystem||{}).sort((a,b)=>b[1]-a[1]);
 const decades=new Map();for(const e of state.events)if(e.date){const d=Math.floor(Number(e.date.slice(0,4))/10)*10;decades.set(d,(decades.get(d)||0)+1);}
 const peak=Math.max(1,...decades.values());
 popup.info(`<h3>Les traces et les blancs</h3><p>Tout ce que montre cet atlas vient d’AgentX : ton historique, tes souvenirs, tes sources. Rien n’est copié ici.</p>
 <div class="info-stats"><div><strong>${number(c.kept)}</strong><small>souvenirs gardés</small></div><div><strong>${number(c.candidates)}</strong><small>moments à relire</small></div><div><strong>${number(m.dated)}</strong><small>moments datés</small></div><div><strong>${number(m.undated)}</strong><small>à dater</small></div></div>
 <h4 class="coverage-title">D’où viennent les moments</h4><ul class="coverage-list">${systems.map(([system,count])=>`<li><span>${escape(sourceLabel(system))}</span><strong>${number(count)}</strong></li>`).join('')}</ul>
 <h4 class="coverage-title">Densité par décennie</h4><div class="coverage-bars">${[...decades].sort((a,b)=>a[0]-b[0]).map(([d,n])=>`<div><span>${d}</span><i style="--w:${Math.max(4,Math.round(100*n/peak))}%"></i><small>${number(n)}</small></div>`).join('')}</div>
 <p>Les décennies pâles sont les blancs : souvent l’avant-courriel. Tes témoignages (${number(c.testimony)}) et tes photos les remplissent mieux que les messages.</p>`,anchor);
}
