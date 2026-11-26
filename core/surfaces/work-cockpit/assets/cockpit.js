'use strict';

(async () => {
  const $ = id => document.getElementById(id);
  let sources;
  try {
    const response = await fetch('/owner/work/data', {cache:'no-store', credentials:'same-origin', redirect:'error'});
    if (!response.ok) throw new Error('Unavailable');
    sources = await response.json();
  } catch {
    $('provenance').textContent = 'Accès au cockpit indisponible.';
    return;
  }
  const pipeline = sources.pipeline, registry = sources.registry;
  const dimensions = {status:'Tous les états',domain:'Tous les domaines',type:'Tous les types',executor:'Tous les exécutants'};
  const order = new Map(cockpitCards.lanes.map((lane,i)=>[lane.id,i]));
  const dateFormat = new Intl.DateTimeFormat('fr-CA',{timeZone:'America/Toronto',
    year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const date = value => value ? dateFormat.format(new Date(value))+' (Québec)' : 'date non exposée';
  const fold = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr');
  const collator = new Intl.Collator('fr',{numeric:true});
  const workspace = document.querySelector('.workspace');
  const mobile = matchMedia('(max-width:760px)');
  $('facets').open = !mobile.matches;
  mobile.addEventListener('change', e=>{ $('facets').open = !e.matches; });
  let collection = [], selected, laneFilter = '';
  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function sourceStatus(label, source) {
    if (!source) return label+' · aucune lecture.';
    if (source.state !== 'read') return label+' · indisponible ('+source.reason+'). Dernière tentative le '+date(sources.checkedAt)+'.';
    return label+' · projection du '+date(source.observedAt)+'.';
  }
  function renderSources() {
    $('pipeline-health').textContent = sourceStatus('Pipeline',pipeline);
    $('registry-health').textContent = sourceStatus('Agent Ops',registry);
    if (registry?.state === 'read') {
      $('registry-health').append(' '+registry.agents.length+' entrées.');
      const observation = {observed:'Observé',configured:'Déclaré',unknown:'Observation inconnue'};
      for (const entry of registry.agents) {
        const row = el('li');
        row.append(el('strong',entry.persona || entry.id),
          el('span',[entry.id,entry.runtime || 'Runtime non exposé',observation[entry.observation]].join(' · '),'sub'));
        $('roster').append(row);
      }
    }
  }
  function loadCollection() {
    const demo = $('sample').value === 'demo';
    const hasNative = pipeline?.state === 'read';
    collection = demo ? cockpitCards.demo() : [
      ...(hasNative ? [cockpitCards.fromPipeline(pipeline.record)] : []),
      cockpitCards.dot,cockpitCards.finance
    ];
    const health = [pipeline,registry].filter(source=>source?.state === 'read').length;
    $('provenance').textContent = demo ? 'Simulation · Les 30 dossiers et leurs dates sont fictifs.' :
      (hasNative ? '1 dossier Pipeline et 2 exemples fictifs.' : 'Mode dégradé · 2 exemples fictifs. Dossier Pipeline indisponible.')+
      ' Sources lues : '+health+'/2.'+(sources.checkedAt ? ' Relevé du '+date(sources.checkedAt)+'.' : '');
    for (const [key,label] of Object.entries(dimensions)) {
      const values = [...new Set(collection.map(card=>card[key]))].sort(collator.compare);
      $(key).replaceChildren(new Option(label,''),...values.map(value=>new Option(value,value)));
    }
    $('search').value = '';
    $('sort').value = 'priority';
    laneFilter = ''; selected = null;
    fromStart();
  }
  function textSection(title, text) {
    const box = el('section');
    box.append(el('h3',title),el('p',text));
    return box;
  }
  function drawDetail(card, returnToRow) {
    const detail = $('detail');
    detail.replaceChildren();
    if (!card) {detail.append(el('p','Aucune fiche sélectionnée.','empty')); return;}
    const back = el('button','Retour à la liste','back');
    back.type = 'button';
    back.onclick = returnToRow || null;
    const source = el('div',null,'sourceLine');
    source.append(el('strong',card.ref,card.url ? 'tag' : 'fixture'));
    if (card.updated) source.append(el('span','Mis à jour le '+date(card.updated)));
    const facts = el('dl',null,'facts');
    for (const [label,value] of [['Responsable',card.owner],['Exécutant',card.executor],['Domaine',card.domain],['Type de travail',card.type]]) {
      const pair = el('div');
      pair.append(el('dt',label),el('dd',value)); facts.append(pair);
    }
    const results = textSection('Résultats',card.result);
    if (card.evidence) results.append(el('p',card.evidence,'hint'));
    const history = el('section'), seq = el('ol');
    history.append(el('h3',card.url ? 'Chronologie Pipeline' : 'Chronologie fictive'),seq);
    for (const item of card.timeline) {
      const li = el('li',null,'event');
      li.append(el('strong',item.stage),document.createTextNode(' · '+item.label));
      if (item.at) {const time = el('time',date(item.at)); time.dateTime=item.at; li.append(time);}
      seq.append(li);
    }
    detail.append(back,source,el('h2',card.title),facts,textSection('Intention',card.intent),
      results,history,textSection('Suite attendue',card.next));
    if (card.url) {
      const link = el('a','Ouvrir le dossier '+card.ref+' ↗');
      link.href=card.url; link.rel='noopener noreferrer'; link.target='_blank';
      const box=el('section'); box.append(link); detail.append(box);
    }
  }
  function drawOverview(filtered) {
    $('overview').replaceChildren();
    for (const lane of cockpitCards.lanes) {
      const count = filtered.filter(card=>card.lane===lane.id).length;
      const button = el('button',null,'lane');
      button.type='button'; button.dataset.lane=lane.id;
      button.setAttribute('aria-pressed',String(laneFilter===lane.id));
      button.append(el('span',lane.label),el('strong',String(count)),el('small',lane.hint));
      button.onclick=()=>{
        laneFilter = laneFilter===lane.id ? '' : lane.id;
        fromStart();
        $('overview').querySelector('[data-lane="'+lane.id+'"]').focus();
      };
      $('overview').append(button);
    }
  }
  function compare(a,b) {
    if ($('sort').value === 'priority') {
      const diff = (order.get(a.lane) ?? 3) - (order.get(b.lane) ?? 3);
      if (diff) return diff;
    }
    if ($('sort').value !== 'title') {
      const diff = (b.updated || '').localeCompare(a.updated || '');
      if (diff) return diff;
    }
    return collator.compare(a.title,b.title) || collator.compare(a.id,b.id);
  }
  function render() {
    const term = fold($('search').value.trim());
    const filtered = collection.filter(card=>Object.keys(dimensions).every(key=>!$(key).value || $(key).value===card[key]) &&
      fold([card.title,card.ref,card.executor].join(' ')).includes(term));
    drawOverview(filtered);
    const visible = filtered.filter(card=>!laneFilter || card.lane===laneFilter).sort(compare);
    const count = visible.length;
    if (!visible.some(card=>card.id===selected)) selected = visible[0]?.id;
    $('total').textContent=count+' sur '+collection.length;
    const rows=$('rows');
    rows.replaceChildren();
    if (!count) rows.append(el('p','Aucun dossier ne correspond à ces filtres.','empty'));
    for (const card of visible) {
      const button=el('button',null,'row');
      button.id=card.id; button.type='button';
      button.setAttribute('aria-current',String(selected===card.id));
      button.setAttribute('aria-controls','detail');
      button.append(el('span',card.ref,'ref'),el('strong',card.title),el('span',card.status,'sub'));
      button.onclick=()=>{
        const rowTop = button.getBoundingClientRect().top;
        $(selected)?.setAttribute('aria-current','false');
        selected = card.id;
        button.setAttribute('aria-current','true');
        workspace.dataset.detail = 'open';
        drawDetail(card, () => {
          delete workspace.dataset.detail;
          button.focus({preventScroll:true});
          window.scrollBy(0, button.getBoundingClientRect().top - rowTop);
        });
        $('detail').focus({preventScroll:true});
        $('detail').scrollIntoView({block:'start'});
      };
      rows.append(button);
    }
    $('reset').disabled=!term && !laneFilter && !Object.keys(dimensions).some(key=>$(key).value);
    const activeFilters = Object.keys(dimensions).filter(key=>$(key).value).length;
    $('filter-count').textContent=activeFilters ? '('+activeFilters+')' : '';
    drawDetail(visible.find(card=>card.id===selected));
  }
  function fromStart() {delete workspace.dataset.detail; render();}
  $('filters').onsubmit=e=>e.preventDefault();
  $('filters').onchange=e=>{if(e.target.tagName==='SELECT') fromStart();};
  $('search').oninput=fromStart; $('sort').onchange=fromStart;
  $('filters').onreset=e=>{
    e.preventDefault();
    for (const key of Object.keys(dimensions)) $(key).value='';
    $('search').value=''; laneFilter=''; fromStart();
  };
  $('sample').onchange=loadCollection;
  renderSources(); loadCollection(); $('app').hidden=false;
})();
