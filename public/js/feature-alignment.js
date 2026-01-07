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
  const tableContainer = document.getElementById('orphan-table-container');
  const legend = document.getElementById('orphan-legend');
  const emptyState = document.getElementById('orphan-empty-state');

  if (!tbody) return;
  tbody.innerHTML = '';

  // Toggle Empty state vs Table
  if (visible.length === 0) {
    if (tableContainer) tableContainer.style.display = 'none';
    if (legend) legend.style.display = 'none';
    if (emptyState) emptyState.style.display = 'block';
  } else {
    if (tableContainer) tableContainer.style.display = 'block';
    if (legend) legend.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';
  }

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
  window.prompt('Source file path (copy to open in editor):', rel || sourceFile || '');
}

function linkToFeature(method, path) {
  const modal = document.getElementById('feature-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;

  const endpointStr = `${method} ${path}`; 
  const snippet = `data-feature="feature-name"`;

  body.innerHTML = `
    <h2 style="margin-top:0;">Link Endpoint to Feature</h2>
    <p>Scanner maps endpoints to features using token matching or explicit markers.</p>
    
    <div style="background:#f0fdf4; padding:1rem; border-left: 4px solid #10b981; margin-bottom:1rem;">
      <strong>Option 1: Add HTML marker</strong><br>
      Add this attribute to any HTML element in your frontend pages:
      <pre style="background:#1f2937; color:#f9fafb; padding:0.5rem; border-radius:4px; margin-top:0.5rem; overflow-x:auto;">${escapeHtml(snippet)}</pre>
    </div>

    <div style="background:#eff6ff; padding:1rem; border-left: 4px solid #3b82f6; margin-bottom:1rem;">
      <strong>Option 2: Update Documentation</strong><br>
      Mention this endpoint path explicitly in any <code>.md</code> file in <code>docs/</code>:
      <pre style="background:#1f2937; color:#f9fafb; padding:0.5rem; border-radius:4px; margin-top:0.5rem; overflow-x:auto;">Endpoint: ${escapeHtml(endpointStr)}</pre>
    </div>
  `;
  
  modal.style.display = 'block';
}

function markEndpointInternal(method, path) {
  const modal = document.getElementById('feature-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;

  const endpointStr = `${method} ${path}`;
  
  body.innerHTML = `
    <h2 style="margin-top:0;">Mark as Internal / API-Only</h2>
    <p>To permanently exclude this endpoint from "Orphan" reports, add it to the exclusion list in source code.</p>
    
    <div class="score-item negative" style="border-left-color: #f59e0b;">
      <p><strong>File:</strong> <code>src/services/featureAlignmentPriority.js</code></p>
      <p>Add to <strong>API_ONLY_ENDPOINTS</strong> array:</p>
      <pre style="background:#1f2937; color:#f9fafb; padding:1rem; border-radius:4px; overflow-x:auto;">'${escapeHtml(endpointStr)}',</pre>
    </div>

    <p style="margin-top:1rem; font-size:0.9rem; color:#666;">
      <em>Note: This dashboard is read-only. You must update the code locally to persist this change.</em>
    </p>
  `;

  modal.style.display = 'block';
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

// --- Features Table & Filters ---

function applyFilters() {
  const category = document.getElementById('filter-category').value;
  const priority = document.getElementById('filter-priority').value;
  const endpointSize = document.getElementById('filter-endpoints').value;
  const searchTerm = (document.getElementById('filter-search').value || '').toLowerCase();

  filteredFeatures = featuresData.filter((f) => {
    // 1. Search
    if (searchTerm && !f.name.toLowerCase().includes(searchTerm)) return false;

    // 2. Category
    if (category !== 'all' && f.priorityCategory !== category) return false;

    // 3. Priority
    if (priority === 'high' && f.priorityScore < 70) return false;
    if (priority === 'medium' && (f.priorityScore < 40 || f.priorityScore > 69)) return false;
    if (priority === 'low' && (f.priorityScore < 0 || f.priorityScore > 39)) return false;

    // 4. Endpoints Size
    const epCount = (f.backend?.endpoints || []).length;
    if (endpointSize === 'small' && epCount > 5) return false;
    if (endpointSize === 'medium' && (epCount <= 5 || epCount > 10)) return false;
    if (endpointSize === 'large' && epCount <= 10) return false;

    return true;
  });

  // Sort
  filteredFeatures.sort((a, b) => {
    const valA = getSortValue(a, currentSort.column);
    const valB = getSortValue(b, currentSort.column);
    
    if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
    if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
    return 0;
  });

  renderFeaturesTable();
}

function getSortValue(feature, column) {
  if (column === 'name') return feature.name;
  if (column === 'score') return feature.priorityScore;
  if (column === 'category') return feature.priorityCategory;
  if (column === 'endpoints') return (feature.backend?.endpoints || []).length;
  if (column === 'hasUI') {
    const fe = feature.frontendIntegration;
    return fe.htmlPages.length + fe.jsFiles.length;
  }
  return 0;
}

function handleSort(event) {
  const th = event.target.closest('th');
  if (!th || !th.dataset.sort) return;
  const col = th.dataset.sort;

  if (currentSort.column === col) {
    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort = { column: col, direction: 'desc' };
  }
  applyFilters();
}

function renderFeaturesTable() {
  const tbody = document.getElementById('features-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  for (const f of filteredFeatures) {
    const tr = document.createElement('tr');
    
    // Name
    const nameTd = document.createElement('td');
    nameTd.innerHTML = `<strong>${escapeHtml(f.name)}</strong>`;
    
    // Score
    const scoreTd = document.createElement('td');
    scoreTd.innerHTML = `
        <span style="font-size:1.1rem; font-weight:bold;">${f.priorityScore}</span>
        <div class="priority-bar">
            <div class="priority-fill ${f.priorityCategory}" style="width: ${Math.max(0, Math.min(100, f.priorityScore))}%"></div>
        </div>
    `;

    // Category
    const catTd = document.createElement('td');
    catTd.innerHTML = `<span class="badge badge-${f.priorityCategory}">${f.priorityCategory.toUpperCase()}</span>`;

    // Endpoints
    const epTd = document.createElement('td');
    epTd.textContent = (f.backend?.endpoints || []).length;

    // Has UI
    const uiTd = document.createElement('td');
    const fe = f.frontendIntegration;
    const count = fe.htmlPages.length + fe.jsFiles.length;
    uiTd.innerHTML = count > 0 ? `<i class="fas fa-check text-success"></i> Yes (${count})` : '<span style="color:#ccc;">-</span>';

    // Actions
    const actTd = document.createElement('td');
    actTd.innerHTML = `<button class="btn btn-sm btn-outline" onclick="openFeatureModal('${escapeHtml(f.name)}')">Details</button>`;

    tr.appendChild(nameTd);
    tr.appendChild(scoreTd);
    tr.appendChild(catTd);
    tr.appendChild(epTd);
    tr.appendChild(uiTd);
    tr.appendChild(actTd);

    tbody.appendChild(tr);
  }
}

// --- Modal & Recommendations ---

function openFeatureModal(featureName) {
  const feature = featuresData.find((f) => f.name === featureName);
  if (!feature) return;

  const modal = document.getElementById('feature-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;

  const b = feature.priorityBreakdown;
  const epCount = (feature.backend?.endpoints || []).length;

  let breakdownHtml = `
    <div class="score-item ${b.endpointCount > 0 ? 'positive' : ''}">
      <strong>Endpoints (${epCount})</strong><br>
      Score: +${b.endpointCount}
    </div>
    <div class="score-item ${b.documentation > 0 ? 'positive' : ''}">
      <strong>Documentation</strong><br>
      Score: +${b.documentation}
    </div>
    <div class="score-item ${b.n8nUsage !== 0 ? (b.n8nUsage > 0 ? 'positive' : 'negative') : ''}">
      <strong>n8n / Webhooks</strong><br>
      Score: ${b.n8nUsage > 0 ? '+' + b.n8nUsage : b.n8nUsage}
    </div>
    <div class="score-item ${b.falsePositive < 0 ? 'negative' : ''}">
      <strong>False Positive</strong><br>
      Penalty: ${b.falsePositive}
    </div>
    <div class="score-item ${b.hasUI < 0 ? 'negative' : ''}">
      <strong>UI Exist (Penalty)</strong><br>
      Penalty: ${b.hasUI}
    </div>
  `;

  let epListHtml = '<ul style="max-height: 200px; overflow-y: auto; background: #f9f9f9; padding: 1rem; border-radius: 4px;">';
  if (feature.backend?.endpoints?.length) {
    feature.backend.endpoints.forEach(ep => {
        epListHtml += `<li><code>${escapeHtml(ep.method)} ${escapeHtml(ep.path)}</code> <span style="color:#888; font-size:0.8em;">(${stripRootPath(ep.sourceFile)})</span></li>`;
    });
  } else {
    epListHtml += '<li>No exact endpoints listed.</li>';
  }
  epListHtml += '</ul>';

  body.innerHTML = `
    <h2 style="border-bottom: 2px solid #eee; padding-bottom: 0.5rem; margin-top:0;">
       <span class="badge badge-${feature.priorityCategory}" style="vertical-align: middle; margin-right: 0.5rem; font-size: 0.5em;">${feature.priorityCategory.toUpperCase()}</span>
       ${escapeHtml(feature.name)}
    </h2>
    
    <div style="display: flex; gap: 2rem; margin-bottom: 1rem;">
       <div>
         <span class="stat-label">Priority Score</span>
         <span style="display: block; font-size: 2rem; font-weight: bold;">${feature.priorityScore}</span>
       </div>
       <div>
         <span class="stat-label">Status</span>
         <span style="display: block; font-size: 1.2rem; margin-top: 0.5rem;">${feature.status || 'unknown'}</span>
       </div>
    </div>

    <h3>Score Breakdown</h3>
    <div class="score-breakdown-grid">
       ${breakdownHtml}
    </div>
    
    <h3>Endpoints</h3>
    ${epListHtml}
    
    <div style="margin-top: 2rem;">
       <h3>Frontend Files</h3>
       ${
         feature.frontendIntegration.files.length > 0
         ? `<ul>${feature.frontendIntegration.files.map(f => `<li>${stripRootPath(f)}</li>`).join('')}</ul>`
         : '<em>No frontend files linked.</em>'
       }
    </div>
  `;

  modal.style.display = 'block';
}

function closeModal() {
  const modal = document.getElementById('feature-modal');
  if (modal) modal.style.display = 'none';
}

function renderRecommendations(features) {
  const container = document.getElementById('recommendations-content');
  if (!container) return;

  // Filter for medium/high priority that are NOT complete and do NOT have UI
  const candidates = features
    .filter(f => f.status !== 'complete' && f.priorityCategory !== 'complete' && f.priorityCategory !== 'api-only')
    .filter(f => f.priorityScore >= 30) // Only meaningful requests
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 3);

  if (candidates.length === 0) {
    container.innerHTML = '<p>No high-priority missing UI recommendations found. Good job!</p>';
    return;
  }

  let html = '<div class="dashboard-grid">';
  candidates.forEach(f => {
    html += `
        <div class="stat-card" style="text-align: left;">
            <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                <span class="badge badge-${f.priorityCategory}">${f.priorityCategory.toUpperCase()}</span>
                <span style="font-weight:bold;">Score: ${f.priorityScore}</span>
            </div>
            <h3 style="margin: 0 0 0.5rem 0;">${escapeHtml(f.name)}</h3>
            <p style="font-size: 0.9rem; color: #555;">
                feature has <strong>${(f.backend?.endpoints || []).length} endpoints</strong> but currently lacks a UI implementation.
            </p>
            <button class="btn btn-primary btn-sm" style="margin-top:0.5rem;" onclick="openFeatureModal('${escapeHtml(f.name)}')">View Details</button>
        </div>
    `;
  });
  html += '</div>';
  
  container.innerHTML = html;
}

// Global click outside modal to close
window.onclick = function(event) {
  const modal = document.getElementById('feature-modal');
  if (event.target === modal) {
    closeModal();
  }
};
