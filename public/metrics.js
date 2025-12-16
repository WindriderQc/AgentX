/**
 * AgentX Metrics Dashboard JavaScript
 * Fetches and displays real-time performance metrics
 */

let autoRefreshInterval = null;
let isRefreshing = false;

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
      return false;
    }
    return true;
  } catch (error) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
}

// Initialize dashboard
document.addEventListener('DOMContentLoaded', async () => {
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) return; // Will redirect to login
  
  loadMetrics();
  setupEventListeners();
});

function setupEventListeners() {
  document.getElementById('refreshBtn').addEventListener('click', loadMetrics);
  document.getElementById('clearCacheBtn').addEventListener('click', clearCache);
  document.getElementById('autoRefreshBtn').addEventListener('click', toggleAutoRefresh);
}

async function loadMetrics() {
  if (isRefreshing) return;
  
  isRefreshing = true;
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  refreshBtn.classList.add('refreshing');
  
  try {
    showLoading();
    hideError();
    
    // Fetch all metrics in parallel
    const [cache, database, connection, system] = await Promise.all([
      fetchMetric('/api/metrics/cache'),
      fetchMetric('/api/metrics/database'),
      fetchMetric('/api/metrics/connection'),
      fetchMetric('/api/metrics/system')
    ]);
    
    console.log('Metrics received:', { cache, database, connection, system });
    
    renderDashboard({ cache, database, connection, system });
    updateTimestamp();
    
  } catch (error) {
    console.error('Metrics error:', error);
    showError(`Failed to load metrics: ${error.message}`);
  } finally {
    isRefreshing = false;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('refreshing');
  }
}

async function fetchMetric(endpoint) {
  const response = await fetch(endpoint, {
    credentials: 'include'
  });
  
  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
      throw new Error('Authentication required');
    }
    throw new Error(`HTTP ${response.status}`);
  }
  
  const data = await response.json();
  console.log(`${endpoint} response:`, data);
  
  // Check if API returned an error
  if (data.status === 'error') {
    throw new Error(data.message || 'API error');
  }
  
  return data;
}

function renderDashboard(metrics) {
  console.log('Rendering dashboard with metrics:', metrics);
  
  const dashboard = document.getElementById('dashboard');
  dashboard.style.display = 'block';
  document.getElementById('loading').style.display = 'none';
  
  try {
    dashboard.innerHTML = `
      <!-- Cache Metrics -->
      <div class="metrics-grid">
        ${renderCacheCard(metrics.cache)}
        ${renderDatabaseCard(metrics.database)}
        ${renderConnectionCard(metrics.connection)}
        ${renderSystemCard(metrics.system)}
      </div>
      
      <!-- Detailed Stats -->
      <div class="chart-section">
        <h2 class="chart-title">📊 Detailed Statistics</h2>
        ${renderDetailedStats(metrics)}
      </div>
    `;
  } catch (error) {
    console.error('Render error:', error, 'Metrics:', metrics);
    throw error;
  }
}

function renderCacheCard(response) {
  const cache = response.data?.cache || response.cache || response;
  const hits = cache?.hits || 0;
  const misses = cache?.misses || 0;
  const size = cache?.size || 0;
  const maxSize = cache?.maxSize || 1;
  
  const hitRate = hits + misses > 0
    ? ((hits / (hits + misses)) * 100).toFixed(1)
    : 0;
    
  const status = hitRate >= 70 ? 'healthy' : hitRate >= 50 ? 'warning' : 'error';
  
  return `
    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-icon">💾</span>
        <span class="metric-title">Cache Performance</span>
      </div>
      <div class="metric-value">${hitRate}%</div>
      <div class="metric-label">Hit Rate</div>
      <span class="status ${status}">${status}</span>
      
      <div class="metric-detail">
        <div class="detail-row">
          <span class="detail-label">Hits</span>
          <span class="detail-value">${hits.toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Misses</span>
          <span class="detail-value">${misses.toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Size</span>
          <span class="detail-value">${size}/${maxSize}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Memory</span>
          <span class="detail-value">${formatBytes(cache?.memorySizeBytes || 0)}</span>
        </div>
      </div>
      
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${(size / maxSize) * 100}%"></div>
      </div>
    </div>
  `;
}

function renderDatabaseCard(response) {
  const db = response?.data || response || {}; // Handle both wrapped and unwrapped responses
  const conversations = db.collections?.conversations || 0;
  const promptConfigs = db.collections?.promptConfigs || 0;
  const userProfiles = db.collections?.userProfiles || 0;
  const total = conversations + promptConfigs + userProfiles;
  
  return `
    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-icon">🗄️</span>
        <span class="metric-title">Database</span>
      </div>
      <div class="metric-value">${total.toLocaleString()}</div>
      <div class="metric-label">Total Documents</div>
      <span class="status healthy">Connected</span>
      
      <div class="metric-detail">
        <div class="detail-row">
          <span class="detail-label">Conversations</span>
          <span class="detail-value">${conversations.toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Prompts</span>
          <span class="detail-value">${promptConfigs.toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Users</span>
          <span class="detail-value">${userProfiles.toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Indexes</span>
          <span class="detail-value">${db.indexCount}</span>
        </div>
      </div>
    </div>
  `;
}

function renderConnectionCard(response) {
  const conn = response?.data || response || {};
  const activeConnections = conn.activeConnections || 0;
  const maxPoolSize = conn.maxPoolSize || 1;
  const availableConnections = conn.availableConnections || 0;
  const waitingConnections = conn.waitingConnections || 0;
  const minPoolSize = conn.minPoolSize || 0;
  
  const usagePercent = (activeConnections / maxPoolSize) * 100;
  const status = usagePercent < 70 ? 'healthy' : usagePercent < 90 ? 'warning' : 'error';
  
  return `
    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-icon">🔌</span>
        <span class="metric-title">Connections</span>
      </div>
      <div class="metric-value">${activeConnections}</div>
      <div class="metric-label">Active / ${maxPoolSize} Max</div>
      <span class="status ${status}">${usagePercent.toFixed(0)}% Used</span>
      
      <div class="metric-detail">
        <div class="detail-row">
          <span class="detail-label">Available</span>
          <span class="detail-value">${availableConnections}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Waiting</span>
          <span class="detail-value">${waitingConnections}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Pool Size</span>
          <span class="detail-value">${minPoolSize}-${maxPoolSize}</span>
        </div>
      </div>
      
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${usagePercent}%"></div>
      </div>
    </div>
  `;
}

function renderSystemCard(response) {
  const sys = response?.data || response || {};
  
  const usedMB = sys.memory?.usedMB || 0;
  const totalMB = sys.memory?.totalMB || 1;
  const nodeVersion = sys.nodeVersion || 'Unknown';
  const platform = sys.platform || 'Unknown';
  const uptimeSeconds = sys.uptimeSeconds || 0;
  
  const memUsagePercent = (usedMB / totalMB) * 100;
  const status = memUsagePercent < 70 ? 'healthy' : memUsagePercent < 85 ? 'warning' : 'error';
  
  return `
    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-icon">💻</span>
        <span class="metric-title">System</span>
      </div>
      <div class="metric-value">${usedMB}MB</div>
      <div class="metric-label">Memory Used / ${totalMB}MB Total</div>
      <span class="status ${status}">${memUsagePercent.toFixed(0)}% Used</span>
      
      <div class="metric-detail">
        <div class="detail-row">
          <span class="detail-label">Node Version</span>
          <span class="detail-value">${nodeVersion}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Uptime</span>
          <span class="detail-value">${formatUptime(uptimeSeconds)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Platform</span>
          <span class="detail-value">${platform}</span>
        </div>
      </div>
      
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${memUsagePercent}%"></div>
      </div>
    </div>
  `;
}

function renderDetailedStats(metrics) {
  // Unwrap all metrics
  const cache = metrics.cache?.data?.cache || metrics.cache?.cache || metrics.cache || {};
  const database = metrics.database?.data || metrics.database || {};
  const system = metrics.system?.data || metrics.system || {};
  
  const cacheHits = cache.hits || 0;
  const cacheMisses = cache.misses || 0;
  const cacheAvgSize = cache.avgEntrySizeBytes || 0;
  const cacheEvictions = cache.evictions || 0;
  
  const dbName = database.dbName || 'Unknown';
  const dbHost = database.host || 'Unknown';
  const dbCollections = database.collections || {};
  
  const heapUsed = system.memory?.heapUsedBytes || 0;
  
  return `
    <div class="metrics-grid">
      <div>
        <h3 style="margin-bottom: 15px; color: #2d3748;">🎯 Cache Statistics</h3>
        <div class="detail-row">
          <span class="detail-label">Total Requests</span>
          <span class="detail-value">${(cacheHits + cacheMisses).toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Average Size</span>
          <span class="detail-value">${formatBytes(cacheAvgSize)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Evictions</span>
          <span class="detail-value">${cacheEvictions}</span>
        </div>
      </div>
      
      <div>
        <h3 style="margin-bottom: 15px; color: #2d3748;">🗄️ Database Info</h3>
        <div class="detail-row">
          <span class="detail-label">Database Name</span>
          <span class="detail-value">${dbName}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Host</span>
          <span class="detail-value">${dbHost}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Collections</span>
          <span class="detail-value">${Object.keys(dbCollections).length}</span>
        </div>
      </div>
      
      <div>
        <h3 style="margin-bottom: 15px; color: #2d3748;">💻 System Resources</h3>
        <div class="detail-row">
          <span class="detail-label">Heap Used</span>
          <span class="detail-value">${formatBytes(heapUsed)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Heap Total</span>
          <span class="detail-value">${formatBytes(system.memory?.heapTotalBytes || 0)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">RSS</span>
          <span class="detail-value">${formatBytes(system.memory?.rssBytes || 0)}</span>
        </div>
      </div>
    </div>
  `;
}

async function clearCache() {
  if (!confirm('Clear embedding cache? This will reset all cache statistics.')) {
    return;
  }
  
  const btn = document.getElementById('clearCacheBtn');
  btn.disabled = true;
  
  try {
    const response = await fetch('/api/metrics/cache/clear', {
      method: 'POST',
      credentials: 'include'
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const result = await response.json();
    alert(`Cache cleared successfully!\n${result.message}`);
    loadMetrics();
    
  } catch (error) {
    showError(`Failed to clear cache: ${error.message}`);
  } finally {
    btn.disabled = false;
  }
}

function toggleAutoRefresh() {
  const btn = document.getElementById('autoRefreshBtn');
  
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
    btn.textContent = '⏱️ Auto (30s)';
    btn.style.background = '#667eea';
  } else {
    autoRefreshInterval = setInterval(loadMetrics, 30000);
    btn.textContent = '⏸️ Stop Auto';
    btn.style.background = '#48bb78';
    loadMetrics();
  }
}

function showLoading() {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('dashboard').style.display = 'none';
}

function showError(message) {
  const container = document.getElementById('errorContainer');
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.textContent = `⚠️ ${message}`;
  container.innerHTML = '';
  container.appendChild(errorDiv);
}

function hideError() {
  document.getElementById('errorContainer').innerHTML = '';
}

function updateTimestamp() {
  const now = new Date().toLocaleString();
  document.getElementById('timestamp').textContent = `Last updated: ${now}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
