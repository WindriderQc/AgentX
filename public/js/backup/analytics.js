const elements = {
  periodSelect: document.getElementById('periodSelect'),
  usageGroupSelect: document.getElementById('usageGroupSelect'),
  feedbackGroupSelect: document.getElementById('feedbackGroupSelect'),
  refreshBtn: document.getElementById('refreshBtn'),
  totalConversations: document.getElementById('totalConversations'),
  totalMessages: document.getElementById('totalMessages'),
  positiveFeedback: document.getElementById('positiveFeedback'),
  positiveRate: document.getElementById('positiveRate'),
  ragUsage: document.getElementById('ragUsage'),
  ragConversations: document.getElementById('ragConversations'),
  noRagConversations: document.getElementById('noRagConversations'),
  ragPositiveRate: document.getElementById('ragPositiveRate'),
  noRagPositiveRate: document.getElementById('noRagPositiveRate'),
  ragDelta: document.getElementById('ragDelta'),
  ragDonutLabel: document.getElementById('ragDonutLabel'),
  usageEmpty: document.getElementById('usageEmpty'),
  feedbackEmpty: document.getElementById('feedbackEmpty'),
};

const charts = {
  usage: null,
  feedback: null,
  rag: null,
};

function formatNumber(num) {
  if (num === null || num === undefined) return '–';
  return num.toLocaleString();
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return `${(value * 100).toFixed(1)}%`;
}

function periodRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - Number(days));
  return { from, to };
}

async function fetchJSON(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) {
    // Redirect to login if unauthorized
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

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

function buildRangeQuery(days) {
  const { from, to } = periodRange(days);
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  return params.toString();
}

async function loadUsage(days, groupBy) {
  const query = buildRangeQuery(days);
  const qs = new URLSearchParams(`${query}&groupBy=${groupBy}`);
  const response = await fetchJSON(`/api/analytics/usage?${qs.toString()}`);
  return response.data;
}

async function loadFeedback(days, groupBy) {
  const query = buildRangeQuery(days);
  const qs = new URLSearchParams(`${query}&groupBy=${groupBy}`);
  const response = await fetchJSON(`/api/analytics/feedback?${qs.toString()}`);
  return response.data;
}

async function loadRag(days) {
  const query = buildRangeQuery(days);
  const response = await fetchJSON(`/api/analytics/rag-stats?${query}`);
  return response.data;
}

function renderUsageChart(data, groupBy) {
  const labels = data.breakdown.map((item) => {
    if (groupBy === 'day') return item.date;
    if (groupBy === 'model') return item.model || 'Unknown model';
    return item.promptVersion || 'No version';
  });

  const conversations = data.breakdown.map((item) => item.conversations || 0);
  const messages = data.breakdown.map((item) => item.messages || 0);

  const ctx = document.getElementById('usageChart').getContext('2d');
  if (charts.usage) charts.usage.destroy();

  charts.usage = new Chart(ctx, {
    type: groupBy === 'day' ? 'line' : 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Conversations',
          data: conversations,
          borderColor: '#7cf0ff',
          backgroundColor: 'rgba(124, 240, 255, 0.35)',
          tension: 0.3,
        },
        {
          label: 'Messages',
          data: messages,
          borderColor: '#eeb0ff',
          backgroundColor: 'rgba(238, 176, 255, 0.3)',
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
      },
      scales: {
        y: { beginAtZero: true },
      },
    },
  });
}

function renderFeedbackChart(data, groupBy) {
  const labels = data.breakdown.map((item) => {
    if (groupBy === 'model') return item.model || 'Unknown model';
    return `${item.promptName || 'Prompt'} v${item.promptVersion || '–'}`;
  });

  const positive = data.breakdown.map((item) => item.positive || 0);
  const negative = data.breakdown.map((item) => item.negative || 0);

  const ctx = document.getElementById('feedbackChart').getContext('2d');
  if (charts.feedback) charts.feedback.destroy();

  charts.feedback = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Positive',
          data: positive,
          backgroundColor: 'rgba(124, 240, 255, 0.6)',
          borderColor: '#7cf0ff',
          stack: 'feedback',
        },
        {
          label: 'Negative',
          data: negative,
          backgroundColor: 'rgba(255, 99, 132, 0.5)',
          borderColor: '#ff6384',
          stack: 'feedback',
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true },
      },
    },
  });
}

function renderRagChart(data) {
  const ctx = document.getElementById('ragDonut').getContext('2d');
  if (charts.rag) charts.rag.destroy();

  const { ragConversations, noRagConversations } = data;
  const labels = ['RAG', 'Non-RAG'];
  const values = [ragConversations, noRagConversations];

  charts.rag = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: ['rgba(124, 240, 255, 0.7)', 'rgba(238, 176, 255, 0.35)'],
          borderColor: ['#7cf0ff', '#eeb0ff'],
          borderWidth: 1,
        },
      ],
    },
    options: {
      cutout: '70%',
      plugins: {
        legend: { position: 'bottom' },
      },
    },
  });

  elements.ragDonutLabel.textContent = formatPercent(data.ragUsageRate);
}

function updateSummary(usage, feedback, rag) {
  elements.totalConversations.textContent = formatNumber(usage.totalConversations);
  elements.totalMessages.textContent = formatNumber(usage.totalMessages);
  elements.positiveFeedback.textContent = formatNumber(feedback.positive);
  elements.positiveRate.textContent = feedback.totalFeedback > 0 ? `(${formatPercent(feedback.positiveRate)} positive)` : '(no feedback)';
  elements.ragUsage.textContent = formatPercent(rag.ragUsageRate);
  elements.ragConversations.textContent = formatNumber(rag.ragConversations);
  elements.noRagConversations.textContent = formatNumber(rag.noRagConversations);
  elements.ragPositiveRate.textContent = formatPercent(rag.feedback.rag.positiveRate);
  elements.noRagPositiveRate.textContent = formatPercent(rag.feedback.noRag.positiveRate);
  const delta = rag.feedback.rag.positiveRate - rag.feedback.noRag.positiveRate;
  elements.ragDelta.textContent = Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} pts` : '–';
}

function toggleEmptyState(container, emptyEl, hasData) {
  if (hasData) {
    container.style.display = 'block';
    emptyEl.style.display = 'none';
  } else {
    container.style.display = 'none';
    emptyEl.style.display = 'block';
  }
}

async function refresh() {
  const days = elements.periodSelect.value;
  const usageGroup = elements.usageGroupSelect.value;
  const feedbackGroup = elements.feedbackGroupSelect.value;

  elements.refreshBtn.disabled = true;
  elements.refreshBtn.textContent = 'Refreshing…';

  try {
    const [usage, feedback, rag] = await Promise.all([
      loadUsage(days, usageGroup),
      loadFeedback(days, feedbackGroup),
      loadRag(days),
    ]);

    updateSummary(usage, feedback, rag);

    const usageHasData = usage.breakdown && usage.breakdown.length > 0;
    toggleEmptyState(document.getElementById('usageChart'), elements.usageEmpty, usageHasData);
    if (usageHasData) renderUsageChart(usage, usageGroup);

    const feedbackHasData = feedback.breakdown && feedback.breakdown.length > 0;
    toggleEmptyState(document.getElementById('feedbackChart'), elements.feedbackEmpty, feedbackHasData);
    if (feedbackHasData) renderFeedbackChart(feedback, feedbackGroup);

    const ragHasData = rag.totalConversations > 0;
    if (ragHasData) {
      renderRagChart(rag);
    } else {
      elements.ragDonutLabel.textContent = '–';
    }
  } catch (err) {
    console.error('Analytics load failed', err);
    alert('Unable to load analytics. Check the server logs.');
  } finally {
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = 'Refresh data';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Check authentication first
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) return; // Will redirect to login

  elements.refreshBtn.addEventListener('click', refresh);
  elements.periodSelect.addEventListener('change', refresh);
  elements.usageGroupSelect.addEventListener('change', refresh);
  elements.feedbackGroupSelect.addEventListener('change', refresh);
  refresh();
});
