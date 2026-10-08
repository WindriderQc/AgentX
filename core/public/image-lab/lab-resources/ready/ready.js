'use strict';
window.ImageWorkshopLedger = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stamp = value => new Date(value).toLocaleString('fr-CA', {timeZone:'America/Toronto'});
  const time = value => value == null ? 'Non mesuré' : `${Number(value).toLocaleString('fr-CA', {maximumFractionDigits:1})} s`;
  const link = (href, text) => `<a class="link" href="${esc(href)}">${esc(text)} ↗</a>`;
  const labels = {scenes:'Scènes / kids',edition:'Retouches',logos:'Logos / docs',textures:'Textures / paint jobs',performance:'Montages GPU'};
  let filter = 'all', search = '', sort = 'group', lastData, finishDraft;

  function apply(data, ledger) {
    data.ready = ledger;
    if (!ledger) return data;
    data.performance.renders = ledger.performance.rendus;
    data.performance.lots = ledger.performance.lots;
    data.performance.failed = ledger.performance.echecs;
    data.performance.humanScope = 'Finitions K04, K01 et K05 reçues ; U06 reçu pour l’apparence, avec défaut de comptage.';
    data.sessions = [
      {title:'Roadmap AgentX commune',owner:'Nestor · voix · code · images',state:'active',label:'Prochain lot : '+ledger.unifiedPlan.nextPriority,description:ledger.unifiedPlan.orderPolicy,updatedAt:ledger.updatedAtUtc,view:'plan'},
      {title:'Performance / MAX',owner:'Appui Performance',state:'delivered',label:'118 rendus · campagne close',description:'Une carte, deux cartes et deux workers mesurés ; finitions 16 MP reçues sur quatre briefs, avec limites de conformité.',updatedAt:ledger.updatedAtUtc,view:'recipes'},
      {title:'Logos et textures',owner:'Atelier + Yanik',state:'delivered',label:'Assets reçus',description:'Logo V1 et A4 à l’écran. Texture, atlas et cinq vues reçus ; import produit GraphysX distinct.',updatedAt:ledger.updatedAtUtc,view:'recipes'},
      {title:'Exploration ciblée',owner:'Appui Exploration',state:'delivered',label:'B1, B2, C1, D1 et trois pots P8',description:'Consistance : pot sur trois graines et cuivre reçus à 1216 × 896 ; autres usages/HQ ouverts. Extraction et matière reçues. P8 multiréférence arrêté et libéré.',updatedAt:ledger.updatedAtUtc,view:'plan'},
      {title:'Retouches cuivre et texte',owner:'Atelier + Yanik',state:'delivered',label:'6 / 6 rendus reçus',description:'Qwen 40, Klein KV4 et Viggle6 sur la même référence. Les avis restent attachés aux fichiers.',updatedAt:ledger.updatedAtUtc,view:'compare',group:'e02'}
    ];
    data.exploration.gpuExecuted = true;
    data.roadmap = ledger.tasks.map(t => ({...t,lane:t.state==='done'?'acquis':t.state==='optional'?'exploration':'prochain',state:{done:'Livré',open:'À terminer',external:'Réception produit attendue',prepared:'Intégration préparée',paused:'Essais GPU différés',optional:'Option différée'}[t.state],next:t.detail,view:'plan'}));
    data.revision += ':' + ledger.updatedAtUtc;
    return data;
  }

  function unavailable() {
    return '<div class="page-head"><h1>Le dossier de réconciliation est indisponible.</h1><p>Les comparaisons historiques restent consultables. Réessaie avec ↻.</p></div>';
  }

  function renderRecipes(data) {
    lastData = data;
    const l = data.ready;
    if (!l) return unavailable();
    return `<div class="page-head"><div><span class="eyebrow">DU BRIEF À L’ASSET</span><h1>Une recette pour chaque usage.</h1><p>Réceptions sur fichiers précis, graphes archivés et finitions. Les capacités du labo gardent leur statut d’intégration.</p></div>${link('/images','Ouvrir l’atelier courant')}</div>
      <div class="ready-notice"><strong>Travail sans GPU</strong><p>Ce cockpit consulte et exporte les preuves. Préparer un dossier ici ne lance aucune génération.</p><small>Réconciliation : ${stamp(l.updatedAtUtc)} · ${l.verified.originals} originaux vérifiés · ${l.verified.graphs} graphes contrôlés hors ligne.</small></div>
      <div class="recipe-grid">${l.workflows.map(w => `<article class="recipe-card" id="recipe-${w.id}"><div class="recipe-top"><span class="eyebrow">${esc(labels[w.usage])}</span><span class="badge ${w.live?'green':'purple'}">${w.live?'Disponible dans l’atelier':'Labo · intégration à faire'}</span></div><h2>${esc(w.title)}</h2><dl><dt>Modèles</dt><dd>${esc(w.model)}</dd><dt>Host / GPU</dt><dd>${esc(w.host)}</dd><dt>Réglages / qualité</dt><dd>${esc(w.quality)}</dd><dt>Dimensions</dt><dd>${esc(w.dimensions)}</dd></dl><ol class="recipe-stages">${w.stages.map(s=>`<li>${esc(s)}</li>`).join('')}</ol><details><summary>Preuves et limites de cette recette</summary><ul>${w.limits.map(s=>`<li>${esc(s)}</li>`).join('')}</ul><div class="group-top-actions">${w.groups.filter(id=>data.groups.some(g=>g.id===id)).map(id=>link('#compare?group='+id,data.groups.find(g=>g.id===id).title)).join('')}</div></details><p class="recipe-next"><strong>Validation suivante</strong><br>${esc(w.next)}</p><div class="group-top-actions">${link(w.dossier,'Fiche JSON')}${link(w.bundle,'Dossier ZIP')}</div></article>`).join('')}</div>
      <section class="ready-section"><span class="eyebrow">TOUS LES FICHIERS AU MÊME ENDROIT</span><h2>Comparer paramètres, délais et avis.</h2><div class="ready-controls"><label>Usage<select id="ready-filter"><option value="all">Tous les usages</option>${Object.entries(labels).map(([id,text])=>`<option value="${id}" ${filter===id?'selected':''}>${text}</option>`).join('')}</select></label><label>Recherche<input id="ready-search" type="search" placeholder="Modèle, host, fichier…" value="${esc(search)}"></label><label>Trier<select id="ready-sort"><option value="group" ${sort==='group'?'selected':''}>Comparaison</option><option value="time" ${sort==='time'?'selected':''}>Temps de génération</option><option value="pixels" ${sort==='pixels'?'selected':''}>Résolution</option></select></label>${link('/images/labo/lab-resources/ready/comparison.csv','Exporter CSV')}</div><p id="ready-count" role="status"></p><div class="table-wrap"><table class="ready-table"><thead><tr><th>Fichier / comparaison</th><th>Modèle / host</th><th>Dimensions natives</th><th>Étapes / graine</th><th>Génération / archive</th><th>Avis / statut</th><th>Preuves</th></tr></thead><tbody id="ready-rows">${rows(l)}</tbody></table></div></section>
      <section class="ready-section"><span class="eyebrow">FINITIONS ET NATIFS</span><h2>MAX : les passes autour de 16 MP.</h2><p>Ces lignes séparent temps du rendu et temps du lot. L’archive durable des originaux est sur le partage Media. Un total jusqu’à réception humaine n’a pas été chronométré.</p><div class="table-wrap"><table class="ready-table"><thead><tr><th>Cas / graine</th><th>Passage</th><th>Dimensions</th><th>Génération</th><th>Archive</th><th>Restitution du lot</th><th>Réception</th><th>Preuves</th></tr></thead><tbody>${l.maxRuns.map(r=>`<tr><td>${esc(r.case)} / ${r.seed}</td><td>${r.role==='refine'?'Finition':'Natif'} · bruit ${r.denoise}</td><td>${r.width} × ${r.height}</td><td>${time(r.generationSeconds)}</td><td>${time(r.archiveSeconds)}</td><td>${time(r.batchRestoreSeconds)}<small>Lot complet : ${time(r.batchTotalSeconds)}</small></td><td>${esc(r.humanStatus)}</td><td>${link(r.graph,'Graphe')} ${link(r.receipt,'Mesures')}<details><summary>Original / parent</summary><code>${esc(r.originalSHA256)}</code><p>Parent : ${esc(r.parentSHA256||'Création indépendante')}</p><code>${esc(r.archiveShare)}</code></details></td></tr>`).join('')}</tbody></table></div><details><summary>Planches entières et recadrages locaux</summary><div class="group-top-actions">${l.boards.map(b=>link(b.href,b.title)).join('')}</div></details></section>
      ${preparation(l)}
      <div class="boundary"><span>✦</span><p>Aucune recette par défaut choisie ici. Une réception de fichier ne garantit ni tous les briefs, ni le délai interactif, ni un débit de nuit.</p></div>`;
  }

  function found(l) {
    return l.records.filter(p => (filter==='all'||p.category===filter) && `${p.title} ${p.model} ${p.host} ${p.groupTitle} ${p.status}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr'))).sort((a,b)=>sort==='time'?(a.seconds??Infinity)-(b.seconds??Infinity):sort==='pixels'?(b.width*b.height)-(a.width*a.height):a.groupTitle.localeCompare(b.groupTitle,'fr'));
  }
  function rows(l) {
    const records=found(l);
    return records.length ? records.map(p=>`<tr><td><strong>${esc(p.title)}</strong><small>${esc(p.groupTitle)}</small></td><td>${esc(p.model||'Finition / document')}<small>${esc(p.host)}</small></td><td>${p.width} × ${p.height}<small>${(p.width*p.height/1e6).toFixed(2)} MP · ${esc(p.mode)}</small></td><td>${esc(p.steps??'—')} / ${esc(p.seed??'—')}</td><td>${time(p.seconds)}<small>Archive : ${time(p.archiveSeconds)}</small></td><td>${esc(p.status||'Voir le reçu')}<small>${esc(p.note||'')}</small></td><td>${link(p.original,'Original')}${p.graph?link(p.graph,'Graphe'):''}${p.humanReceipt?link(p.humanReceipt,'Avis'):''}<details><summary>Filiation / SHA</summary><code>${esc(p.sha256)}</code><p>${p.parents.length?'Référence : '+esc(p.parents.join(', ')):'Parent non indexé dans cette comparaison.'}</p></details></td></tr>`).join('') : '<tr><td colspan="7">Aucun fichier pour ces filtres.</td></tr>';
  }

  function preparation(l) {
    const parents=l.records.filter(p=>p.category==='scenes' && !/non reçu|écarté/i.test(p.status||'') && /reçu/i.test(p.status||''));
    return `<section class="ready-section"><span class="eyebrow">PRÉPARATION HORS LIGNE</span><h2>Préparer une finition HQ.</h2><p>Exporter une intention avec le parent exact. Ce fichier sert à la prochaine intégration ; il ne soumet aucun job. La capacité mémoire de ses nouvelles dimensions reste à valider.</p><form id="finish-plan"><div class="ready-controls"><label>Image choisie<select id="finish-parent" required>${parents.map(p=>`<option value="${p.id}">${esc(p.title)} · ${p.width} × ${p.height} · ${esc(p.groupTitle)}</option>`).join('')}</select></label><label>Largeur<input id="finish-width" type="number" min="256" max="8192" step="32" value="4672" required></label><label>Hauteur<input id="finish-height" type="number" min="256" max="8192" step="32" value="3488" required></label><label>Bruit<select id="finish-noise"><option value="0.25">0,25</option><option value="0.4">0,40</option></select></label><label>Graine<input id="finish-seed" type="number" min="0" max="4294967295" step="1" value="1729" required></label></div><label class="ready-brief">Brief exact<textarea id="finish-brief" required rows="4" placeholder="Décrire la scène choisie ; le modèle reçoit toujours ce brief."></textarea></label><p id="finish-validation" role="status">Les dimensions sont une intention, pas une capacité admise.</p><button class="button" type="submit">Exporter le plan JSON · aucun calcul</button></form></section>`;
  }

  function validatePlan({width,height,seed,prompt,parent}) {
    if (!parent?.sha256 || !/^[a-f0-9]{64}$/.test(parent.sha256)) throw new Error('Parent et empreinte requis.');
    if (![width,height].every(n=>Number.isInteger(n)&&n>=256&&n<=8192&&n%32===0)) throw new Error('Dimensions : 256 à 8192 px, multiples de 32.');
    if (!Number.isSafeInteger(seed)||seed<0||seed>4294967295) throw new Error('Graine entière de 0 à 4294967295.');
    if (!prompt.trim()) throw new Error('Le brief exact est requis.');
    return {pixels:width*height, aspectDelta:Math.abs(width/height/(parent.width/parent.height)-1), requiresNewCapacityTest:width*height>16800000};
  }

  function bind(data, current) {
    if(current!=='recipes'||!data.ready)return;
    const l=data.ready;
    function update(){ document.querySelector('#ready-rows').innerHTML=rows(l);document.querySelector('#ready-count').textContent=`${found(l).length} fichiers · les temps non mesurés restent indiqués.`; }
    document.querySelector('#ready-filter').onchange=e=>{filter=e.target.value;update();};
    document.querySelector('#ready-search').oninput=e=>{search=e.target.value;update();};
    document.querySelector('#ready-sort').onchange=e=>{sort=e.target.value;update();};update();
    const parentSelect=document.querySelector('#finish-parent'), brief=document.querySelector('#finish-brief');
    let edited=false;brief.oninput=()=>{edited=true;};
    const parent=()=>l.records.find(p=>p.id===parentSelect.value);
    parentSelect.onchange=()=>{
      if(!edited)brief.value=parent()?.brief||'';
      const p=parent();if(!p)return;
      document.querySelector('#finish-seed').value=p.seed??1729;
      const w=document.querySelector('#finish-width').value;
      document.querySelector('#finish-height').value=Math.max(256,Math.round((Number(w)*p.height/p.width)/32)*32);
    };
    if(finishDraft && l.records.some(p=>p.id===finishDraft.parent)){
      parentSelect.value=finishDraft.parent;
      for(const [name,value] of Object.entries(finishDraft.fields))document.querySelector('#finish-'+name).value=value;
      brief.value=finishDraft.prompt;edited=true;
    }else parentSelect.onchange();
    const remember=()=>{finishDraft={parent:parentSelect.value,prompt:brief.value,fields:Object.fromEntries(['width','height','seed','noise'].map(name=>[name,document.querySelector('#finish-'+name).value]))};};
    document.querySelector('#finish-plan').addEventListener('input',remember);
    document.querySelector('#finish-plan').addEventListener('change',remember);
    document.querySelector('#finish-plan').onsubmit=e=>{
      e.preventDefault();
      const p=parent(), width=Number(document.querySelector('#finish-width').value), height=Number(document.querySelector('#finish-height').value), seed=Number(document.querySelector('#finish-seed').value), prompt=brief.value;
      try {
        const validation=validatePlan({width,height,seed,prompt,parent:p});
        const id=globalThis.crypto.randomUUID?.()||Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
        const plan={schemaVersion:1,id:'hq-finish-intent-'+id,state:'prepared_only',automaticDispatch:false,createdAtUtc:new Date().toISOString(),operation:'reference_finish',parent:{id:p.id,original:p.original,sha256:p.sha256,dimensions:[p.width,p.height]},prompt,model:'Qwen Image 2.1 BF16',steps:25,cfg:1,sampler:'euler',scheduler:'simple',seed,width,height,denoise:Number(document.querySelector('#finish-noise').value),validation,qualification:'User-prepared intention; no GPU admission or generation performed',requiredChecks:['Verify exact parent SHA','Fresh job identities and model/node revisions','Core and QUEUE admission','Capacity check for requested dimensions','Composition validation','Durable archive and restoration proof'],totalToUsableSeconds:null};
        const blob=new Blob([JSON.stringify(plan,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=plan.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        document.querySelector('#finish-validation').textContent=`Plan exporté · ${(validation.pixels/1e6).toFixed(2)} MP · ${validation.aspectDelta>.02?'proportions modifiées, à examiner':'proportions proches du parent'}${validation.requiresNewCapacityTest?' · dépasse les tailles mesurées':''}. Aucun job soumis.`;
      }catch(error){document.querySelector('#finish-validation').textContent=error.message;}
    };
  }

  function renderPlan(data) {
    const l=data.ready;if(!l)return unavailable();
    const columns=[['offline','Livré'],['code','Développement et intégration'],['human','Réceptions / produit'],['gpu','Options différées']];
    const unified=l.unifiedPlan;
    const classification=unified?.prioritization;
    const categories=Object.fromEntries((classification?.categories||[]).map(c=>[c.id,c]));
    const overview=classification?`<section class="ready-section" id="priority-overview"><h2>Où gagner vite. Où apporter le plus.</h2><p>${esc(classification.method)}</p><p>${esc(classification.classificationScope)}</p><div class="priority-grid">${classification.categories.map(c=>`<article class="priority-card" data-priority-category="${esc(c.id)}"><h3>${esc(c.title)}</h3><p>${esc(c.definition)}</p><ul>${unified.workstreams.filter(w=>w.prioritization.tags.includes(c.id)).map(w=>`<li data-priority-lot="${esc(w.id)}"><strong>${esc(w.id)}</strong> · ${esc(w.title)}</li>`).join('')}</ul></article>`).join('')}</div><details><summary>Comment lire les efforts et choisir la suite</summary><p>${esc(classification.valueMeaning)}</p><ul>${Object.entries(classification.effortScale).map(([id,text])=>`<li><strong>${esc(id)}</strong> · ${esc(text)}</li>`).join('')}</ul><p>Efforts estimés pour la première tranche puis le lot restant. La disponibilité des appareils, du propriétaire et des ressources reste distincte.</p><ul>${classification.rules.map(r=>`<li>${esc(r)}</li>`).join('')}</ul></details></section>`:'';
    const priorities=unified?`<section class="ready-section"><h2>Ordre d’exécution commun</h2><p><strong>Prochain lot : ${esc(unified.nextPriority)}.</strong> ${esc(unified.orderPolicy)}</p><ol class="unified-workstreams">${unified.workstreams.map(w=>{
      const p=w.prioritization;
      return `<li data-workstream="${esc(w.id)}"><span class="eyebrow">${esc(w.id)} · ${esc(w.owner)}</span><h3><span class="workstream-rank">${unified.executionOrder.includes(w.id)?esc(w.priority)+'. ':''}</span>${esc(w.title)}</h3><span class="badge ${w.state==='done'?'green':'purple'}">${esc({done:'Livré',prepared:'Intégration préparée',external:'Réception produit attendue',open:'À terminer',optional:'Option différée'}[w.state]||w.state)}</span><div class="priority-tags">${p.tags.map(t=>`<span class="priority-tag" data-tag="${esc(t)}">${esc(categories[t].title)}</span>`).join('')}</div><p class="priority-estimates"><strong>Valeur attendue :</strong> ${esc(p.addedValue)} · <strong>Effort tranche / lot :</strong> ${esc(p.firstSliceEffort)} / ${esc(p.remainingLotEffort)} · <strong>Incertitude :</strong> ${esc(p.uncertainty)}</p><p>${esc(p.reason)}</p><p><strong>Première tranche utile :</strong> ${esc(p.firstUsefulSlice)}</p><p><strong>Portée restante :</strong> ${esc(p.remainingScope)}</p><details><summary>Acquis, travaux et preuves pour clôturer</summary><p><strong>Acquis :</strong> ${esc(w.delivered)}</p><p>${esc(w.next)}</p><ul>${w.acceptance.map(a=>`<li>${esc(a)}</li>`).join('')}</ul><p>${w.validation.map(esc).join(' · ')}</p>${w.dependencies.length?`<p>Dépendances : ${w.dependencies.map(esc).join(', ')}</p>`:''}${w.gates.length?`<ul>${w.gates.map(g=>`<li>${esc(g.lotId||g.kind)} · ${esc(g.reason)}</li>`).join('')}</ul>`:''}</details></li>`;
    }).join('')}</ol><div class="group-top-actions">${link(unified.href,'Roadmap d’exécution')}${link(unified.roadmapHref,'Registre canonique JSON')}${link('/images/labo/lab-resources/ready/PACK-ROADMAP-PRIORISEE-20261008.zip','Archive de la roadmap priorisée')}</div></section>`:'';
    return `<div class="page-head"><div><span class="eyebrow">ROADMAP AGENTX · 8 OCTOBRE</span><h1>Ce qui est fait. Ce qui reste.</h1><p>Les mesures, les avis humains et la disponibilité dans le moteur gardent chacun leur preuve.</p></div>${link('#recipes','Voir les workflows')}</div><div class="ready-notice"><strong>Validations GPU images différées</strong><p>L’atelier courant utilise Klein rapide et Qwen qualité sur UGFrank. La chaîne HQ Alien reste à intégrer. Ce cockpit consulte les preuves et prépare des dossiers sans soumission.</p><small>${stamp(l.updatedAtUtc)}</small></div>${overview}${priorities}<section class="ready-section"><h2>Livraisons et travaux détaillés</h2><div class="plan-grid">${columns.map(([lane,title])=>`<section><h2>${title}</h2>${l.tasks.filter(t=>t.lane===lane).map(t=>`<article class="roadmap-card"><div class="roadmap-owner">${esc(t.workstreamId||'Catalogue')} · ${esc(t.owner)}</div><span class="badge ${t.state==='done'?'green':'purple'}">${esc({done:'Livré',open:'À terminer',external:'Réception produit attendue',prepared:'Préparé',paused:'En pause',optional:'Option différée'}[t.state])}</span><h3>${esc(t.title)}</h3><p>${esc(t.detail)}</p></article>`).join('')}</section>`).join('')}</div></section><section class="ready-section"><h2>Documents et sources de vérité</h2><div class="group-top-actions">${l.documents.map(d=>link(d.href,d.title))}${link('/images/labo/lab-resources/ready/ledger.json','Index JSON')}</div><details><summary>Réceptions et preuves datées (${l.sources.length})</summary><ul>${l.sources.map(s=>`<li>${link(s.href,s.file)}<small>${stamp(s.modifiedAtUtc)} · <code>${esc(s.sha256)}</code></small></li>`).join('')}</ul></details></section>`;
  }
  return {apply,renderRecipes,renderPlan,bind,validatePlan};
})();
