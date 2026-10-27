import {temporalExtent} from './temporal.js';
import {Timeline} from './timeline.js';
import {Popover} from './popover.js';
import {showCoverage,coverageNotice} from './coverage.js';
import {scaleCenter} from './navigation.js';
import {reviewState,reviewStates,reviewLabel} from './review.js';
import {selectHighlights,highlightStatus} from './highlights.js';
import {connectionIndex,matchesEvidence,showConnections,visibleConnections} from './connections.js';
import {renderMemories} from './memories.js';
import {renderChapters,syncChapterRange} from './chapters.js';
import {Gallery} from './gallery.js';
import {isLifeMoment,lifeDomain} from './life-view.js';
import {matchesSubject,matchesIntent,matchesReview} from './filters.js';
import {renderStoryThreads} from './story-threads.js';
import {showContextReview} from './context-review.js';
import {showLibrary} from './library.js';
import {startReview} from './review-session.js';
import {showRecall,showPerson} from './core-panels.js';
import {EventEditor} from './editor.js';
import * as data from './data.js';
import {categories,icon,escape,number,fold,toast,DAY,YEAR,dateLabel,ownerDisplay} from './ui.js';

const el=id=>document.getElementById(id);
function saved(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
const state={events:[],filtered:[],meta:{},dataset:'real',query:'',reviewFilter:'active',scope:'all',subjectFilter:'all',intentFilter:'all',evidenceFilter:'all',connectionIndex:new Map(),latestIds:new Set(),activeConnectionId:null,connectedIds:new Set(),categories:new Set(Object.keys(categories)),favorites:new Set(saved('life-atlas-favorites',[])),favoritesOnly:false,range:null,domain:null,anchor:null};
let timeline,popup,editor,gallery,loadSequence=0,selectedId=null,discoveryPage=0;

function hydrate(event){const original=event;event=ownerDisplay(event,state.meta.owner);return {...event,reviewState:reviewState(event),ts:event.date?Date.parse(event.date+'T12:00:00Z'):null,search:fold([event.title,event.description,original.title,original.description,event.correspondent,event.subject,event.originalDate,event.place,event.notes,event.rationale,...(event.links||[]).map(l=>l.label)].join(' '))};}
// Every decision is Core's own: keeping a souvenir, dismissing, correcting.
async function saveEvent(event,changes){
 if(!event.core)throw new Error('La démonstration se parcourt en lecture seule.');
 const keys=Object.keys(changes);
 if(keys.length===1&&changes.reviewState==='confirmed')return decide(event,'confirm');
 if(keys.length===1&&changes.reviewState==='dismissed')return decide(event,'dismiss');
 throw new Error('Garde ce moment comme souvenir, puis corrige-le au besoin.');
}
async function decide(event,action,extra={}){
 const atlas=state.dataset;
 const actions={souvenir:()=>data.keepSouvenir(event,extra),confirm:()=>data.confirm(event),dismiss:()=>data.dismiss(event,extra.reason)};
 if(!actions[action])throw new Error('Décision inconnue.');
 const result=await actions[action]();
 return atlas===state.dataset?adoptResult(result):result.event;
}
async function correct(event,changes){return adoptResult(await data.correctSouvenir(event,changes));}
async function editContext(event,changes){return adoptResult(await data.editContext(event,changes));}
function adoptResult({meta,event}){state.meta={...state.meta,...meta};state.connectionIndex=connectionIndex(meta.relations);return adopt(event);}
// A stable link (#entry:<history id>, #souvenir:<note id>) opens its moment.
function openLink(){
 const match=/^#(entry|souvenir):([a-f0-9]{24})$/.exec(location.hash);
 if(!match||state.dataset!=='real')return;
 const found=state.events.find(e=>match[1]==='entry'?e.core?.id===match[2]:e.core?.souvenirNoteId===match[2]);
 if(!found){toast('Ce moment n’est pas dans ton historique AgentX.');return;}
 if(found.ts)focus([found]);popup.open([found],null,true);
}
function adopt(raw){
 const updated=hydrate(raw);state.events=state.events.map(e=>e.id===updated.id?updated:e);
 const old=[...state.domain],whole=(state.range[1]-state.range[0])/(old[1]-old[0])>.98;state.domain=lifeDomain(state.events,{all:state.scope==='all'});if(whole)state.range=[...state.domain];
 updatePeriod();renderChapters(el('life-chapters'),api);applyFilters();return updated;
}

function persist(){localStorage.setItem('life-atlas-favorites',JSON.stringify([...state.favorites]));}
function favorite(id){if(state.favorites.has(id))state.favorites.delete(id);else state.favorites.add(id);persist();if(state.favoritesOnly)applyFilters();else{discoveryPage=0;timeline.schedule();renderDiscovery();}toast(state.favorites.has(id)?'Ajouté à mes repères.':'Retiré de mes repères.');}
function setRange(range){
 const full=state.domain[1]-state.domain[0];let span=Math.max(DAY,Math.min(full,range[1]-range[0]));let start=range[0],end=start+span;
 if(start<state.domain[0]){start=state.domain[0];end=start+span;}if(end>state.domain[1]){end=state.domain[1];start=end-span;}
 state.range=[start,end];updatePeriod();timeline.schedule();
}
function clearConnection(){state.activeConnectionId=null;state.connectedIds.clear();el('connection-focus').hidden=true;}
function fit(){popup.close();clearConnection();setRange([...state.domain]);}
function zoom(factor,anchor=.5){
 const range=state.range;const span=range[1]-range[0],full=state.domain[1]-state.domain[0],next=Math.max(DAY,Math.min(full,span*factor));
 let point=range[0]+span*anchor;if(span/full>.98&&anchor===.5)point=state.anchor;
 setRange([point-next*anchor,point+next*(1-anchor)]);
}
function focus(events){
 const extents=events.map(e=>temporalExtent(e)).filter(Boolean);const dates=extents.flatMap(e=>e.kind==='period'?[e.start,e.end]:[e.anchor]).sort((a,b)=>a-b);if(!dates.length)return;
 const span=dates.length===1?40*DAY:Math.max(2*DAY,(dates.at(-1)-dates[0])*1.28);const middle=(dates[0]+dates.at(-1))/2;state.anchor=middle;setRange([middle-span/2,middle+span/2]);
}
function focusConnection(relation){
 state.activeConnectionId=relation.id;state.connectedIds=new Set(relation.eventIds);el('connection-focus').hidden=false;
 el('connection-focus-label').textContent=relation.title;el('connection-focus-count').textContent=`${number(relation.eventIds.length)} moments reliés`;
 focus(relation.eventIds.map(id=>state.events.find(e=>e.id===id)).filter(Boolean));
}
function setScale(scale){
 if(scale==='life'){fit();return;}
 const selected=state.events.find(e=>e.id===selectedId);const center=scaleCenter(state.range,state.domain,state.anchor,selected?.ts);const date=new Date(center),y=date.getUTCFullYear(),m=date.getUTCMonth(),d=date.getUTCDate();
 const range=scale==='decade'?[Date.UTC(Math.floor(y/10)*10,0,1),Date.UTC(Math.floor(y/10)*10+10,0,1)]:scale==='year'?[Date.UTC(y,0,1),Date.UTC(y+1,0,1)]:scale==='month'?[Date.UTC(y,m,1),Date.UTC(y,m+1,1)]:[Date.UTC(y,m,d),Date.UTC(y,m,d+1)];
 popup.close();setRange(range);
}
function updatePeriod(){
 const [start,end]=state.range,span=end-start,full=state.domain[1]-state.domain[0];
 let scale=span/full>.98?'life':span>2*YEAR?'decade':span>75*DAY?'year':span>1.1*DAY?'month':'day';
 document.querySelectorAll('[data-scale]').forEach(b=>{b.classList.toggle('active',b.dataset.scale===scale);b.setAttribute('aria-pressed',String(b.dataset.scale===scale));});
 const a=new Date(start),b=new Date(end-1);const fmt=options=>new Intl.DateTimeFormat('fr-CA',{timeZone:'UTC',...options});
 el('period-label').textContent=scale==='life'||span>2*YEAR?`${a.getUTCFullYear()} — ${b.getUTCFullYear()}`:span>75*DAY?(a.getUTCFullYear()===b.getUTCFullYear()?String(a.getUTCFullYear()):`${a.getUTCFullYear()} — ${b.getUTCFullYear()}`):span>1.1*DAY?(a.getUTCMonth()===b.getUTCMonth()&&a.getUTCFullYear()===b.getUTCFullYear()?fmt({month:'long',year:'numeric'}).format(a):`${fmt({day:'numeric',month:'short'}).format(a)} — ${fmt({day:'numeric',month:'short',year:'numeric'}).format(b)}`):fmt({weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(a);
 el('period-context').textContent=scale==='life'?'L’ensemble des traces datées':span>2*YEAR?'Les fils se croisent':scale==='day'?'Une journée dans les archives':'Chaque détail a sa place';
 el('zoom-range').value=String(100*Math.log(full/span)/Math.log(full/DAY));
 el('zoom-out').disabled=span/full>.999;el('zoom-in').disabled=span<1.01*DAY;
 syncChapterRange(el('life-chapters'),state);gallery?.render();
}
function scopeEvents(){return state.scope==='life'?state.events.filter(isLifeMoment):state.events;}
function resetDomain(){
 const dates=scopeEvents().map(e=>temporalExtent(e)).filter(Boolean).map(e=>e.anchor).sort((a,b)=>a-b);
 state.domain=lifeDomain(state.events,{all:state.scope==='all'});state.range=[...state.domain];state.anchor=dates[Math.floor(dates.length/2)]||Date.now();
 const [start,end]=state.domain;
 el('global-range').textContent=`${new Date(start).getUTCFullYear()} — ${new Date(end-1).getUTCFullYear()}`;
 updatePeriod();
}
function applyFilters(){
 discoveryPage=0;
 clearConnection();
 const terms=fold(state.query).split(/\s+/).filter(Boolean);
 const searched=scopeEvents().filter(e=>matchesSubject(e,state.subjectFilter)&&matchesIntent(e,state.intentFilter)&&(!state.favoritesOnly||state.favorites.has(e.id))&&terms.every(t=>e.search.includes(t)));
 const reviewed=searched.filter(e=>matchesReview(e,state.reviewFilter));
 renderIntro(searched);
 state.filtered=reviewed.filter(e=>matchesEvidence(e,state.evidenceFilter,state.connectionIndex,state.latestIds));
 const evidenceBase=reviewed.filter(e=>state.categories.has(e.category));
 el('investigation-toolbar').hidden=state.dataset==='demo';
 el('evidence-filters').innerHTML=[['all','Tous les moments'],['owner','Tes témoignages'],['kept','Souvenirs gardés'],['photos','Avec photos'],['linked','Avec recoupements']].map(([key,label])=>`<button type="button" data-evidence-filter="${key}" aria-pressed="${state.evidenceFilter===key}">${escape(label)} <span>${number(evidenceBase.filter(e=>matchesEvidence(e,key,state.connectionIndex,state.latestIds)).length)}</span></button>`).join('');
 el('evidence-filters').querySelectorAll('[data-evidence-filter]').forEach(b=>b.addEventListener('click',()=>{state.evidenceFilter=state.evidenceFilter===b.dataset.evidenceFilter?'all':b.dataset.evidenceFilter;popup.close();applyFilters();}));
 el('connections-button').innerHTML=icon('link')+' Les recoupements <span>'+number(visibleConnections(state).length)+'</span> ↗';
 const reviewBase=searched.filter(e=>matchesEvidence(e,state.evidenceFilter,state.connectionIndex,state.latestIds));
 el('review-legend').innerHTML=Object.entries(reviewStates).map(([key,r])=>`<button type="button" class="review-legend-item review-${key}" data-review-filter="${key}" aria-pressed="${state.reviewFilter===key}"><span aria-hidden="true">${r.symbol}</span>${r.plural}<span class="review-total">${number(reviewBase.filter(e=>reviewState(e)===key).length)}</span></button>`).join('');
 el('review-legend').querySelectorAll('[data-review-filter]').forEach(b=>b.addEventListener('click',()=>{state.reviewFilter=state.reviewFilter===b.dataset.reviewFilter?'active':b.dataset.reviewFilter;el('review-filter').value=state.reviewFilter;applyFilters();}));
 const counts=Object.fromEntries(Object.keys(categories).map(k=>[k,state.filtered.filter(e=>e.category===k).length]));
 el('category-filters').innerHTML=Object.entries(categories).map(([key,c])=>`<button class="category-filter" type="button" data-category="${key}" style="--cat-color:${c.color}" aria-pressed="${state.categories.has(key)}"><span class="cat-dot"></span>${escape(c.short)} <span class="cat-count">${number(counts[key])}</span></button>`).join('');
 el('category-filters').querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>{const k=b.dataset.category;if(state.categories.has(k))state.categories.delete(k);else state.categories.add(k);applyFilters();}));
 el('favorites-button').setAttribute('aria-pressed',String(state.favoritesOnly));
 el('review-filter').value=state.reviewFilter;
 const withHypotheses=!['documented','confirmed','unreviewed','dismissed'].includes(state.reviewFilter);
 el('hypotheses-button').setAttribute('aria-pressed',String(withHypotheses));el('hypotheses-button').textContent=withHypotheses?'◇ Pistes visibles':'◇ Pistes masquées';
 const filterCount=Number(state.subjectFilter!=='all')+Number(state.intentFilter!=='all')+Number(state.reviewFilter!=='active')+Number(state.evidenceFilter!=='all')+Number(state.scope!=='life'&&state.events.some(isLifeMoment))+Number(state.favoritesOnly)+Number(state.categories.size!==Object.keys(categories).length);
 el('active-filter-count').hidden=!filterCount;el('active-filter-count').textContent=filterCount;
 el('undated-count').textContent=number(state.filtered.filter(e=>!e.ts&&state.categories.has(e.category)).length);
 el('search-hint').textContent=state.query?`${number(state.filtered.length)} observations correspondent à cette recherche.`:'Chaque détail ouvre une histoire.';
 timeline.schedule();renderDiscovery();renderStoryThreads(el('story-threads'),popup,api);renderMemories(el('owner-memories'),api);gallery?.render();
}
function renderIntro(searched){
 if(!state.meta.core)return;
 const base=searched.filter(e=>state.categories.has(e.category)&&reviewState(e)!=='dismissed');
 const count=predicate=>base.filter(predicate).length;
 const life=state.events.filter(isLifeMoment).length;
 el('intro-meta').textContent=`${number(life)} moments de vie · ${state.meta.truncated?'au moins ':''}${number(state.events.length)} relevés disponibles${state.scope==='all'?' · tous les relevés explorés':''}`;
 const stats=[[count(e=>!!e.core?.souvenirNoteId),'souvenirs gardés','kept'],[count(e=>matchesReview(e,'pending')),'à relire','pending'],[count(e=>['owner-testimony','owner-tentative'].includes(e.confirmationBasis)),'témoignages','owner'],[count(e=>!e.ts),'à dater','undated']];
 el('intro-stats').innerHTML=stats.map(([n,label,key])=>`<button type="button" class="intro-stat" data-intro-stat="${key}"><strong>${number(n)}</strong><span>${label}</span></button>`).join('');
 el('intro-stats').querySelectorAll('[data-intro-stat]').forEach(b=>b.addEventListener('click',e=>{
  const key=b.dataset.introStat;state.reviewFilter=key==='pending'?'pending':'active';state.evidenceFilter=['kept','owner'].includes(key)?key:'all';applyFilters();
  if(key==='undated'){showUndated(el('intro-stats').querySelector('[data-intro-stat=undated]'));return;}
  document.querySelector('.atlas').scrollIntoView({behavior:'smooth',block:'start'});
 }));
}
function renderDiscovery(){
 const mode=state.query.trim()?'search':state.favoritesOnly?'favorites':state.reviewFilter==='hypothesis'?'hypotheses':state.reviewFilter==='dismissed'?'dismissed':'milestones';
 const selection=selectHighlights(state.filtered.filter(e=>state.categories.has(e.category)),{favorites:state.favorites,mode,query:state.query,page:discoveryPage});
 discoveryPage=selection.page;
 el('discovery-title').textContent={search:'Les moments retrouvés',favorites:'Mes moments repères',hypotheses:'Pistes à explorer',dismissed:'Éléments écartés',milestones:'Jalons suggérés'}[mode];
 el('discovery-caption').textContent=selection.candidateCount?`${number(selection.candidateCount)} ${mode==='milestones'?'jalons et repères':'éléments'} · ${selection.page+1} / ${selection.pageCount}`:'Aucun élément dans cette sélection';
 el('shuffle-button').disabled=selection.pageCount<2;
 el('shuffle-button').setAttribute('aria-label',mode==='milestones'?'Voir d’autres jalons suggérés':'Voir les éléments suivants');
 const empty=mode==='milestones'?'Aucun jalon reconnu avec ces filtres. Tu peux choisir tes moments importants avec ☆ dans leur dossier.':mode==='favorites'?'Choisis tes repères avec ☆ dans le dossier d’un moment.':'Aucun moment daté avec ces filtres.';
 el('discovery-items').innerHTML=selection.items.map(({event:e,reason})=>{const cat=categories[e.category],status=highlightStatus(e);return `<button class="discovery-item is-${reviewState(e)}" type="button" data-discovery="${escape(e.id)}" style="--cat-color:${cat.color}"><span class="discovery-illustration">${icon(state.favorites.has(e.id)?'star':cat.icon)}</span><span class="discovery-copy"><span class="discovery-reason">${escape(reason)}</span><strong>${escape(e.title)}</strong><small>${escape(dateLabel(e))} · ${escape(reviewLabel(e))}${status?` · ${escape(status)}`:''}</small></span></button>`;}).join('')||`<p class="discovery-empty">${escape(empty)}</p>`;
 el('discovery-items').querySelectorAll('[data-discovery]').forEach(b=>b.addEventListener('click',()=>popup.open([state.events.find(e=>e.id===b.dataset.discovery)],b,true)));
}
async function loadDataset(name){
 const sequence=++loadSequence;el('explore-life-button').disabled=true;popup?.close();state.dataset=name;state.query='';state.subjectFilter='all';state.intentFilter='all';el('subject-filter').value='all';el('intent-filter').value='all';state.reviewFilter='active';state.evidenceFilter='all';el('review-filter').value='active';state.favoritesOnly=false;state.categories=new Set(Object.keys(categories));el('search').value='';
 el('timeline').innerHTML='<div class="loading-state">Les souvenirs trouvent leur place…</div>';
 try{
  const loaded=name==='demo'?data.loadDemo():await data.loadHistory();if(sequence!==loadSequence)return;
  state.meta=loaded.meta;state.events=loaded.events.map(hydrate);state.connectionIndex=connectionIndex(loaded.meta.relations);state.latestIds=new Set();
  el('coverage-warning').hidden=!loaded.meta.truncated;el('coverage-warning').textContent=coverageNotice(loaded.meta);
  el('owner-heading').textContent=name==='demo'?'LE SCÉNARIO DE CAMILLE':'TA VIE, TES TRACES';
  renderChapters(el('life-chapters'),api);
  state.scope=name==='real'&&state.events.some(isLifeMoment)?'life':'all';el('scope-filter').value=state.scope;el('pass-toolbar').hidden=name==='demo';
  el('library-button').hidden=name==='demo';el('context-button').hidden=name==='demo';
  if(name==='real')data.photoCount().then(count=>{if(sequence===loadSequence)el('library-button').textContent=`Photothèque · ${count.exact?'':'≥ '}${number(count.total)} ↗`;}).catch(()=>{if(sequence===loadSequence)el('library-button').textContent='Photothèque ↗';});
  resetDomain();
  el('recall-button').hidden=loaded.meta.authority!=='agentx.core';
  if(!loaded.meta.core)el('intro-stats').replaceChildren();
  el('dataset-name').textContent=name==='demo'?'Démo · Camille':loaded.meta.pass2||loaded.meta.authority==='agentx.core'?'Mon histoire':'Mes courriels';el('intro-meta').textContent=name==='demo'?'Une vie fictive pour explorer les possibilités.':loaded.meta.authority==='agentx.core'?`${loaded.meta.truncated?'Au moins ':''}${number(loaded.meta.events)} moments · ${loaded.meta.truncated?'couverture partielle dans':'lus dans'} AgentX`:loaded.meta.pass3?`${number(loaded.meta.pass3.curatedEvents)} moments et pistes · ${number(loaded.meta.pass3.relations.length)} recoupements à explorer`:loaded.meta.pass2?`${number(loaded.meta.pass2.events)} moments et pistes · courriels, documents et médias`:`${number(loaded.meta.events)} observations · ${number(loaded.meta.threads)} fils de correspondance · une histoire à reconstruire`;
  el('source-note').textContent=name==='demo'?'Scénario entièrement fictif':loaded.meta.authority==='agentx.core'?`AgentX Core · ${loaded.meta.truncated?'couverture partielle':'source d’autorité'}`:loaded.meta.pass3?'Troisième passe · extraits contrôlés':loaded.meta.pass2?'Exploration approfondie · à vérifier':'Courriels · observations existantes';
  updatePeriod();applyFilters();el('explore-life-button').disabled=false;
 }catch(error){el('timeline').innerHTML=`<div class="loading-state"><strong>${escape(error.message)}</strong><a class="secondary-button" href="">Réessayer</a></div>`;}
}

function showUndated(anchor){
 const events=state.filtered.filter(e=>!e.ts&&state.categories.has(e.category));
 popup.info(`<h3>Les souvenirs à dater</h3><p>${number(events.length)} observations attendent une date exploitable. Elles restent dans les archives, sans être placées artificiellement à la date du courriel.</p><div class="popup-list">${events.slice(0,100).map(e=>`<button class="related-event" type="button" data-undated="${e.id}"><time>${escape(e.originalDate&&e.originalDate!=='unknown'?String(e.originalDate).slice(0,15):'À préciser')}</time><strong>${escape(e.title)}</strong></button>`).join('')}</div>${events.length>100?'<p>Utilise la recherche pour réduire cette liste.</p>':''}`,anchor);
 popup.root.querySelectorAll('[data-undated]').forEach(b=>b.addEventListener('click',()=>popup.open([state.events.find(e=>e.id===b.dataset.undated)],anchor,true)));
}
function showInfo(anchor){
 popup.info(`<h3>Les traces de mon histoire</h3><p>${state.dataset==='demo'?'Cette démonstration utilise uniquement des événements et des sources fictifs.':state.meta.authority==='agentx.core'?`Cette vue lit l’historique personnel d’AgentX Core (lu le ${new Intl.DateTimeFormat('fr-CA',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Toronto'}).format(new Date(state.meta.fetchedAt))}, heure de Toronto). Life Atlas n’en garde aucune copie. Garder un moment comme souvenir l’ajoute à la mémoire de Nestor; écarter un moment est une décision enregistrée dans Core. Un moment sans date écrite reste « à dater » : la date du courriel n’est pas sa date.`:state.meta.pass2?'Cette vue réunit les découvertes issues des courriels, documents, calendriers et métadonnées de médias. Les extraits cités permettent de vérifier chaque proposition.':'Cette vue réutilise les observations déjà extraites de l’archive Secretary. Les messages originaux restent accessibles pour lire leur contexte.'}</p><div class="info-stats"><div><strong>${number(state.events.length)}</strong><small>observations distinctes</small></div><div><strong>${number(state.events.filter(e=>e.ts).length)}</strong><small>observations datées</small></div><div><strong>${number(state.meta.messages||0)}</strong><small>courriels dans l’archive</small></div><div><strong>${number(state.meta.threads||0)}</strong><small>fils archivés</small></div></div><p>Les correspondants d’un message ne sont pas automatiquement les participants de l’événement. Les catégories sont proposées depuis le texte.</p><p>${state.meta.pass2?'Une nouvelle passe rapproche les courriels, documents, calendriers et indices de médias. « Les traces et les blancs » précise ce qui a été parcouru et ce qui reste à explorer.':'La passe dédiée à la chronologie n’a pas encore été exécutée sur ce corpus.'}</p>`,anchor);
}
function theme(mode){document.documentElement.dataset.theme=mode;localStorage.setItem('life-atlas-theme-preference',mode);el('theme-button').innerHTML=icon(mode==='dark'?'sun':'moon');timeline?.schedule();}
const api={state,get selectedId(){return selectedId;},setRange,zoom,fit,focus,focusConnection,favorite,toast,saveEvent,decide,correct,editContext,edit:(event,anchor)=>editor.open(event,anchor),showPerson:(name,anchor)=>showPerson(popup,api,name,anchor),photoOpen:(id,anchor,options)=>gallery.open(id,anchor,options),onPhotosLoaded:()=>{renderChapters(el('life-chapters'),api);syncChapterRange(el('life-chapters'),state);timeline.schedule();},select:id=>{selectedId=id;document.querySelectorAll('[data-cluster]').forEach(b=>{const selected=!!id&&timeline?.clusters?.[Number(b.dataset.cluster)]?.events.some(e=>e.id===id);b.classList.toggle('selected',selected);b.setAttribute('aria-expanded',String(selected));});if(id){const e=state.events.find(e=>e.id===id);if(e?.ts)state.anchor=e.ts;}},open:(events,anchor,pin,point)=>popup.open(events,anchor,pin,point),close:()=>popup?.close(),hidePreview:()=>{if(popup&&!popup.pinned)popup.close(false);},leave:()=>popup.leave()};
popup=new Popover(el('popup-root'),api);timeline=new Timeline(el('timeline'),api);editor=new EventEditor(popup,api);
gallery=new Gallery(el('life-gallery'),popup,api);
function immersive(enabled){document.body.classList.toggle('atlas-immersive',enabled);el('immersive-button').setAttribute('aria-pressed',String(enabled));el('immersive-button').textContent=enabled?'⛶ Quitter la vue immersive':'⛶ Vue immersive';popup.close();timeline.schedule();window.scrollTo({top:0,behavior:'instant'});el(enabled?'timeline':'explore-life-button').focus({preventScroll:true});}
el('explore-life-button').addEventListener('click',()=>immersive(true));
el('immersive-button').addEventListener('click',()=>immersive(!document.body.classList.contains('atlas-immersive')));
function exploreTools(expanded){document.body.classList.toggle('atlas-tools-open',expanded);el('explore-tools-button').setAttribute('aria-expanded',String(expanded));timeline.schedule();}
el('explore-tools-button').addEventListener('click',()=>{const expanded=el('explore-tools-button').getAttribute('aria-expanded')!=='true';exploreTools(expanded);if(expanded)el('coverage-button').focus({preventScroll:true});});
document.addEventListener('keydown',e=>{if(e.key!=='Escape'||popup.root.children.length)return;if(document.body.classList.contains('atlas-tools-open')&&matchMedia('(max-width:760px)').matches){exploreTools(false);el('explore-tools-button').focus({preventScroll:true});e.stopPropagation();return;}if(document.body.classList.contains('atlas-immersive'))immersive(false);},true);
el('filters-button').addEventListener('click',()=>{const panel=el('advanced-filters');panel.hidden=!panel.hidden;el('filters-button').setAttribute('aria-expanded',String(!panel.hidden));});
el('hypotheses-button').addEventListener('click',()=>{state.reviewFilter=['documented','confirmed','unreviewed','dismissed'].includes(state.reviewFilter)?'active':'documented';applyFilters();});
el('filters-reset').addEventListener('click',()=>{state.reviewFilter='active';state.evidenceFilter='all';state.favoritesOnly=false;state.categories=new Set(Object.keys(categories));state.subjectFilter='all';state.intentFilter='all';el('subject-filter').value='all';el('intent-filter').value='all';state.scope=state.dataset==='real'&&state.events.some(isLifeMoment)?'life':'all';el('scope-filter').value=state.scope;resetDomain();applyFilters();});
el('validation-button').addEventListener('click',e=>startReview(popup,api,e.currentTarget));
el('recall-button').addEventListener('click',e=>showRecall(popup,api,e.currentTarget));
el('search-icon').innerHTML=icon('search');el('date-button').innerHTML=icon('calendar');
// Open in the owner's requested dark theme, including browsers with an old light preference.
theme('dark');
document.querySelectorAll('[data-scale]').forEach(b=>b.addEventListener('click',()=>setScale(b.dataset.scale)));
el('zoom-in').addEventListener('click',()=>zoom(.45));el('zoom-out').addEventListener('click',()=>zoom(2.2));
el('zoom-range').addEventListener('input',e=>{const full=state.domain[1]-state.domain[0],span=full/Math.pow(full/DAY,Number(e.target.value)/100),center=state.range[1]-state.range[0]>full*.98?state.anchor:(state.range[0]+state.range[1])/2;setRange([center-span/2,center+span/2]);});
el('fit-button').addEventListener('click',fit);
for(const [id,direction]of [['previous-button',-1],['next-button',1]])el(id).addEventListener('click',()=>{popup.close();const shift=(state.range[1]-state.range[0])*.75*direction;setRange(state.range.map(v=>v+shift));});
el('search').addEventListener('input',e=>{state.query=e.target.value;applyFilters();});
el('scope-filter').addEventListener('change',e=>{state.scope=e.target.value;popup.close();resetDomain();applyFilters();});
el('subject-filter').addEventListener('change',e=>{state.subjectFilter=e.target.value;popup.close();applyFilters();});
el('intent-filter').addEventListener('change',e=>{state.intentFilter=e.target.value;popup.close();applyFilters();});
el('context-button').addEventListener('click',e=>showContextReview(popup,api,e.currentTarget));
el('library-button').addEventListener('click',e=>showLibrary(popup,api,e.currentTarget));
el('coverage-button').addEventListener('click',e=>showCoverage(popup,state,e.currentTarget));
el('connections-button').addEventListener('click',e=>showConnections(popup,api,e.currentTarget));
el('connection-focus-proof').addEventListener('click',e=>showConnections(popup,api,e.currentTarget,{relationId:state.activeConnectionId}));
el('connection-focus-clear').addEventListener('click',()=>{clearConnection();timeline.schedule();});
el('review-filter').addEventListener('change',e=>{state.reviewFilter=e.target.value;applyFilters();});
el('favorites-button').addEventListener('click',()=>{state.favoritesOnly=!state.favoritesOnly;applyFilters();});
el('shuffle-button').addEventListener('click',()=>{discoveryPage++;renderDiscovery();});
el('discovery-info-button').addEventListener('click',e=>popup.info('<h3>Pourquoi ces moments ?</h3><p>Ce sont des jalons suggérés, pas un classement de ce qui compte le plus pour toi. Des règles repèrent dans les titres les naissances, transitions familiales, déménagements, diplômes, changements professionnels et certaines expériences.</p><p>La sélection présente jusqu’à trois moments variés. La flèche parcourt les autres jalons admissibles; les démarches courantes ne servent pas à remplir la bande.</p><p><strong>Tes repères étoilés passent en premier.</strong> Ouvre un dossier et utilise ☆ pour choisir toi-même un moment, même un petit détail très personnel. Ces repères restent enregistrés dans ce navigateur.</p><p>Confirmer un fait change sa validation, pas son importance. Les pistes, projets, événements annulés et dates futures ne deviennent pas automatiquement des jalons. Si tu en fais un repère, leur statut reste visible. Les filtres et la recherche restent actifs; le filtre « Pistes » ouvre une sélection distincte.</p>',e.currentTarget));
el('undated-button').addEventListener('click',e=>showUndated(e.currentTarget));
el('archive-info-button').addEventListener('click',e=>showInfo(e.currentTarget));
el('theme-button').addEventListener('click',()=>theme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
el('dataset-button').addEventListener('click',e=>{popup.info('<h3>Choisir mon atlas</h3><p>Explorer mon histoire et ses sources, ou parcourir un scénario illustratif.</p><div class="popup-actions"><button class="primary-button" type="button" data-load="real">Mon histoire</button><button class="secondary-button" type="button" data-load="demo">Démo · Camille</button></div>',e.currentTarget);popup.root.querySelectorAll('[data-load]').forEach(b=>b.addEventListener('click',()=>loadDataset(b.dataset.load)));});
el('help-button').addEventListener('click',e=>popup.info('<h3>Prendre le temps d’explorer</h3><p>Les bandes montrent les périodes documentées, les points les repères datés. Survole pour un aperçu; clique pour ouvrir le dossier complet. Des hachures signalent les bornes approximatives. Tu peux préciser une fin dans l’éditeur.</p><div class="help-row"><span>Rechercher</span><kbd>/</kbd></div><div class="help-row"><span>Fermer une fenêtre</span><kbd>Échap</kbd></div><div class="help-row"><span>Vue globale</span><kbd>G</kbd></div><div class="help-row"><span>Zoomer / dézoomer</span><kbd>+ / −</kbd></div><div class="help-row"><span>Zoom au pointeur</span><kbd>Ctrl + molette</kbd></div><div class="help-row"><span>Se déplacer</span><span>Glisser la frise ou son repère global</span></div>',e.currentTarget));
el('date-button').addEventListener('click',e=>{popup.info('<h3>Un jour dans mon histoire</h3><p>Choisir une date pour ouvrir la journée correspondante.</p><div class="date-picker"><input id="jump-date" type="date" aria-label="Date à explorer"><button id="jump-submit" type="button" class="primary-button">Ouvrir cette journée →</button></div>',e.currentTarget);el('jump-submit').addEventListener('click',()=>{const value=el('jump-date').value;if(!value){el('jump-date').focus();return;}const start=Date.parse(value+'T00:00:00Z');if(start<state.domain[0]||start>state.domain[1]){toast('Cette date se trouve hors de la période de cet atlas.');return;}popup.close();state.anchor=start+DAY/2;setRange([start,start+DAY]);});});
document.addEventListener('keydown',e=>{if(e.target.closest?.('input,textarea,select'))return;if(e.key==='/'){e.preventDefault();el('search').focus();}else if(e.key.toLowerCase()==='g'){fit();}else if(e.key==='+'||e.key==='='){zoom(.5);}else if(e.key==='-'){zoom(2);}});
window.addEventListener('resize',()=>timeline.schedule());
window.lifeAtlas={state,fit,setScale,loadDataset,focus};
await loadDataset(new URLSearchParams(location.search).get('demo')==='1'?'demo':'real');
window.addEventListener('hashchange',()=>openLink());
await openLink();
await gallery.load();
