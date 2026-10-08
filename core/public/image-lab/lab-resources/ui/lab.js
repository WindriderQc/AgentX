'use strict';
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n, digits = 1) => Number.isFinite(Number(n)) && n != null ? Number(n).toLocaleString('fr-CA', {maximumFractionDigits:digits}) : '—';
  const duration = n => n == null ? 'Non chronométré ici' : n < 60 ? `${fmt(n)} s` : `${Math.floor(n / 60)} min ${Math.round(n % 60)} s`;
  const bytes = n => n > 1e9 ? `${fmt(n / 1e9)} Go` : n > 1e6 ? `${fmt(n / 1e6)} Mo` : `${fmt(n / 1e3, 0)} ko`;
  const stamp = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('fr-CA', {timeZone:'America/Toronto',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Date non fournie';
  const dims = p => `${p.width} × ${p.height}`;
  const href = (view, group) => `#${view}${group ? '?group=' + encodeURIComponent(group) : ''}`;
  const link = (url, label, cls = 'link') => `<a class="${cls}" href="${esc(url)}"${url.startsWith('https://') ? ' target="_blank" rel="noopener"' : ''}>${esc(label)} ↗</a>`;
  const badge = (text, color = '') => `<span class="badge ${color}">${esc(text)}</span>`;
  const pageHead = (eyebrow, title, text, extra = '') => `<div class="page-head"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${text}</p></div>${extra}</div>`;
  const titles = {overview:'Vue d’ensemble',compare:'Comparer les images',machines:'Parc & architecture',roadmap:'La suite du chantier',files:'Fichiers & preuves',recipes:'Workflows & recettes',plan:'Plan à jour · sans GPU'};
  const categories = {all:'Tout',performance:'Une ou deux GPU',scenes:'Scènes / kids',edition:'Retouches',logos:'Logos / docs',textures:'Textures / paint jobs'};
  const fileCategories = {all:'Tout',assets:'Assets reçus',preuves:'Preuves',plans:'Plans',exploration:'Exploration',packs:'Dossiers'};
  let data, loading = false, current = 'overview', category = 'all', groupId = 'gpu-k04';
  let pair = [], regime = 'C', fileCategory = 'all', fileSearch = '', modalPair = [], viewerMode = 'side';
  let zoom = 100, scrollGuard = false, priorFocus, toastTimer;
  const group = () => data.groups.find(g => g.id === groupId) || data.groups[0];
  const tabs = (values, selected, key) => `<div class="filter-tabs">${Object.entries(values).map(([k,v]) => `<button data-${key}="${k}" aria-pressed="${selected === k}">${esc(v)}</button>`).join('')}</div>`;

  function coreSummary() {
    const c = data.core;
    if (!c?.available) return 'État Core indisponible : l’admission doit être vérifiée avant tout essai GPU.';
    if (c.maintenance) return 'Core indique une maintenance. Aucun nouvel essai GPU depuis ce site.';
    const occupied = Object.entries(c.byHost || {}).filter(([, h]) => h.blocked).map(([name]) => name);
    return occupied.length ? `${occupied.join(', ')} : occupation déclarée dans Core. Les lots attendent leur admission.` : 'Aucune occupation déclarée sur les hôtes relevés. Une admission Core reste requise avant chaque lot.';
  }
  function overview() {
    const p = data.performance, t = p.throughput;
    return `<section class="hero"><div class="hero-copy"><span class="eyebrow">NOTRE LABO · DU FUN AU HQ</span><h1>De belles images.<br>Des preuves.<br>La suite, en clair.</h1><p>Scènes pour les kids, logos pour nos docs, matières pour GraphysX. On explore le meilleur de notre parc — et on garde les étapes qui mènent à un fichier utilisable.</p><div class="hero-actions">${link(href('compare'), 'Comparer les rendus', 'button')}${link(href('recipes'), 'Workflows et recettes', 'button secondary')}</div><p class="hero-note"><span class="dot"></span>8 octobre · résultats réconciliés ; travail sans GPU.</p></div><div class="hero-art"><img class="hero-picture" src="${data.hero.src}" alt="Illustration reçue : jardin et petits personnages" width="${data.hero.previewWidth}" height="${data.hero.previewHeight}"><span class="art-tag"><span class="dot"></span>Jardin reçu · graine 9001</span><div class="art-sticker"><img src="${data.logo.original}" alt="Logo AgentX reçu"><p>NOTRE LOGO V1</p></div><span class="hero-coordinate">2048 × 2048 NATIFS · QWEN 2.1</span></div></section>
      <div class="metrics"><div class="metric"><div class="metric-top">CAMPAGNE PERFORMANCE <span>01</span></div><div class="metric-number">${p.renders}<small> rendus</small></div><p>${p.lots} lots · ${p.failed ?? '—'} échec · ressources restituées</p></div><div class="metric"><div class="metric-top">DEUX 3090 PARTAGÉES <span>02</span></div><div class="metric-number">${fmt(p.regimes.C.warm.median, 0)}<small> s / image</small></div><p>Médiane à chaud · nouveau texte · n=${p.regimes.C.warm.n}</p></div><div class="metric"><div class="metric-top">DEUX WORKERS <span>03</span></div><div class="metric-number">${fmt(t.steady)}<small> images / h</small></div><p>Régime établi du lot de ${duration(t.durationSeconds)} · pas une nuit validée</p></div><div class="metric"><div class="metric-top">EXPLORATION DOCUMENTÉE <span>04</span></div><div class="metric-number">${data.exploration.recipes}<small> pistes</small></div><p>${data.exploration.graphs} graphes candidats · lots exécutés et limites dans le plan</p></div></div>
      <div class="status-ribbon"><p><strong>État du parc</strong> · ${esc(coreSummary())}<br><small>Relevé : ${stamp(data.core?.observedAt)} · consultation en lecture seule.</small></p>${link(href('machines'), 'Voir les machines')}</div>
      <div class="section-title"><div><h2>Qui a livré quoi ?</h2><p>Les sessions d’appui et notre prochaine qualification.</p></div>${link(href('files'), 'Ouvrir les dossiers')}</div><div class="sessions">${data.sessions.map((s,i) => `<article class="session"><div class="session-top"><span class="session-num">0${i+1}</span><span class="owner">${esc(s.owner)}</span></div><h3>${esc(s.title)}</h3>${badge(s.label, s.state === 'delivered' ? 'green' : 'purple')}<p>${esc(s.description)}</p><div class="session-foot"><small>${stamp(s.updatedAt)}</small>${link(href(s.view,s.group), 'Explorer')}</div></article>`).join('')}</div>
      <div class="section-title"><div><h2>Trois usages, un workflow complet.</h2><p>Créer → choisir → retoucher → finir → recevoir.</p></div></div><div class="usage-grid">
      <article class="usage"><div class="usage-image"><img src="${data.hero.src}" alt="Jardin reçu" loading="lazy">${badge('SCÈNES / KIDS')}</div><div class="usage-copy"><h3>Des scènes qui racontent juste</h3><p>Plusieurs graines reçues. Les objets et leurs relations gardent leur propre validation.</p><div class="workflow-trail"><span>Brief</span><b>→</b><span>Graines</span><b>→</b><span>Retouche</span></div>${link(href('compare','jardins'),'Voir les scènes')}</div></article>
      <article class="usage logo-usage"><div class="usage-image"><img src="${data.logo.original}" alt="Logo AgentX RGBA">${badge('LOGOS / DOCS')}</div><div class="usage-copy"><h3>Du logo à l’icône utilisable</h3><p>Vecteur et alpha réel, exports 24/32/64. Le kit reçu est prêt à retrouver dans les fichiers.</p><div class="workflow-trail"><span>Création</span><b>→</b><span>SVG</span><b>→</b><span>Petites tailles</span></div>${link(href('compare','logo'),'Inspecter le logo')}</div></article>
      <article class="usage"><div class="usage-image"><img src="${data.tile.src}" alt="Nouvelle texture torus" loading="lazy">${badge('TEXTURES / PAINT JOBS')}</div><div class="usage-copy"><h3>Une matière qui boucle</h3><p>${data.tile.accepted ? 'Master, atlas et cinq vues reçus. L’import dans le produit GraphysX reste distinct.' : 'Nouveau master 2048² généré. Raccords mesurés ; apparence et répétition à recevoir.'}</p><div class="workflow-trail"><span>Tuile</span><b>→</b><span>3 × 3</span><b>→</b><span>Atlas</span></div>${link(href('compare','textures'),'Voir la nouvelle tuile')}</div></article></div>
      <div class="boundary"><span>✦</span><p>Le plafond global reste ouvert. Une image reçue, une vitesse mesurée et une recette de production sont trois validations différentes. Les retouches cuivre et texte, la nouvelle tuile et l’atlas sont reçus sur leurs fichiers. La prochaine marche est leur intégration en workflows complets.</p></div>`;
  }

  function imageCard(item, index) {
    const isSelected = pair.includes(index);
    const native = item.kind === 'icon' ? 'PNG à sa taille native' : 'Aperçu réduit · ouvrir les pixels natifs';
    return `<article class="image-card${isSelected ? ' selected' : ''}" data-image="${index}"><div class="image-top"><label><input type="checkbox" data-pair="${index}" ${isSelected ? 'checked' : ''}>Comparer</label><span>${item.kind === 'crop' ? 'CROP DU MASTER' : item.kind === 'bench' ? 'BANC PRIVÉ' : item.kind === 'icon' ? 'EXPORT RGBA' : 'FICHIER ORIGINAL CONSERVÉ'}</span></div><button class="image-stage${item.kind === 'icon' ? ' icon-stage' : ''}" data-open="${index}" data-background="${item.background || 'light'}" aria-label="Examiner ${esc(item.title)}"><img src="${item.kind === 'icon' ? item.original : item.src}" alt="${esc(item.title)}" width="${item.kind === 'icon' ? item.width : item.previewWidth}" height="${item.kind === 'icon' ? item.height : item.previewHeight}" loading="lazy"></button><div class="image-caption"><h3>${esc(item.title)}</h3>${badge(item.status || 'Proposition', /reçu|reçue|identique|Préféré/i.test(item.status) ? 'green' : 'purple')}<div class="image-meta"><span>${dims(item)} px</span>${item.steps ? `<span>${item.steps} étapes</span>` : ''}${item.seed != null ? `<span>Graine ${item.seed}</span>` : ''}</div>${item.seconds != null ? `<div class="time-value">${duration(item.seconds)}</div><div class="time-scope">${esc(item.timeScope || 'Génération observée')}</div>` : ''}<p>${esc(item.note || item.model || '')}</p><div class="image-links"><button class="link" data-open="${index}">Examiner ↗</button>${link(item.original, 'Original')}${item.receipt ? link(item.receipt,'Reçu technique') : ''}</div><p style="margin-top:8px;font-size:9px">${native}</p></div></article>`;
  }
  function compare() {
    const g = group();
    const options = data.groups.filter(item => category === 'all' || item.category === category);
    if (!pair.length) pair = [...(g.defaultPair || [0,1])];
    return `${pageHead('LES IMAGES, ENSEMBLE', 'Comparer ce qui est comparable.', 'Un usage et un brief à la fois. Dimensions réelles, ordre stable et originaux accessibles ; les aperçus ne suffisent pas pour juger le détail.')}
      <div class="compare-controls">${tabs(categories,category,'category')}<div class="selector-line"><div class="field"><label for="group-select">Choisir une comparaison</label><select id="group-select">${options.map(item => `<option value="${item.id}"${item.id === g.id ? ' selected' : ''}>${esc(item.title)}</option>`).join('')}</select></div><p class="hint">${options.length} comparaisons dans cette sélection.<br>Coche deux fichiers pour les ouvrir ensemble.</p></div></div>
      <section class="group-intro"><span class="eyebrow">${esc(categories[g.category])}</span><h2>${esc(g.title)}</h2><p>${esc(g.description)}</p><p class="scope">${esc(g.scope || '')}</p>${g.reference ? `<div class="reference"><img src="${g.reference.src}" alt="Référence de cette comparaison"><div><strong>${esc(g.reference.title)}</strong><p>${dims(g.reference)} px · parent conservé</p>${link(g.reference.original,'Ouvrir la référence')}</div></div>` : ''}<div class="group-top-actions"><button class="button" id="compare-pair"${pair.length !== 2 ? ' disabled' : ''}>Comparer les deux originaux ↗</button>${g.evidence ? link(g.evidence,'Preuves et protocole','button secondary') : ''}</div></section>
      <div class="image-deck" data-count="${g.items.length}">${g.items.map(imageCard).join('')}</div>
      ${g.humanReceipt ? `<details class="provenance"><summary>Réception humaine de ce fichier</summary><p>${esc(g.scope)}</p>${link(g.humanReceipt,'Avis exact et empreinte')}</details>` : ''}
      ${g.inspections ? `<details class="provenance" open><summary>Répétition et détails natifs du master</summary><p>La répétition 3 × 3, les raccords et l’intérieur sont disponibles à leur taille native. La répétition est un assemblage du master 2048², pas une génération 6144².</p><div class="group-top-actions">${g.inspections.map(i=>link(i.href,i.title,'small-button')).join('')}</div></details>` : ''}
      ${g.brief ? `<details class="provenance"><summary>Brief exact de cette comparaison</summary><p>${esc(g.brief)}</p></details>` : ''}
      <details class="provenance"><summary>Filiation, graphes et empreintes</summary><p>Les aperçus WebP sont des copies réduites pour le site. Les fichiers « Original » gardent leur format et leurs pixels. Changer de graine ou de modèle produit une proposition ; seule une édition avec référence possède une filiation d’édition.</p><ul>${g.items.map(i => `<li><strong>${esc(i.title)}</strong> · ${dims(i)} · SHA-256 <code>${esc(i.sha256)}</code> ${i.graph ? link(i.graph,'Graphe') : ''} ${i.receipt ? link(i.receipt,'Reçu') : ''}${i.archiveSeconds != null ? ` · archivage observé ${duration(i.archiveSeconds)}` : ''}</li>`).join('')}</ul><p>Les durées affichées ne sont pas un temps total jusqu’à réception humaine. Génération, archivage, restitution et finition restent séparés dans les dossiers reproductibles.</p></details>`;
  }

  const architectures = {
    A:{title:'Une 3090 fait le travail',desc:'Tous les composants sur une carte avec leur gestion mémoire. La seconde carte ne calcule pas cette image.',nodes:[['BRIEF','Un texte, une graine','Qwen 2.1 BF16 · 25 étapes'],['GPU 0 · 24 GO','Encodeur → générateur → VAE','Une requête, une carte'],['GPU 1 · 24 GO','Disponible pour une autre charge','Selon admission et cohabitation']],note:'La VRAM n’est pas un pool de 48 Go. Ce montage est le témoin mesuré A.'},
    B:{title:'Composants répartis sur deux cartes',desc:'L’encodeur de texte travaille sur GPU 1 ; le générateur et le VAE sur GPU 0. Une image reste générée par une seule carte de calcul.',nodes:[['GPU 1 · 24 GO','Encoder le texte','Conditionnement identique au témoin'],['GPU 0 · 24 GO','Générer puis décoder','Un générateur · Qwen 2.1 BF16'],['FICHIER','Même PNG que le témoin A','Sur les comparaisons déterministes']],note:'Montage B : un gain de gestion des composants et du texte. Ce n’est pas du calcul de diffusion partagé.'},
    C:{title:'Les deux 3090 calculent la même image',desc:'Une vraie diffusion partagée avec le nœud Ulysses privé. Le gain de latence est mesuré ; l’image diffère du témoin et doit être revue.',nodes:[['GPU 0 + GPU 1','Préparer le conditionnement','Deux cartes · pools séparés'],['GPU 0 ⇄ GPU 1','Diffusion Ulysses partagée','PCIe Gen4 ×8 · PHB · sans NVLink'],['FICHIER','Une image HQ','K04 reçu sur sa paire']],note:'Montage C : 129,7 s médians pour un nouveau texte à chaud. Nœuds privés ; édition avec référence, LoRA et ControlNet ne sont pas qualifiés dans ce montage.'},
    parallel:{title:'Deux cartes, deux images en parallèle',desc:'Un worker indépendant par 3090. C’est la voie mesurée pour produire plusieurs images, avec le temps et la chaleur d’un lot prolongé.',nodes:[['FILE DE BRIEFS','Deux jobs indépendants','Chaque job possède sa graine'],['GPU 0 / GPU 1','Un worker sur chaque carte','Qwen 2.1 BF16 · 25 étapes'],['DEUX FICHIERS','Deux propositions par vague','Pas une image calculée à quatre mains']],note:'16 images en 21 min 30 jusqu’au dernier PNG. 46,1 images/h sur les vagues établies ; 44,6/h pour tout le lot, 43,4/h avec réserve et restitution. Ce lot ne qualifie pas une nuit entière.'}
  };
  function machineCard(name, cls, gpuName, memory, desc) {
    const f = data.fleet.find(x => x.name === name), c = data.core?.byHost?.[name];
    const live = (f?.gpu || []).map(g => {
      const temp = g['temperature.gpu'] ?? g['temperature.gpu [C]'];
      return `<div>GPU ${esc(g.index)} · ${esc(g['memory.used [MiB]'] ?? '—')} / ${esc(g['memory.total [MiB]'] ?? '—')} MiB · ${esc(g['utilization.gpu [%]'] ?? '—')} %${temp != null ? ` · ${esc(temp)} °C` : ''}</div>`;
    }).join('');
    const disks = Object.entries(f?.disks || {}).filter(([path]) => name !== 'UGBrutal' || path.includes('SSD') || path === '/mnt/e').map(([path,d]) => `<div>${esc(path)} · ${bytes(d.availableBytes)} libres</div>`).join('');
    return `<article class="machine ${cls}"><div class="machine-title"><h3>${name}</h3><span>${cls === 'alien' ? '02 CARTE(S)' : '01 CARTE'}</span></div><div class="machine-gpu">${gpuName}</div><div class="machine-memory">${memory}</div><p>${desc}</p><div class="machine-live">${badge(!data.core?.available ? 'Core non relevé' : c?.blocked ? 'Occupation déclarée' : 'Admission à vérifier', c?.blocked ? 'orange' : 'teal')}${live || '<div>Télémétrie GPU indisponible pour ce relevé.</div>'}${disks}<small>GPU / disque : ${stamp(f?.observedAt)}<br>Occupation Core : ${stamp(data.core?.observedAt)}</small></div></article>`;
  }
  function architecturePanel() {
    const a = architectures[regime];
    return `<span class="eyebrow">LES MONTAGES MESURÉS · PAS UN ROUTAGE DE PRODUCTION</span><h2>${a.title}</h2><p>${a.desc}</p><div class="regime-tabs">${[['A','A · une carte'],['B','B · composants répartis'],['C','C · calcul partagé'],['parallel','Deux workers']].map(([key,label]) => `<button data-regime="${key}" aria-pressed="${key === regime}">${label}</button>`).join('')}</div><div class="architecture-flow">${a.nodes.map(([label,title,desc],i) => `${i ? '<span class="flow-arrow">→</span>' : ''}<div class="flow-node"><label>${label}</label><strong>${title}</strong><p>${desc}</p></div>`).join('')}</div><div class="architecture-note">${a.note}</div>`;
  }
  function productionPath() {
    return `<div class="section-title"><div><h2>En production, une demande suit ce chemin.</h2><p>Tout se passe sur UGFrank. Alien et Brutal ne répondent à aucune demande : ils servent aux essais de cet atelier.</p></div>${link('/images','Créer une image dans le produit')}</div>
      <figure class="surface production-path"><div class="pp-scroll"><svg viewBox="0 0 1000 440" role="img" aria-label="En production, trois façons de demander une image mènent à Core sur UGFrank. Core emprunte la carte graphique aux modèles de langage, envoie la recette au gardien qui lance ComfyUI le temps d’une image, conserve l’original dans l’archive, puis sert l’image à celui qui l’a demandée.">
<defs><marker id="pp-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="pp-head" d="M0 0L10 5L0 10z"/></marker><marker id="pp-b" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="pp-head" d="M10 0L0 5L10 10z"/></marker></defs>
<text class="pp-label" x="12" y="24">QUI DEMANDE</text>
<rect class="pp-box" x="12" y="38" width="190" height="64" rx="10"/><text x="26" y="64">Page Atelier du produit</text><text class="pp-sub" x="26" y="84">/images</text>
<rect class="pp-box" x="12" y="116" width="190" height="64" rx="10"/><text x="26" y="142">Nestor</text><text class="pp-sub" x="26" y="162">outil local_image</text>
<rect class="pp-box" x="12" y="194" width="190" height="64" rx="10"/><text x="26" y="220">Conversations Famille</text><text class="pp-sub" x="26" y="240">un dessin rapide par tour</text>
<path class="pp-wire" d="M202 70H224V148M202 226H224V148"/><path class="pp-wire" d="M202 148H262" marker-end="url(#pp-a)"/>
<rect class="pp-box" x="264" y="38" width="300" height="220" rx="10"/>
<text class="pp-title" x="280" y="66">Core</text><text class="pp-sub" x="330" y="65">/api/images · imageService</text>
<rect class="pp-step" x="280" y="100" width="268" height="30" rx="6"/><text x="292" y="120">1 · Préparation</text><text class="pp-sub" x="412" y="120">emprunte la carte</text>
<rect class="pp-step" x="280" y="136" width="268" height="30" rx="6"/><text x="292" y="156">2 · Calcul</text><text class="pp-sub" x="412" y="156">envoie la recette</text>
<rect class="pp-step" x="280" y="172" width="268" height="30" rx="6"/><text x="292" y="192">3 · Archivage</text><text class="pp-sub" x="412" y="192">conserve l’original</text>
<rect class="pp-step" x="280" y="208" width="268" height="30" rx="6"/><text x="292" y="228">4 · Restitution</text><text class="pp-sub" x="412" y="228">rend la carte</text>
<rect class="pp-zone" x="606" y="14" width="382" height="252" rx="12"/><text class="pp-label" x="620" y="36">UGFRANK · PC IMAGE DE PRODUCTION</text>
<rect class="pp-box" x="620" y="50" width="168" height="64" rx="10"/><text x="634" y="76">Gardien worker.py</text><text class="pp-sub" x="634" y="96">toujours à l’écoute</text>
<rect class="pp-box" x="806" y="50" width="168" height="64" rx="10"/><text x="820" y="76">ComfyUI 0.38.0</text><text class="pp-sub" x="820" y="96">le temps d’une image</text>
<path class="pp-wire" d="M564 70H618" marker-end="url(#pp-a)"/><text class="pp-label" x="570" y="62">recette</text>
<path class="pp-wire" d="M618 96H566" marker-end="url(#pp-a)"/><text class="pp-label" x="570" y="116">image</text>
<path class="pp-wire" d="M788 82H804" marker-end="url(#pp-a)"/><path class="pp-wire" d="M890 114V142" marker-end="url(#pp-a)"/>
<rect class="pp-gpu" x="620" y="144" width="354" height="74" rx="10"/><circle class="pp-ink" cx="662" cy="181" r="24"/><circle class="pp-ink" cx="662" cy="181" r="6"/><path class="pp-ink" d="M662 157v18M662 187v18M638 181h18M668 181h18"/>
<text class="pp-title" x="702" y="178">RTX 3080 Ti</text><text class="pp-sub" x="702" y="198">12 Go, une seule carte, partagée</text>
<text class="pp-sub" x="620" y="246">qwen-quality 25 étapes · klein-fast 4 étapes</text>
<rect class="pp-box" x="264" y="318" width="300" height="64" rx="10"/><text x="280" y="344">Modèles de langage de UGFrank</text><text class="pp-sub" x="280" y="364">déchargés, puis rechargés à l’identique</text>
<path class="pp-wire" d="M414 258V316" marker-end="url(#pp-a)" marker-start="url(#pp-b)"/>
<rect class="pp-box" x="700" y="318" width="274" height="64" rx="10"/><text x="716" y="344">Archive, photothèque du NAS</text><text class="pp-sub" x="716" y="364">l’original, sous son empreinte</text>
<path class="pp-wire" d="M564 190H586V292H836V316" marker-end="url(#pp-a)"/>
<path class="pp-wire" d="M836 382V416H106V260" marker-end="url(#pp-a)"/><text class="pp-label" x="330" y="408">l’image revient à celui qui l’a demandée, empreinte revérifiée</text>
</svg></div><figcaption>Une image à la fois, sans file d’attente ni second PC de secours. Relevé du 8 octobre sur le code et la configuration en service ; les montages mesurés plus haut ne sont pas branchés sur ce chemin.</figcaption></figure>`;
  }
  function machines() {
    const p = data.performance, t = p.throughput;
    const medians = ['A','B','C'].map(k => p.regimes[k].warm);
    return `${pageHead('NOTRE HARDWARE, EXPLOITÉ', 'Une image vite. Ou plusieurs ensemble.', 'Alien peut utiliser les deux 3090 pour une seule diffusion, ou lancer deux workers. Brutal a déjà produit la nouvelle texture. Le bon montage dépend de la recette et de l’usage.')}
      <div class="machine-grid">${machineCard('UGFrank','frank','RTX 3080 Ti','12 Go de VRAM','Core, données et archivage ; pilote image historique. Le partage NAS conserve les dossiers.')}${machineCard('UGAlien','alien','2 × RTX 3090','24 Go par carte · 48 Go cumulés, pools séparés','BF16 HQ, édition et comparaisons multi-GPU. Le plafond qualité du parc reste à explorer.')}${machineCard('UGBrutal','brutal','RTX 5070 Ti','16 Go de VRAM · SSD C: / HDD E:','Voie quantifiée et essais torus. Le stockage lent E: reste distinct du SSD de travail.')}</div>
      <section class="architecture" id="architecture-panel">${architecturePanel()}</section>
      ${productionPath()}
      <div class="section-title"><div><h2>Le gain de délai, isolé du gain de débit.</h2><p>Qwen 2.1 BF16 · 2400 × 1792 · 25 étapes · zéro référence · trois briefs.</p></div>${link('/images/labo/lab-resources/docs/performance-report.md','Rapport complet')}</div>
      <div class="speed-layout"><article class="surface"><span class="eyebrow">NOUVELLE IMAGE À CHAUD</span><h3>Temps de génération médian</h3><p>Conditionnement identique entre les montages ; n=6 par bras.</p><div class="bar-chart">${medians.map((v,i) => `<div class="bar-row"><span>${['A · une carte','B · réparti','C · partagé'][i]}</span><div class="bar-track"><div class="bar-fill arm-${i}" style="width:${(v.median / 180 * 100).toFixed(1)}%"></div></div><strong>${fmt(v.median)} s</strong></div>`).join('')}</div><p style="font-size:11px">A et B : PNG identiques. C : résultat différent mais reproductible. Ce gain mesuré ne classe pas les modèles ni toutes les tailles.</p>${link(href('compare','gpu-k04'),'Comparer le K04 partagé')}</article>
      <article class="surface"><span class="eyebrow">DEUX WORKERS · LOT PROLONGÉ</span><h3>${t.images} rendus en ${duration(t.durationSeconds)}</h3><p>Jusqu’au dernier fichier PNG observé.</p><div class="throughput-value">${fmt(t.wholeLot)} <small>images / h pour tout le lot</small></div><p>${fmt(t.steady)} / h sur vagues établies ; ${fmt(t.includingRestore)} / h avec réserve et restitution. Une carte : 23,7 / h dans son lot témoin.</p><div class="boundary"><span>↗</span><p>Un lot de 21 minutes ne prouve pas un débit de nuit durable. Le débit d’images conformes au brief reste à qualifier : au moins 6 défauts stricts sur les 20 images prolongées examinées.</p></div></article></div>
      <details class="provenance"><summary>Processus neuf, modèle chaud et texte déjà encodé</summary><div class="table-wrap"><table class="timing-table"><thead><tr><th>Montage</th><th>Processus neuf</th><th>Nouveau texte à chaud</th><th>Texte déjà encodé</th></tr></thead><tbody>${['A','B','C'].map(k => `<tr><td>${k} · ${['une carte','composants répartis','calcul partagé'][['A','B','C'].indexOf(k)]}</td>${['cold_process','warm','warm_cached_conditioning'].map(r => {const v=p.regimes[k][r];return `<td>${fmt(v.median)} s<small>n=${v.n ?? '—'} · ${fmt(v.min)}–${fmt(v.max)} s</small></td>`;}).join('')}</tr>`).join('')}</tbody></table></div><p style="margin-top:12px">« Processus neuf » ne signifie pas disque froid : les fichiers pouvaient être dans les caches du système. Les temps d’archivage, de restitution et de préparation sont séparés dans le CSV.</p></details>
      <div class="thermal-note"><span class="eyebrow">THERMIQUE ET PCIe · OBSERVATIONS DU LOT</span><h3>Mesures historiques à 350 W ; réglage courant à 300 W.</h3><p>${p.thermal.map(g => `GPU ${g.index} : pic ${g.maxC} °C ; indicateur SW Thermal actif sur ${g.swThermalSamples}/${g.samples} échantillons, HW Thermal ${g.hwThermalSamples}.`).join(' ')} CPU : pic 95 °C. La carte 1 a aussi compté +667 erreurs PCIe corrigées sur 4 h 17 ; l’identité de la carte sur rallonge et la cause restent à établir.</p><p>Ces indicateurs décrivent le lot historique à 350 W. À 300 W, le lot mesuré atteint 83 °C sans bridage thermique logiciel observé ; le suivi PCIe reste ouvert. La synthèse actuelle compte deux lots interrompus puis récupérés ; aucune causalité PCIe établie.</p></div>
      <details class="provenance"><summary>Du brief au fichier utilisable · planche observée</summary><p>Cette planche décrit le workflow V5 du 6 octobre, avant les nouveaux montages. Elle garde sa portée historique.</p><img src="${data.manualFigure}" alt="Workflow HQ V5 observé" loading="lazy">${link('/images/labo/manual','Ouvrir le manuel')}</details>`;
  }
  function roadmap() {
    return `${pageHead('CE QUI RESTE À DÉMONTRER', 'La prochaine marche est concrète.', 'Les témoins, les réceptions et les intégrations ont leur place. Les essais préparés restent distincts des gains réellement mesurés.')}
      <div class="status-ribbon" style="margin-bottom:25px"><p><strong>Avant tout lot GPU</strong> · ${esc(coreSummary())}<br><small>Les travaux des autres sessions gardent leurs réservations.</small></p>${link(href('machines'),'État du parc')}</div>
      <div class="roadmap-grid">${[['acquis','01 · Acquis','Les preuves que l’on peut déjà ouvrir.'],['prochain','02 · Prochaines validations','Des essais ciblés, puis une réception.'],['exploration','03 · Capacités & intégration','Le plafond reste à construire.']].map(([lane,title,desc]) => `<section class="lane" data-lane="${lane}"><div class="lane-title"><h2>${title}</h2><p>${desc}</p></div>${data.roadmap.filter(r => r.lane === lane).map(r => `<article class="roadmap-card"><div class="roadmap-owner">${esc(r.owner)}</div>${badge(r.state,lane === 'acquis' ? 'green' : lane === 'prochain' ? 'purple' : 'orange')}<h3>${esc(r.title)}</h3><p>${esc(r.detail)}</p><div class="next-step"><strong>Validation suivante</strong><p>${esc(r.next)}</p></div>${link(r.href || href(r.view || 'roadmap',r.group),'Ouvrir')}</article>`).join('')}</section>`).join('')}</div>
      <div class="boundary"><span>✦</span><p>La demande simple Nestor/Famille est livrée dans son parcours existant. Ce cockpit suit la qualification dans l’atelier. La file HQ nocturne, la résidence et le routage permanent gardent leurs propres décisions.</p></div>`;
  }
  function fileCards() {
    const found = data.resources.filter(f => (fileCategory === 'all' || f.category === fileCategory) && `${f.title} ${f.detail} ${f.format}`.toLocaleLowerCase('fr').includes(fileSearch.toLocaleLowerCase('fr')));
    return found.length ? found.map(f => `<article class="file-card"><div class="file-top"><span class="format">${esc(f.format)}</span><span class="file-size">${bytes(f.bytes)}</span></div><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p>${link(f.href,f.format === 'ZIP' ? 'Télécharger le dossier' : 'Ouvrir le fichier')}</article>`).join('') : '<p class="files-empty">Aucun fichier pour ce filtre. Essaie un autre mot ou « Tout ».</p>';
  }
  function files() {
    return `${pageHead('ORIGINAUX, EXPORTS ET RECETTES', 'Retrouver les bons fichiers.', 'Les dossiers reproductibles gardent brief, modèle, versions, graphe, graine, référence et reçus. Les assets reçus sont séparés des propositions.')}
      <div class="archive-box"><div><h3>Le partage de l’atelier</h3><p>Les essais ont leur arborescence. Le dossier « generated » ne rassemble pas toute la campagne.</p><code>${esc(data.share)}</code><p style="font-size:10px;margin-top:9px">Performance : sous-dossier 2026-10-07-appui-performance, manifeste complet SHA256SUMS ; la campagne a depuis été complétée. Certains originaux restent aussi dans MAX-HQ sur devX ; les liens ci-dessous donnent les chemins publiés de cette sélection.</p></div><button class="button light" id="copy-share">Copier le chemin</button></div>
      <div class="file-controls">${tabs(fileCategories,fileCategory,'file-category')}<label class="file-search"><span class="sr-only">Chercher un fichier</span><input id="file-search" type="search" value="${esc(fileSearch)}" placeholder="Chercher un logo, un rapport…" aria-label="Chercher un fichier"></label></div><div class="files-grid" id="file-cards">${fileCards()}</div>
      <div class="section-title"><div><h2>L’historique et les contrôles détaillés.</h2><p>Les anciennes étapes restent consultables à côté du cockpit.</p></div></div><div class="group-top-actions">${link(data.assetsReview,'Audit visuel des assets','button secondary')}${link('/images/labo/gallery','Galerie historique','button secondary')}${link('/images/labo/campaign/archive','Journal complet','button secondary')}${link('/images/labo/system','Ancien moniteur','button secondary')}${link('/images/labo/manual','Manuel','button secondary')}</div>`;
  }

  function render() {
    if (!data) return;
    $('#current-title').textContent = titles[current];
    document.title = `AgentX · ${titles[current]}`;
    $$('[data-view]').forEach(a => a.getAttribute('data-view') === current ? a.setAttribute('aria-current','page') : a.removeAttribute('aria-current'));
    $('#view').innerHTML = ({overview,compare,machines,roadmap,files,recipes:()=>window.ImageWorkshopLedger.renderRecipes(data),plan:()=>window.ImageWorkshopLedger.renderPlan(data)})[current]();
    bindView();
    window.ImageWorkshopLedger.bind(data,current);
  }
  function route() {
    const [name, query = ''] = location.hash.slice(1).split('?');
    if (name && !titles[name] && name !== 'content') { location.replace('/images/labo/campaign/archive#' + encodeURIComponent(name)); return; }
    if (name === 'content') { $('#content').focus(); return; }
    current = titles[name] ? name : 'overview';
    const requested = new URLSearchParams(query).get('group');
    if (requested && data?.groups.some(g => g.id === requested) && requested !== groupId) {
      groupId = requested; pair = [];
      if (category !== 'all' && group().category !== category) category = group().category;
    }
    render();
    window.scrollTo({top:0,behavior:'instant'});
  }
  function bindView() {
    $$('[data-category]').forEach(b => b.onclick = () => {
      category = b.dataset.category;
      if (category !== 'all' && group().category !== category) { groupId = data.groups.find(g => g.category === category).id; pair=[]; }
      history.replaceState(null,'',href('compare',groupId)); render();
    });
    if ($('#group-select')) $('#group-select').onchange = e => { groupId=e.target.value;pair=[];history.replaceState(null,'',href('compare',groupId));render(); };
    $$('[data-pair]').forEach(b => b.onchange = () => {
      const i = Number(b.dataset.pair);
      if (b.checked) { if (pair.length >= 2) pair.shift(); pair.push(i); } else pair=pair.filter(v => v !== i);
      $$('[data-pair]').forEach(c => { c.checked=pair.includes(Number(c.dataset.pair));c.closest('.image-card').classList.toggle('selected',c.checked); });
      $('#compare-pair').disabled=pair.length !== 2;
    });
    $$('[data-open]').forEach(b => b.onclick = () => {
      const i=Number(b.dataset.open), indexes=pair.includes(i) && pair.length === 2 ? pair : [i, pair.find(j=>j!==i) ?? (i===0 ? 1 : 0)];
      openViewer(indexes.map(j=>group().items[j]));
    });
    if ($('#compare-pair')) $('#compare-pair').onclick=()=>openViewer([...pair].sort((a,b)=>a-b).map(i=>group().items[i]));
    $$('[data-regime]').forEach(b => b.onclick=()=>{regime=b.dataset.regime;$('#architecture-panel').innerHTML=architecturePanel();bindView();});
    $$('[data-file-category]').forEach(b => b.onclick=()=>{fileCategory=b.dataset.fileCategory;render();});
    if ($('#file-search')) $('#file-search').oninput=e=>{fileSearch=e.target.value;$('#file-cards').innerHTML=fileCards();};
    if ($('#copy-share')) $('#copy-share').onclick=()=>copyText(data.share);
  }
  function toast(message) { clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3500); }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else { const field=document.createElement('textarea');field.value=text;field.style.position='fixed';field.style.left='-9999px';document.body.append(field);field.select();const ok=document.execCommand('copy');field.remove();if(!ok) throw new Error('copy'); }
      toast('Chemin du partage copié.');
    } catch { toast('Copie indisponible : sélectionne le chemin affiché.'); }
  }

  function openViewer(items) {
    modalPair=items;viewerMode='side';priorFocus=document.activeElement;
    $('#viewer-title').textContent=group().title;
    const equal=items[0].width===items[1].width && items[0].height===items[1].height;
    $('#mode-wipe').disabled=!equal;
    $('#mode-wipe').title=equal ? 'Comparer les pixels au même emplacement' : 'Dimensions différentes : superposition désactivée pour conserver les dimensions originales.';
    $('#viewer-background').value='paper';$('#wipe').value=50;
    $('#viewer').showModal();document.body.style.overflow='hidden';
    const width=Math.max(100,($('#viewer').clientWidth-70)/2);
    zoom=Math.min(100,Math.floor(width/Math.max(...items.map(i=>i.width))*100));
    zoom=Math.max(10,zoom);drawViewer();
  }
  function drawViewer() {
    const equal=modalPair[0].width===modalPair[1].width && modalPair[0].height===modalPair[1].height;
    $('#mode-side').setAttribute('aria-pressed',String(viewerMode==='side'));
    $('#mode-wipe').setAttribute('aria-pressed',String(viewerMode==='wipe'));
    $('#wipe-controls').hidden=viewerMode!=='wipe';
    $('#viewer-panels').classList.toggle('wipe-mode',viewerMode==='wipe');
    const label=p=>`<div class="viewer-label"><span>${esc(p.title)} · ${dims(p)} px</span>${link(p.original,'Original')}</div>`;
    if (viewerMode==='side') $('#viewer-panels').innerHTML=modalPair.map(p=>`<section class="viewer-panel">${label(p)}<div class="zoom-pane"><img src="${p.original}" alt="${esc(p.title)}"></div></section>`).join('');
    else $('#viewer-panels').innerHTML=`<section class="viewer-panel">${label(modalPair[0])}${label(modalPair[1])}<div class="zoom-pane"><div class="wipe-stage"><img src="${modalPair[0].original}" alt="${esc(modalPair[0].title)}"><div class="wipe-overlay"><img src="${modalPair[1].original}" alt="${esc(modalPair[1].title)}"></div><div class="wipe-divider"></div></div></div></section>`;
    $('#viewer-note').textContent=equal ? 'Les originaux sont chargés. « 100 % natif » affiche un pixel d’image par pixel CSS à un zoom de navigateur de 100 %. Pour chercher le détail : zoome puis déplace les vues.' : 'Dimensions originales différentes. Défilement relatif synchronisé, superposition désactivée ; aucun redimensionnement caché pour faire correspondre les compositions.';
    $$('.zoom-pane').forEach(p => p.addEventListener('scroll',()=>{
      if(scrollGuard||viewerMode!=='side')return;scrollGuard=true;
      $$('.zoom-pane').filter(q=>q!==p).forEach(q=>{q.scrollLeft=(p.scrollLeft/Math.max(1,p.scrollWidth-p.clientWidth))*(q.scrollWidth-q.clientWidth);q.scrollTop=(p.scrollTop/Math.max(1,p.scrollHeight-p.clientHeight))*(q.scrollHeight-q.clientHeight);});
      requestAnimationFrame(()=>scrollGuard=false);
    }));
    $$('.zoom-pane img').forEach(img=>img.onerror=()=>toast('Un original est indisponible. Le lien de fichier reste consultable.'));
    setZoom(zoom);setBackground();setWipe();
  }
  function setZoom(value) {
    zoom=Number(value);$('#zoom').value=zoom;$('#zoom-label').textContent=`${zoom} %`;
    if(viewerMode==='side') $$('.zoom-pane>img').forEach((img,i)=>{img.style.width=`${modalPair[i].width*zoom/100}px`;});
    else $('.wipe-stage').style.width=`${modalPair[0].width*zoom/100}px`;
  }
  function setBackground() {$$('.zoom-pane').forEach(p=>p.dataset.background=$('#viewer-background').value);}
  function setWipe() { const value=$('#wipe').value;$('#wipe-label').textContent=`${value} %`;if($('.wipe-overlay')){$('.wipe-overlay').style.clipPath=`inset(0 ${100-value}% 0 0)`;$('.wipe-divider').style.left=`${value}%`;} }
  $('#viewer-close').onclick=()=>$('#viewer').close();
  $('#viewer').addEventListener('close',()=>{document.body.style.overflow='';priorFocus?.focus();});
  $('#mode-side').onclick=()=>{viewerMode='side';drawViewer();};
  $('#mode-wipe').onclick=()=>{if(!$('#mode-wipe').disabled){viewerMode='wipe';drawViewer();}};
  $('#zoom').oninput=e=>setZoom(e.target.value);$('#zoom-native').onclick=()=>setZoom(100);
  $('#zoom-fit').onclick=()=>{const width=$('.zoom-pane').clientWidth;setZoom(Math.max(10,Math.min(100,Math.floor(width/Math.max(...modalPair.map(p=>p.width))*100))));};
  $('#viewer-background').onchange=setBackground;$('#wipe').oninput=setWipe;

  async function refresh(initial=false) {
    if(loading)return;loading=true;$('#refresh').disabled=true;
    try {
      const response=await fetch('/images/labo/api/lab',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('api');
      let next=await response.json();if(!next.groups?.length)throw new Error('catalogue');
      let ledger;
      try {
        const r=await fetch('/images/labo/lab-resources/ready/ledger.json',{cache:'no-store',signal:AbortSignal.timeout(8000)});
        if(!r.ok)throw new Error('ledger');ledger=await r.json();
      } catch { ledger=data?.ready; }
      next=window.ImageWorkshopLedger.apply(next,ledger);
      const changed=next.revision!==data?.revision;data=next;
      $('#updated').textContent=`Relevé ${stamp(data.servedAt)}`;
      $('#connection-note').hidden=true;
      if(initial)route();
      else if(!$('#viewer').open && !(current==='recipes' && $('#content').contains(document.activeElement)) && (changed || (['overview','machines','roadmap'].includes(current) && !$('#content').contains(document.activeElement))))render();
    } catch {
      $('#connection-note').textContent=data ? 'Actualisation indisponible. Les derniers dossiers chargés restent affichés ; leur date fait foi.' : 'Le relevé ne répond pas. Réessaie avec ↻ ; le journal historique reste accessible.';
      $('#connection-note').hidden=false;
      if(!data)$('#view').innerHTML=`<div class="loading"><h1>Le relevé attend sa connexion.</h1><p>Les dossiers restent accessibles.</p>${link('/images/labo/campaign/archive','Ouvrir le journal','button')}</div>`;
    } finally {loading=false;$('#refresh').disabled=false;}
  }
  $('#refresh').onclick=()=>refresh(!data);
  window.addEventListener('hashchange',route);
  setInterval(()=>{if(!document.hidden)refresh(!data);},20000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(!data);});
  refresh(true);
})();
