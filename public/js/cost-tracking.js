/**
 * Cost Tracking Dashboard Logic
 * Handles data fetching and chart rendering
 */

// State
let currentPeriod = '7d';
let charts = {
  daily: null,
  model: null
};

// Config from CSS variables
const style = getComputedStyle(document.body);
const colors = {
  accent: style.getPropertyValue('--accent').trim() || '#7cf0ff',
  accent2: style.getPropertyValue('--accent-2').trim() || '#eeb0ff',
  bg: style.getPropertyValue('--bg').trim() || '#0f172a',
  text: style.getPropertyValue('--text-primary').trim() || '#f8fafc',
  grid: 'rgba(255, 255, 255, 0.1)'
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadDashboardData();
});

function setupEventListeners() {
  const buttons = document.querySelectorAll('.period-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Update UI
      buttons.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      // Update State
      currentPeriod = e.target.dataset.period;
      loadDashboardData();
    });
  });
}

function getHeaders() {
  const headers = {};
  // If we had workspace management in global scope, we'd add it here
  // headers['x-workspace-id'] = window.currentWorkspaceId;
  return headers;
}

async function loadDashboardData() {
  try {
    // Show loading state if needed
    
    // Parallel fetch
    await Promise.all([
      loadSummary(),
      loadDailyUsage(),
      loadModelUsage(),
      loadTopConversations()
    ]);

  } catch (err) {
    console.error('Failed to load dashboard:', err);
    // showToast('Failed to refresh data', 'error');
  }
}

async function loadSummary() {
  const res = await fetch(`/api/analytics/usage/summary?period=${currentPeriod}`, {
    headers: getHeaders()
  });
  const { data } = await res.json();

  updateElement('totalConversations', data.totalConversations.toLocaleString());
  updateElement('totalTokens', formatCompact(data.totalTokens));
  updateElement('totalCost', formatCurrency(data.totalCost));
  
  const avgCost = data.totalConversations > 0 
    ? data.totalCost / data.totalConversations 
    : 0;
  updateElement('avgCost', formatCurrency(avgCost));
}

async function loadDailyUsage() {
  // Always get last 30 days for daily view, or match period if less
  let days = 30;
  if (currentPeriod === '7d') days = 7;
  if (currentPeriod === '90d') days = 90;
  // 'all' defaults to 30 for daily chart readability unless we aggregate more (out of scope)

  const res = await fetch(`/api/analytics/usage/daily?days=${days}`, {
    headers: getHeaders()
  });
  const { data } = await res.json();

  const labels = data.map(d => d.date);
  const tokenData = data.map(d => d.tokens);
  const costData = data.map(d => d.cost);

  const ctx = document.getElementById('dailyUsageChart').getContext('2d');

  if (charts.daily) charts.daily.destroy();

  charts.daily = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Tokens',
          data: tokenData,
          borderColor: colors.accent,
          backgroundColor: hexToRgba(colors.accent, 0.1),
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          yAxisID: 'y'
        },
        {
          label: 'Cost ($)',
          data: costData,
          borderColor: colors.accent2,
          borderWidth: 2,
          borderDash: [5, 5],
          tension: 0.4,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: colors.text } }
      },
      scales: {
        x: { 
          grid: { color: colors.grid },
          ticks: { color: colors.text }
        },
        y: { 
          position: 'left',
          grid: { color: colors.grid },
          ticks: { color: colors.text },
          title: { display: true, text: 'Tokens', color: colors.text }
        },
        y1: { 
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: colors.text },
          title: { display: true, text: 'Cost ($)', color: colors.text }
        }
      }
    }
  });
}

async function loadModelUsage() {
  const res = await fetch(`/api/analytics/usage/by-model?period=${currentPeriod}`, {
    headers: getHeaders()
  });
  const { data } = await res.json();

  const labels = data.map(d => d.model || 'Unknown');
  const costs = data.map(d => d.cost);

  const ctx = document.getElementById('modelUsageChart').getContext('2d');

  if (charts.model) charts.model.destroy();

  const backgroundColors = [
    'rgba(124, 240, 255, 0.8)', // accent
    'rgba(238, 176, 255, 0.8)', // accent-2
    'rgba(255, 176, 124, 0.8)',
    'rgba(176, 255, 124, 0.8)',
    'rgba(124, 124, 255, 0.8)'
  ];

  charts.model = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: costs,
        backgroundColor: backgroundColors,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { 
          position: 'right',
          labels: { color: colors.text }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const val = ctx.raw;
              const pct = (val / costs.reduce((a,b)=>a+b, 0) * 100).toFixed(1);
              return `${ctx.label}: ${formatCurrency(val)} (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

async function loadTopConversations() {
  const res = await fetch(`/api/analytics/usage/top-conversations?limit=10`, {
    headers: getHeaders()
  });
  const { data } = await res.json();

  const tbody = document.getElementById('topConversationsBody');
  tbody.innerHTML = '';

  data.forEach(conv => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="/?id=${conv._id}" style="color: var(--text-primary); text-decoration: none; font-weight: 500;">
        ${escapeHtml(conv.title || 'Untitled')}
      </a></td>
      <td><span class="model-badge">${escapeHtml(conv.model || 'unknown')}</span></td>
      <td>${(conv.usage?.totalTokens || 0).toLocaleString()}</td>
      <td>${formatCurrency(conv.usage?.estimatedCost || 0)}</td>
      <td>${new Date(conv.createdAt).toLocaleDateString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Helpers
function updateElement(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { 
    style: 'currency', 
    currency: 'USD',
    minimumFractionDigits: 4
  }).format(val || 0);
}

function formatCompact(val) {
  return new Intl.NumberFormat('en-US', { 
    notation: 'compact', 
    compactDisplay: 'short' 
  }).format(val || 0);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
