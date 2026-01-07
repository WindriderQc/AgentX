// Feature Alignment Dashboard Logic

let rawReport = null;
let featuresData = [];
let orphanEndpointsData = [];
let filteredFeatures = [];
let currentSort = { column: 'score', direction: 'desc' };
let statusChart = null;

const KNOWN_FALSE_POSITIVE_PATHS = new Set([
  '/api/feedback',
  '/register',
  '/logout',
  '/me',
  '/api/dashboard/health',
  '/api/dashboard/stats',
  '/api/dashboard/scans'
]);

const KNOWN_API_ONLY_PATHS = new Set([
  '/api/models/routing',
  '/api/models/classify',
  '/api/models/health'
]);

document.addEventListener('DOMContentLoaded', () => {
  loadReport();
});

function loadReport() {
  fetch('/reports/feature-alignment.json')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      rawReport = data;
      orphanEndpointsData = classifyOrphanEndpoints(data.orphanEndpoints || []);
      featuresData = (data.features || []).map((feature) => enrichFeature(feature));

      renderOverview(featuresData, orphanEndpointsData, data.summary);
      renderOrphanEndpoints();
      applyFilters();
      renderRecommendations(featuresData);
    })
    .catch((err) => {
      console.error('Error loading feature alignment report:', err);
      const container = document.querySelector('.content-container');
      if (container) {
        container.innerHTML =
          '<div class="stat-card" style="color: #b91c1c;">Error loading /reports/feature-alignment.json. Ensure the public symlink exists.</div>';
      }
    });
}

// --- Helpers ---

function stripRootPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return '';
  const root = rawReport?.summary?.rootDir;
  if (root && absPath.startsWith(root + '/')) return absPath.slice(root.length + 1);
  if (absPath.startsWith('/home/yb/codes/AgentX/')) return absPath.replace('/home/yb/codes/AgentX/', '');
  return absPath;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

// --- Orphan Endpoints ---

function classifyOrphanEndpoints(endpoints) {
  return endpoints.map((ep) => {
    const path = ep?.path || '';
    const isFalsePositive = KNOWN_FALSE_POSITIVE_PATHS.has(path) || path.startsWith('/api/dashboard/');
    const isApiOnly = KNOWN_API_ONLY_PATHS.has(path);
    const category = isFalsePositive ? 'False Positive' : 'API-Only';
    return { ...ep, category, isFalsePositive, isApiOnly };
  });
}

function renderOrphanEndpoints() {
  const hideFalsePositives = !!document.getElementById('orphan-hide-false-positives')?.checked;
  const visible = hideFalsePositives
    ? orphanEndpointsData.filter((ep) => !ep.isFalsePositive)
    : orphanEndpointsData;

  const tbody = document.getElementById('orphan-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  for (const ep of visible) {
    const tr = document.createElement('tr');

    const statusTd = document.createElement('td');
    statusTd.innerHTML = ep.isFalsePositive
      ? '<span class="badge" style="background:#e5e7eb; color:#374151;">✅ In Use</span>'
      : '<span class="badge badge-api-only">🔵 API-Only</span>';

    const methodTd = document.createElement('td');
    methodTd.innerHTML = `<code>${escapeHtml(ep.method)} ${escapeHtml(ep.path)}</code>`;

    const sourceTd = document.createElement('td');
    const srcRel = stripRootPath(ep.sourceFile);
    sourceTd.innerHTML = `<small>${escapeHtml(srcRel || ep.sourceFile || '')}</small>`;

    const categoryTd = document.createElement('td');
    categoryTd.textContent = ep.isFalsePositive ? 'False Positive' : 'API-Only';

    const actionsTd = document.createElement('td');
    const src = escapeHtml(ep.sourceFile || '');
    const method = escapeHtml(ep.method || '');
    const path = escapeHtml(ep.path || '');
    actionsTd.innerHTML = `
      <button class="btn btn-sm btn-secondary" onclick="viewCode('${src}')">View Code</button>
      <button class="btn btn-sm btn-secondary" ${ep.isFalsePositive ? 'disabled' : ''} onclick="linkToFeature('${method}','${path}')">Link to Feature</button>
      <button class="btn btn-sm btn-secondary" ${ep.isFalsePositive ? 'disabled' : ''} onclick="markEndpointInternal('${method}','${path}')">Mark as Internal</button>
    `;

    tr.appendChild(statusTd);
    tr.appendChild(methodTd);
    tr.appendChild(sourceTd);
    tr.appendChild(categoryTd);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

function viewCode(sourceFile) {
  const rel = stripRootPath(sourceFile);
  window.prompt('Source file path:', rel || sourceFile || '');
}

function linkToFeature(method, path) {
  window.alert(`Linking not implemented yet.\nEndpoint: ${method} ${path}`);
}

function markEndpointInternal(method, path) {
  window.alert(`Marked as internal (client-side only).\nEndpoint: ${method} ${path}`);
}

// --- Feature scoring / enrichment ---

function extractFrontendIntegration(feature) {
  const files = feature?.frontend?.files || [];
  const htmlPages = files.filter((p) => String(p).toLowerCase().endsWith('.html'));
  const jsFiles = files.filter((p) => String(p).toLowerCase().endsWith('.js'));
  return { files, htmlPages, jsFiles };
}

function calculatePriorityScore(feature) {
  let score = 0;
  const breakdown = {
    n8nUsage: 0,
    endpointCount: 0,
    documentation: 0,
    security: 0,
    recentActivity: 0,
    falsePositive: 0,
    hasUI: 0
  };

  const endpoints = feature?.backend?.endpoints || [];
  const docs = feature?.docs?.files || [];
  const frontend = extractFrontendIntegration(feature);

  // 1. n8n Workflow Usage (±30)
  const isN8nEndpoint = endpoints.some((e) =>
    String(e?.path || '').includes('/webhook/') || String(e?.path || '').includes('sbqc-')
  );
  if (isN8nEndpoint) {
    breakdown.n8nUsage = -30;
    score -= 30;
  }

  // 2. Endpoint Count (0-20)
  const count = endpoints.length;
  if (count >= 11) breakdown.endpointCount = 20;
  else if (count >= 6) breakdown.endpointCount = 15;
  else if (count >= 3) breakdown.endpointCount = 10;
  else if (count >= 1) breakdown.endpointCount = 5;
  score += breakdown.endpointCount;

  // 3. Documentation (0-20)
  if (docs.some((d) => String(d).includes('specs/') || String(d).includes('/docs/'))) breakdown.documentation += 10;
  if (docs.some((d) => String(d).includes('contract') || String(d).includes('api-'))) breakdown.documentation += 5;
  if (docs.some((d) => String(d).includes('ROADMAP') || String(d).includes('IMPLEMENTATION'))) breakdown.documentation += 5;
  score += breakdown.documentation;

  // 4. Security (0-15) - report lacks evidence; leave 0
  breakdown.security = 0;

  // 5. Recent Activity (0-15) - client-side skip
  breakdown.recentActivity = 0;

  // 6. False Positive Penalty (-15) - follow prompt logic
  if (feature?.status === 'orphan' && (frontend.htmlPages.length + frontend.jsFiles.length) > 0) {
    breakdown.falsePositive = -15;
    score -= 15;
  }

  // 7. UI Detection (-20)
  if ((frontend.htmlPages.length + frontend.jsFiles.length) > 0) {
    breakdown.hasUI = -20;
    score -= 20;
  }

  // Category for UI filtering (Complete/Medium/Low/API-Only)
  let category;
  if (score < 0 || feature?.status === 'complete') category = 'complete';
  else if (score >= 40) category = 'medium';
  else if (score >= 20) category = 'low';
  else category = 'api-only';

  return { score, breakdown, category };
}

function enrichFeature(feature) {
  const scoring = calculatePriorityScore(feature);
  const frontend = extractFrontendIntegration(feature);
  return {
    ...feature,
    name: feature?.key || feature?.id || 'unknown',
    priorityScore: scoring.score,
    priorityBreakdown: scoring.breakdown,
    priorityCategory: scoring.category,
    frontendIntegration: frontend
  };
}

// --- Overview ---

function renderOverview(features, orphans, summary) {
  const totalFeatures = summary?.counts?.features ?? features.length;
  const completeFeatures = summary?.statusCounts?.complete ?? features.filter((f) => f.status === 'complete').length;

  const mediumPriority = features.filter((f) => f.priorityScore >= 40 && f.priorityScore <= 69).length;
  const lowPriority = features.filter((f) => f.priorityScore >= 0 && f.priorityScore <= 39).length;

  setText('stats-total', totalFeatures);
  setText('stats-complete', completeFeatures);
  setText('stats-medium', mediumPriority);
  setText('stats-low', lowPriority);

  setText('stats-coverage-api', summary?.counts?.backendEndpoints ?? 0);

  const htmlPages = new Set();
  const docsFiles = new Set();
  for (const f of features) {
    for (const p of f.frontendIntegration?.htmlPages || []) htmlPages.add(stripRootPath(p));
    for (const d of f.docs?.files || []) docsFiles.add(stripRootPath(d));
  }
  setText('stats-coverage-html', htmlPages.size);
  setText('stats-coverage-docs', docsFiles.size);

  setText('stats-coverage-orphan', orphans.length);
  const falsePositives = orphans.filter((o) => o.isFalsePositive).length;
  const apiOnly = orphans.filter((o) => !o.isFalsePositive).length;
  setText('orphan-breakdown-text', `(${falsePositives} false positives, ${apiOnly} API-only)`);

  renderStatusChart(completeFeatures, mediumPriority, lowPriority);
}

function renderStatusChart(complete, medium, low) {
  const canvas = document.getElementById('statusChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (statusChart) statusChart.destroy();

  statusChart = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: ['Complete', 'Medium', 'Low'],
      datasets: [
        {
          data: [complete, medium, low],
          backgroundColor: ['#10b981', '#f59e0b', '#3b82f6'],
          borderWidth: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' }
      }
    }
  });
}

// --- Feature table filtering/sorting ---

function applyFilters() {
  const category = document.getElementById('filter-category')?.value || 'all';
  const range = document.getElementById('filter-priority')?.value || 'all';
  const endpointBucket = document.getElementById('filter-endpoints')?.value || 'all';
  const search = (document.getElementById('filter-search')?.value || '').toLowerCase().trim();

  filteredFeatures = featuresData.filter((f) => {
    if (category !== 'all' && f.priorityCategory !== category) return false;

    if (range === 'high' && f.priorityScore < 70) return false;
    if (range === 'medium' && (f.priorityScore < 40 || f.priorityScore > 69)) return false;
    if (range === 'low' && (f.priorityScore < 0 || f.priorityScore > 39)) return false;

    const count = f.backend?.endpoints?.length || 0;
    if (endpointBucket === 'small' && (count < 1 || count > 5)) return false;
    if (endpointBucket === 'medium' && (count < 6 || count > 10)) return false;
    if (endpointBucket === 'large' && count < 11) return false;

    if (search && !String(f.name).toLowerCase().includes(search)) return false;

    return true;
  });

  sortAndRenderFeatures();
}

function handleSort(event) {
  const th = event?.target?.closest?.('th');
  const column = th?.dataset?.sort;
  if (!column) return;

  if (currentSort.column === column) {
    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.column = column;
    currentSort.direction = column === 'name' ? 'asc' : 'desc';
  }

  sortAndRenderFeatures();
}

function sortAndRenderFeatures() {
  const dir = currentSort.direction === 'asc' ? 1 : -1;

  filteredFeatures.sort((a, b) => {
    switch (currentSort.column) {
      case 'name':
        return String(a.name).localeCompare(String(b.name)) * dir;
      case 'score':
        return (a.priorityScore - b.priorityScore) * dir;
      case 'category':
        return String(a.priorityCategory).localeCompare(String(b.priorityCategory)) * dir;
      case 'endpoints':
        return ((a.backend?.endpoints?.length || 0) - (b.backend?.endpoints?.length || 0)) * dir;
      case 'hasUI': {
        const aUi = (a.frontendIntegration?.htmlPages?.length || 0) > 0 || (a.frontendIntegration?.jsFiles?.length || 0) > 0;
        const bUi = (b.frontendIntegration?.htmlPages?.length || 0) > 0 || (b.frontendIntegration?.jsFiles?.length || 0) > 0;
        return (Number(aUi) - Number(bUi)) * dir;
      }
      default:
        return (a.priorityScore - b.priorityScore) * dir;
    }
  });

  renderFeaturesTable(filteredFeatures);
}

function renderFeaturesTable(items) {
  const tbody = document.getElementById('features-table-body');
  if (!tbody) return;

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No features match filters</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  for (const f of items) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.innerHTML = `<strong>${escapeHtml(f.name)}</strong>`;

    const scoreTd = document.createElement('td');
    const scoreClass = f.priorityScore >= 70 ? 'high' : f.priorityScore >= 40 ? 'medium' : f.priorityScore >= 0 ? 'low' : 'complete';
    const scoreWidth = Math.min(Math.max(f.priorityScore, 0), 100);
    scoreTd.innerHTML = `
      <div style="display:flex; align-items:center;">
        <span style="width:36px; text-align:right; margin-right:8px; font-weight:700;">${escapeHtml(f.priorityScore)}</span>
        <div class="priority-bar" style="width:90px; height:8px;">
          <div class="priority-fill ${scoreClass}" style="width:${scoreWidth}%;"></div>
        </div>
      </div>
    `;

    const categoryTd = document.createElement('td');
    categoryTd.innerHTML = `<span class="badge ${badgeClassForCategory(f.priorityCategory)}">${escapeHtml(labelForCategory(f.priorityCategory))}</span>`;

    const endpointsTd = document.createElement('td');
    const endpoints = f.backend?.endpoints || [];
    const endpointTooltip = endpoints.map((e) => `${e.method} ${e.path}`).join('\n');
    endpointsTd.innerHTML = `<span title="${escapeHtml(endpointTooltip)}">${endpoints.length}</span>`;

    const uiTd = document.createElement('td');
    const hasUI = (f.frontendIntegration?.htmlPages?.length || 0) > 0 || (f.frontendIntegration?.jsFiles?.length || 0) > 0;
    uiTd.textContent = hasUI ? '✅ Yes' : '❌ No';

    const actionsTd = document.createElement('td');
    const viewBtn = `<button class="btn btn-sm btn-primary" onclick="openFeatureModal('${escapeHtml(f.name)}')">View Details</button>`;
    const planBtn = (f.priorityScore >= 40 && f.priorityScore <= 69)
      ? ` <button class="btn btn-sm btn-secondary" onclick="planUiForFeature('${escapeHtml(f.name)}')">Plan UI</button>`
      : '';
    const markBtn = (f.priorityScore >= 0 && f.priorityScore <= 39)
      ? ` <button class="btn btn-sm btn-secondary" onclick="markFeatureApiOnly('${escapeHtml(f.name)}')">Mark API-Only</button>`
      : '';
    actionsTd.innerHTML = viewBtn + planBtn + markBtn;

    tr.appendChild(nameTd);
    tr.appendChild(scoreTd);
    tr.appendChild(categoryTd);
    tr.appendChild(endpointsTd);
    tr.appendChild(uiTd);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

function badgeClassForCategory(cat) {
  switch (cat) {
    case 'complete':
      return 'badge-complete';
    case 'medium':
      return 'badge-medium';
    case 'low':
      return 'badge-low';
    case 'api-only':
      return 'badge-api-only';
    default:
      return 'badge-api-only';
  }
}

function labelForCategory(cat) {
  if (cat === 'api-only') return 'API-ONLY';
  return String(cat).toUpperCase();
}

function planUiForFeature(name) {
  window.alert(`Start planning UI for: ${name}`);
}

function markFeatureApiOnly(name) {
  const f = featuresData.find((x) => x.name === name);
  if (!f) return;
  f.priorityCategory = 'api-only';
  window.alert(`Marked as API-only (client-side only): ${name}`);
  applyFilters();
  renderRecommendations(featuresData);
}

// --- Modal ---

function openFeatureModal(featureName) {
  const feature = featuresData.find((f) => f.name === featureName);
  if (!feature) return;

  const modal = document.getElementById('feature-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;

  const bd = feature.priorityBreakdown || {};
  const endpoints = feature.backend?.endpoints || [];
  const frontend = feature.frontendIntegration || { htmlPages: [], jsFiles: [] };
  const docs = feature.docs?.files || [];

  const docsLinks = docs.length
    ? docs
        .map((d) => {
          const rel = stripRootPath(d);
          const href = '/' + rel;
          return `<li><a href="${escapeHtml(href)}" target="_blank">${escapeHtml(rel)}</a></li>`;
        })
        .join('')
    : '<li>No documentation detected</li>';

  const htmlList = frontend.htmlPages.length
    ? frontend.htmlPages.map((p) => `<li>HTML: ${escapeHtml(stripRootPath(p))}</li>`).join('')
    : '';
  const jsList = frontend.jsFiles.length
    ? frontend.jsFiles.map((p) => `<li>JS: ${escapeHtml(stripRootPath(p))}</li>`).join('')
    : '';
  const noUi = !frontend.htmlPages.length && !frontend.jsFiles.length ? '<li>No UI detected</li>' : '';

  body.innerHTML = `
    <h2 style="margin-top:0;">${escapeHtml(feature.name)}
      <span class="badge ${badgeClassForCategory(feature.priorityCategory)}" style="vertical-align:middle; font-size:0.75rem;">${escapeHtml(labelForCategory(feature.priorityCategory))}</span>
    </h2>

    <p><strong>Priority Score:</strong> ${escapeHtml(feature.priorityScore)}</p>

    <h3>Score Breakdown</h3>
    <div class="score-breakdown-grid">
      <div class="score-item ${bd.n8nUsage < 0 ? 'negative' : ''}">n8n Workflow Usage: <strong>${escapeHtml(bd.n8nUsage ?? 0)}</strong></div>
      <div class="score-item ${bd.endpointCount > 0 ? 'positive' : ''}">Endpoint Count: <strong>${escapeHtml(bd.endpointCount ?? 0)}</strong></div>
      <div class="score-item ${bd.documentation > 0 ? 'positive' : ''}">Documentation: <strong>${escapeHtml(bd.documentation ?? 0)}</strong></div>
      <div class="score-item">Security: <strong>${escapeHtml(bd.security ?? 0)}</strong></div>
      <div class="score-item">Recent Activity: <strong>${escapeHtml(bd.recentActivity ?? 0)}</strong></div>
      <div class="score-item ${bd.falsePositive < 0 ? 'negative' : ''}">False Positive Penalty: <strong>${escapeHtml(bd.falsePositive ?? 0)}</strong></div>
      <div class="score-item ${bd.hasUI < 0 ? 'negative' : ''}">UI Detection: <strong>${escapeHtml(bd.hasUI ?? 0)}</strong></div>
    </div>

    <h3>Endpoints</h3>
    <ul style="max-height:200px; overflow:auto; background:#f9f9f9; padding:1rem; border-radius:4px;">
      ${endpoints
        .map((e) => {
          const src = stripRootPath(e.sourceFile);
          return `<li><code>${escapeHtml(e.method)} ${escapeHtml(e.path)}</code><br><small style="color:#6b7280;">${escapeHtml(src)}</small></li>`;
        })
        .join('')}
    </ul>

    <h3>Frontend Integration</h3>
    <ul>
      ${noUi}
      ${htmlList}
      ${jsList}
    </ul>

    <h3>Documentation</h3>
    <ul>
      ${docsLinks}
    </ul>

    <h3>Recommendation</h3>
    <div style="margin-top:0.5rem; background:#eff6ff; padding:1rem; border-radius:6px; border:1px solid #bfdbfe;">
      ${escapeHtml(recommendationText(feature))}
    </div>
  `;

  modal.style.display = 'block';
}

function recommendationText(feature) {
  if (feature.priorityCategory === 'complete') return 'Already has UI';
  if (feature.priorityScore >= 40 && feature.priorityScore <= 69) return 'Build UI in current sprint';
  if (feature.priorityCategory === 'api-only') return 'No UI needed - internal/automation API';
  if (feature.priorityScore >= 0 && feature.priorityScore <= 39) return 'Defer UI - low priority';
  if (feature.priorityScore >= 70) return 'High priority - consider UI development';
  return 'Review manually';
}

function closeModal() {
  const modal = document.getElementById('feature-modal');
  if (modal) modal.style.display = 'none';
}

window.addEventListener('click', (event) => {
  const modal = document.getElementById('feature-modal');
  if (modal && event.target === modal) closeModal();
});

// --- Recommendations ---

function renderRecommendations(features) {
  const container = document.getElementById('recommendations-content');
  if (!container) return;

  const medium = features
    .filter((f) => f.priorityScore >= 40 && f.priorityScore <= 69)
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 5);

  if (!medium.length) {
    const completeCount = features.filter((f) => f.status === 'complete').length;
    const apiOnlyCount = features.filter((f) => f.priorityCategory === 'api-only').length;
    container.innerHTML = `
      <p>All features either complete or API-only. No UI development needed at this time.</p>
      <p style="color:#6b7280;"><small>${completeCount} features complete, ${apiOnlyCount} marked API-only</small></p>
    `;
    return;
  }

  container.innerHTML = `
    <ul style="list-style:none; padding:0; margin:0;">
      ${medium
        .map(
          (f) => `
        <li style="background:#fff; margin-bottom:0.5rem; padding:1rem; border-radius:6px; border:1px solid #e5e7eb; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>${escapeHtml(f.name)}</strong>
            <span class="badge badge-medium" style="margin-left:8px;">Score: ${escapeHtml(f.priorityScore)}</span>
            <div style="color:#6b7280; font-size:0.9rem; margin-top:0.25rem;">${(f.backend?.endpoints?.length || 0)} endpoints, documented: ${(f.docs?.files?.length || 0)} files</div>
          </div>
          <button class="btn btn-sm btn-primary" onclick="planUiForFeature('${escapeHtml(f.name)}')">Start Planning</button>
        </li>
      `
        )
        .join('')}
    </ul>
  `;
}
