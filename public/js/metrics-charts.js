import { apiClient } from './utils/api-client.js';
import { sleep } from './utils/general-utils.js';

const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OVERLAYS = 4;
const COLOR_PALETTE = [
  '#007bff',
  '#6f42c1',
  '#20c997',
  '#fd7e14',
];

const CHART_TYPE_MAP = {
  line: 'line',
  bar: 'bar',
  area: 'line', // area maps to line with fill
};

export const PRESET_VIEWS = {
  healthOverview: {
    title: 'Health Overview',
    metricType: 'health',
    component: 'all',
    granularity: 'hourly',
    timeRange: '24h',
  },
  performanceComparison: {
    title: 'Performance Comparison',
    metricType: 'response_time',
    component: 'all',
    granularity: 'daily',
    timeRange: '7d',
  },
  costTrends: {
    title: 'Cost Trends',
    metricType: 'cost',
    component: 'all',
    granularity: 'daily',
    timeRange: '30d',
  },
  qualityScore: {
    title: 'Quality Score',
    metricType: 'quality_score',
    component: 'agentx',
    granularity: 'hourly',
    timeRange: '24h',
  },
};

export class TimeSeriesChart {
  constructor(options = {}) {
    const {
      containerId,
      title = '',
      metricType,
      component = 'all',
      granularity = 'hourly',
      timeRange = '24h',
      refreshInterval = 60000,
      overlays = [],
      chartType = 'line',
    } = options;

    if (!containerId) {
      throw new Error('TimeSeriesChart requires a containerId.');
    }

    this.containerId = containerId;
    this.title = title;
    this.metricType = metricType;
    this.component = component;
    this.granularity = granularity;
    this.timeRange = timeRange;
    this.refreshInterval = refreshInterval;
    this.overlays = overlays.slice(0, MAX_OVERLAYS);
    this.chartType = chartType;

    this.chart = null;
    this.cache = new Map();
    this.intervalId = null;

    this._onResize = this.handleResize.bind(this);
  }

  render() {
    this.initializeDOM();
    this.refresh();
  }

  startAutoRefresh() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.refresh(), this.refreshInterval);
  }

  stopAutoRefresh() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  destroy() {
    this.stopAutoRefresh();
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
    window.removeEventListener('resize', this._onResize);
  }

  initializeDOM() {
    const container = document.getElementById(this.containerId);
    if (!container) {
      throw new Error(`Container with id "${this.containerId}" not found.`);
    }

    container.innerHTML = '';
    container.classList.add('metrics-chart-container');

    this.headerEl = document.createElement('div');
    this.headerEl.className = 'metrics-chart-header';

    const titleEl = document.createElement('h3');
    titleEl.textContent = this.title || 'Time Series';
    this.headerEl.appendChild(titleEl);

    const controlsEl = document.createElement('div');
    controlsEl.className = 'metrics-chart-controls';

    this.typeSelect = document.createElement('select');
    ['line', 'bar', 'area'].forEach((type) => {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type.toUpperCase();
      if (type === this.chartType) option.selected = true;
      this.typeSelect.appendChild(option);
    });
    this.typeSelect.addEventListener('change', (e) => {
      this.setChartType(e.target.value);
    });
    controlsEl.appendChild(this.typeSelect);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', () => this.refresh());
    controlsEl.appendChild(refreshBtn);

    const exportPngBtn = document.createElement('button');
    exportPngBtn.type = 'button';
    exportPngBtn.textContent = 'Export PNG';
    exportPngBtn.addEventListener('click', () => this.exportPNG());
    controlsEl.appendChild(exportPngBtn);

    const exportCsvBtn = document.createElement('button');
    exportCsvBtn.type = 'button';
    exportCsvBtn.textContent = 'Export CSV';
    exportCsvBtn.addEventListener('click', () => this.exportCSV());
    controlsEl.appendChild(exportCsvBtn);

    this.headerEl.appendChild(controlsEl);

    this.canvasEl = document.createElement('canvas');
    this.canvasEl.setAttribute('role', 'img');

    this.messageEl = document.createElement('div');
    this.messageEl.className = 'metrics-chart-message';

    this.loadingEl = document.createElement('div');
    this.loadingEl.className = 'metrics-chart-loading';
    this.loadingEl.innerHTML = '<span class="spinner"></span> Loading metrics...';
    this.loadingEl.style.display = 'none';

    container.appendChild(this.headerEl);
    container.appendChild(this.loadingEl);
    container.appendChild(this.messageEl);
    container.appendChild(this.canvasEl);

    window.addEventListener('resize', this._onResize);
  }

  async refresh() {
    this.showMessage('');
    this.showLoading(true);

    try {
      const datasets = await this.buildDatasets();

      if (!datasets.length) {
        this.showMessage('No data available.');
        this.destroyChart();
        return;
      }

      this.renderChart(datasets);
    } catch (error) {
      console.error('Failed to load time-series data:', error);
      this.showMessage('Failed to load metrics. Please try again.');
    } finally {
      this.showLoading(false);
    }
  }

  async buildDatasets() {
    const overlays = this.overlays.length
      ? this.overlays
      : [
          {
            metricType: this.metricType,
            component: this.component,
            granularity: this.granularity,
            timeRange: this.timeRange,
            label: this.title || this.metricType,
          },
        ];

    const datasets = [];

    for (let i = 0; i < overlays.length && i < MAX_OVERLAYS; i += 1) {
      const overlay = overlays[i];
      const color = COLOR_PALETTE[i % COLOR_PALETTE.length];
      const series = await this.fetchMetricSeries(overlay);

      if (!series.length) continue;

      datasets.push({
        label: overlay.label || overlay.metricType || `Metric ${i + 1}`,
        data: series,
        borderColor: color,
        backgroundColor: this.applyAlpha(color, 0.1),
        tension: 0.4,
        fill: this.chartType === 'area',
      });
    }

    return datasets;
  }

  async fetchMetricSeries(config) {
    const params = {
      component: config.component || this.component,
      granularity: config.granularity || this.granularity,
      period: config.timeRange || this.timeRange,
    };

    const metricType = config.metricType || this.metricType;
    const cacheKey = this.buildCacheKey(metricType, params);
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
      return cached.data;
    }

    const endpoint = `/api/metrics/${metricType}/timeseries`;
    let attempt = 0;
    let lastError = null;

    while (attempt < 3) {
      try {
        const data = await this.fetchPaginated(endpoint, params);
        this.cache.set(cacheKey, { timestamp: Date.now(), data });
        return data;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt < 3) {
          await sleep(200 * attempt);
        }
      }
    }

    throw lastError || new Error('Failed to fetch metric series.');
  }

  async fetchPaginated(endpoint, params) {
    let page = 1;
    let cursor = null;
    const combined = [];
    let hasNextPage = true;
    let guard = 0;

    while (hasNextPage && guard < 100) {
      const pageParams = { ...params, page };
      if (cursor) pageParams.cursor = cursor;

      // eslint-disable-next-line no-await-in-loop
      const response = await apiClient.get(endpoint, pageParams);
      const series = this.normalizeTimeseries(response);
      combined.push(...series);

      const pagination = response?.pagination || response?.meta || {};
      const totalPages = pagination.totalPages || pagination.total_pages;
      const nextPage = pagination.nextPage || pagination.next_page;
      const nextCursor = pagination.nextCursor || pagination.next_cursor;
      const hasNextFlag = pagination.hasNextPage || pagination.has_next_page;

      if (nextCursor) {
        cursor = nextCursor;
        page += 1;
        hasNextPage = true;
      } else if (typeof nextPage === 'number') {
        page = nextPage;
        hasNextPage = page !== null && page !== undefined;
      } else if (typeof totalPages === 'number' && page < totalPages) {
        page += 1;
        hasNextPage = true;
      } else if (hasNextFlag === true) {
        page += 1;
        hasNextPage = true;
      } else {
        hasNextPage = false;
      }

      guard += 1;
    }

    combined.sort((a, b) => new Date(a.x) - new Date(b.x));
    return combined;
  }

  normalizeTimeseries(response) {
    if (!response) return [];

    // Shape: { timestamps: [], values: [] } or { labels: [], values: [] }
    if (Array.isArray(response.timestamps) && Array.isArray(response.values)) {
      return response.timestamps.map((ts, idx) => ({
        x: ts,
        y: Number(response.values[idx] ?? 0),
      }));
    }

    if (Array.isArray(response.labels) && Array.isArray(response.values)) {
      return response.labels.map((ts, idx) => ({
        x: ts,
        y: Number(response.values[idx] ?? 0),
      }));
    }

    const series = response.data || response.results || response.timeseries || response.items || response;
    if (!Array.isArray(series)) return [];

    return series
      .map((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) {
          return { x: entry[0], y: Number(entry[1] ?? 0) };
        }

        const timestamp =
          entry.timestamp ||
          entry.time ||
          entry.date ||
          entry.ts ||
          entry.x;

        const value =
          entry.value ??
          entry.metric ??
          entry.y ??
          entry.amount ??
          entry.score;

        if (!timestamp || value === undefined || value === null) return null;

        return { x: timestamp, y: Number(value) };
      })
      .filter(Boolean);
  }

  renderChart(datasets) {
    const ctx = this.canvasEl.getContext('2d');
    const type = CHART_TYPE_MAP[this.chartType] || 'line';
    const timeUnit = this.getTimeUnit();

    const config = {
      type,
      data: {
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: { position: 'top' },
          title: { display: Boolean(this.title), text: this.title },
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = context.parsed.y;
                const label = context.dataset.label || 'Value';
                if (value === undefined || value === null || Number.isNaN(value)) {
                  return label;
                }
                return `${label}: ${Number(value).toFixed(2)}`;
              },
            },
          },
          zoom: {
            pan: { enabled: true, mode: 'x' },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
          },
        },
        scales: {
          x: { type: 'time', time: { unit: timeUnit } },
          y: { beginAtZero: true },
        },
      },
    };

    if (this.chart) {
      this.chart.destroy();
    }

    this.chart = new Chart(ctx, config);
  }

  setChartType(type) {
    if (!['line', 'bar', 'area'].includes(type)) return;
    this.chartType = type;
    if (this.typeSelect && this.typeSelect.value !== type) {
      this.typeSelect.value = type;
    }
    if (this.chart) {
      this.refresh();
    }
  }

  setOverlays(overlays = []) {
    this.overlays = overlays.slice(0, MAX_OVERLAYS);
    this.refresh();
  }

  exportPNG() {
    if (!this.chart) return;
    const link = document.createElement('a');
    link.href = this.chart.toBase64Image();
    link.download = `${this.title || 'chart'}.png`;
    link.click();
  }

  exportCSV() {
    if (!this.chart) return;
    const rows = [['timestamp', ...this.chart.data.datasets.map((d) => d.label)]];
    const timestamps = new Set();

    this.chart.data.datasets.forEach((dataset) => {
      dataset.data.forEach((point) => timestamps.add(point.x));
    });

    const sortedTimestamps = Array.from(timestamps).sort((a, b) => new Date(a) - new Date(b));

    sortedTimestamps.forEach((ts) => {
      const row = [ts];
      this.chart.data.datasets.forEach((dataset) => {
        const match = dataset.data.find((p) => String(p.x) === String(ts));
        row.push(match ? match.y : '');
      });
      rows.push(row);
    });

    const csvContent = rows.map((row) => row.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${this.title || 'metrics'}.csv`;
    link.click();
  }

  showLoading(isLoading) {
    if (this.loadingEl) {
      this.loadingEl.style.display = isLoading ? 'flex' : 'none';
    }
  }

  showMessage(message) {
    if (this.messageEl) {
      this.messageEl.textContent = message;
      this.messageEl.style.display = message ? 'block' : 'none';
    }
  }

  destroyChart() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }

  handleResize() {
    if (this.chart) {
      this.chart.resize();
    }
  }

  buildCacheKey(metricType, params) {
    const base = `${metricType}|${params.component}|${params.granularity}|${params.period}`;
    const paginationTokens = ['page', 'cursor']
      .filter((key) => params[key])
      .map((key) => `${key}:${params[key]}`)
      .join('|');
    return `${base}|${paginationTokens}`;
  }

  applyAlpha(color, alpha = 0.1) {
    const hex = color.replace('#', '');
    const bigint = parseInt(hex, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  getTimeUnit() {
    if (this.granularity === 'daily') return 'day';
    if (this.granularity === 'weekly') return 'week';
    if (this.granularity === 'monthly') return 'month';
    return 'hour';
  }
}

export default TimeSeriesChart;
