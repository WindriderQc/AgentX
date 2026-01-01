/**
 * Prompt Management Application
 * Main orchestrator for prompt CRUD, A/B testing, and metrics
 */

import { PromptsAPI } from './api/promptsAPI.js';
import { PromptListView } from './components/PromptListView.js';
import { PromptEditorModal } from './components/PromptEditorModal.js';
import { ABTestConfigPanel } from './components/ABTestConfigPanel.js';
import { TemplateTester } from './components/TemplateTester.js';
import { Toast } from './components/shared/Toast.js';
import { PerformanceMetricsDashboard } from './components/PerformanceMetricsDashboard.js';
import { OnboardingWizard } from './components/OnboardingWizard.js';
import { PromptVersionCompare } from './components/PromptVersionCompare.js';

// Global state
const state = {
  prompts: {},        // Grouped by name: { "default_chat": [...versions] }
  currentView: null,
  filters: {
    search: '',
    status: 'all',
    sortBy: 'name',
    tags: [],          // Selected tags
    dateFrom: null,    // Date range from
    dateTo: null,      // Date range to
    author: ''         // Author filter
  },
  user: null,
  advancedFiltersVisible: false
};

// Component instances
let promptListView;
let promptEditorModal;
let abTestConfigPanel;
let templateTester;
let onboardingWizard;
let metricsDashboard;
let versionCompare;
let api;
let toast;

/**
 * Initialize application
 */
async function init() {
  console.log('Initializing Prompt Management...');

  // Check authentication
  const authed = await checkAuth();
  if (!authed) return;

  // Initialize API client
  api = new PromptsAPI();

  // Initialize toast notifications
  toast = new Toast(document.getElementById('toastContainer'));

  // Initialize components
  initializeComponents();

  // Attach event listeners
  attachEventListeners();

  // Load initial data
  await loadPrompts();

  // Update stats
  updateStats();

  // Check if user should see onboarding wizard
  checkOnboarding();
}

/**
 * Initialize all components
 */
function initializeComponents() {
  const container = document.getElementById('promptListContainer');
  promptListView = new PromptListView(container, state);

  // Initialize prompt editor modal
  promptEditorModal = new PromptEditorModal();
  promptEditorModal.onSave = handlePromptSave;

  // Initialize A/B test configuration panel
  abTestConfigPanel = new ABTestConfigPanel();
  abTestConfigPanel.onSave = handleABTestSave;

  // Initialize template tester
  templateTester = new TemplateTester();

  // Initialize onboarding wizard
  onboardingWizard = new OnboardingWizard(api, toast);

  // Initialize metrics dashboard
  metricsDashboard = new PerformanceMetricsDashboard('metricsDashboard', state);

  // Initialize version comparison
  versionCompare = new PromptVersionCompare(api, toast);

  // Attach component event handlers
  promptListView.on('edit', handleEdit);
  promptListView.on('delete', handleDelete);
  promptListView.on('configure-ab-test', handleConfigureABTest);
  promptListView.on('view-metrics', handleViewMetrics);
  promptListView.on('test-template', handleTestTemplate);
  promptListView.on('activate', handleActivate);
  promptListView.on('deactivate', handleDeactivate);
  promptListView.on('new-version', handleNewVersion);
}

/**
 * Attach global event listeners
 */
function attachEventListeners() {
  // Create prompt buttons
  document.getElementById('createPromptBtn').addEventListener('click', () => {
    promptEditorModal.openCreate();
  });

  document.getElementById('emptyCreateBtn')?.addEventListener('click', () => {
    promptEditorModal.openCreate();
  });

  // Search input with debounce
  let searchTimeout;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.filters.search = e.target.value;
      filterAndRenderPrompts();
    }, 300);
  });

  // Status filter
  document.getElementById('statusFilter').addEventListener('change', (e) => {
    state.filters.status = e.target.value;
    filterAndRenderPrompts();
  });

  // Sort by
  document.getElementById('sortBy').addEventListener('change', (e) => {
    state.filters.sortBy = e.target.value;
    filterAndRenderPrompts();
  });

  // Show onboarding button (if exists)
  const showOnboardingBtn = document.getElementById('showOnboardingBtn');
  if (showOnboardingBtn) {
    showOnboardingBtn.addEventListener('click', () => {
      onboardingWizard.open();
    });
  }

  // Advanced filters toggle
  document.getElementById('advancedFiltersBtn').addEventListener('click', () => {
    toggleAdvancedFilters();
  });

  // Advanced filter controls
  document.getElementById('applyFiltersBtn').addEventListener('click', () => {
    applyAdvancedFilters();
  });

  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    clearAdvancedFilters();
  });

  // Export/Import buttons
  document.getElementById('exportPromptsBtn').addEventListener('click', () => {
    exportPrompts();
  });

  document.getElementById('importPromptsBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });

  document.getElementById('importFileInput').addEventListener('change', (e) => {
    handleImportFile(e.target.files[0]);
    e.target.value = ''; // Reset file input
  });

  // Compare Versions button
  document.getElementById('compareVersionsBtn').addEventListener('click', () => {
    showVersionCompareSelector();
  });

  // Keyboard shortcuts
  attachKeyboardShortcuts();
}

/**
 * Attach keyboard shortcuts for navigation and actions
 */
function attachKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore shortcuts if user is typing in an input/textarea
    const activeElement = document.activeElement;
    const isTyping = activeElement && (
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      activeElement.isContentEditable
    );

    // Ctrl+N or n (when not typing) - New prompt
    if ((e.ctrlKey && e.key === 'n') || (!isTyping && e.key === 'n')) {
      e.preventDefault();
      promptEditorModal.openCreate();
      return;
    }

    // Ctrl+F or / (when not typing) - Focus search
    if ((e.ctrlKey && e.key === 'f') || (!isTyping && e.key === '/')) {
      e.preventDefault();
      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
      return;
    }

    // ? (when not typing) - Show keyboard shortcuts help
    if (!isTyping && e.key === '?') {
      e.preventDefault();
      showKeyboardShortcutsHelp();
      return;
    }
  });

  console.log('Keyboard shortcuts enabled: n (new), / (search), ? (help)');
}

/**
 * Show keyboard shortcuts help modal
 */
function showKeyboardShortcutsHelp() {
  const helpHtml = `
    <div class="modal-overlay" id="keyboardShortcutsHelp" style="display: flex;">
      <div class="modal-container" style="max-width: 600px;">
        <div class="modal-header">
          <h2>
            <i class="fas fa-keyboard"></i>
            Keyboard Shortcuts
          </h2>
          <button class="modal-close" onclick="document.getElementById('keyboardShortcutsHelp').remove()">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="modal-body">
          <div class="shortcuts-list">
            <div class="shortcut-item">
              <div class="shortcut-keys">
                <kbd>N</kbd> or <kbd>Ctrl</kbd> + <kbd>N</kbd>
              </div>
              <div class="shortcut-description">Create new prompt</div>
            </div>

            <div class="shortcut-item">
              <div class="shortcut-keys">
                <kbd>/</kbd> or <kbd>Ctrl</kbd> + <kbd>F</kbd>
              </div>
              <div class="shortcut-description">Focus search input</div>
            </div>

            <div class="shortcut-item">
              <div class="shortcut-keys">
                <kbd>?</kbd>
              </div>
              <div class="shortcut-description">Show this help</div>
            </div>

            <div class="shortcut-item">
              <div class="shortcut-keys">
                <kbd>Esc</kbd>
              </div>
              <div class="shortcut-description">Close modal or dialog</div>
            </div>
          </div>

          <div class="shortcuts-note">
            <i class="fas fa-info-circle"></i>
            <span>Shortcuts are disabled when typing in input fields.</span>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-primary" onclick="document.getElementById('keyboardShortcutsHelp').remove()">
            <i class="fas fa-check"></i> Got it
          </button>
        </div>
      </div>
    </div>
  `;

  // Remove existing help modal if present
  const existing = document.getElementById('keyboardShortcutsHelp');
  if (existing) existing.remove();

  // Append to body
  document.body.insertAdjacentHTML('beforeend', helpHtml);

  // Click outside to close
  const helpModal = document.getElementById('keyboardShortcutsHelp');
  helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) {
      helpModal.remove();
    }
  });
}

/**
 * Load all prompts from API
 */
async function loadPrompts() {
  try {
    showLoading(true);
    const response = await api.listAll();
    state.prompts = response.data || {};

    console.log(`Loaded ${Object.keys(state.prompts).length} prompt groups`);

    // Populate tags dropdown after loading prompts
    populateTagsFilter();

    filterAndRenderPrompts();
    showLoading(false);

    // Show empty state if no prompts
    if (Object.keys(state.prompts).length === 0) {
      document.getElementById('emptyState').style.display = 'flex';
      document.getElementById('promptListContainer').style.display = 'none';
    } else {
      document.getElementById('emptyState').style.display = 'none';
      document.getElementById('promptListContainer').style.display = 'block';
    }
  } catch (error) {
    toast.error(`Failed to load prompts: ${error.message}`);
    showLoading(false);
  }
}

/**
 * Populate tags filter dropdown from all prompts
 */
function populateTagsFilter() {
  const tagsSet = new Set();

  // Collect all unique tags from all prompt versions
  Object.values(state.prompts).forEach(versions => {
    versions.forEach(v => {
      if (v.tags && Array.isArray(v.tags)) {
        v.tags.forEach(tag => tagsSet.add(tag));
      }
    });
  });

  // Sort tags alphabetically
  const sortedTags = Array.from(tagsSet).sort();

  // Populate select element
  const tagSelect = document.getElementById('tagFilter');
  if (tagSelect) {
    // Keep the "All Tags" option
    tagSelect.innerHTML = '<option value="">-- All Tags --</option>';

    sortedTags.forEach(tag => {
      const option = document.createElement('option');
      option.value = tag;
      option.textContent = tag;
      tagSelect.appendChild(option);
    });

    console.log(`Populated ${sortedTags.length} unique tags`);
  }
}

/**
 * Toggle advanced filters panel visibility
 */
function toggleAdvancedFilters() {
  state.advancedFiltersVisible = !state.advancedFiltersVisible;
  const panel = document.getElementById('advancedFiltersPanel');
  const btn = document.getElementById('advancedFiltersBtn');

  if (state.advancedFiltersVisible) {
    panel.style.display = 'block';
    btn.classList.add('active');
    btn.querySelector('span').textContent = 'Hide Filters';
  } else {
    panel.style.display = 'none';
    btn.classList.remove('active');
    btn.querySelector('span').textContent = 'More Filters';
  }
}

/**
 * Apply advanced filters
 */
function applyAdvancedFilters() {
  // Get tag filter values
  const tagSelect = document.getElementById('tagFilter');
  const selectedTags = Array.from(tagSelect.selectedOptions)
    .map(opt => opt.value)
    .filter(val => val !== ''); // Remove empty value

  // Get date range values
  const dateFrom = document.getElementById('dateFrom').value || null;
  const dateTo = document.getElementById('dateTo').value || null;

  // Get author filter value
  const authorFilter = document.getElementById('authorFilter').value.trim();

  // Update state
  state.filters.tags = selectedTags;
  state.filters.dateFrom = dateFrom;
  state.filters.dateTo = dateTo;
  state.filters.author = authorFilter;

  // Apply filters
  filterAndRenderPrompts();

  // Show toast if filters applied
  const filtersCount = selectedTags.length + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (authorFilter ? 1 : 0);
  if (filtersCount > 0) {
    toast.info(`Applied ${filtersCount} advanced filter${filtersCount !== 1 ? 's' : ''}`);
  }

  console.log('Advanced filters applied:', {
    tags: selectedTags,
    dateFrom,
    dateTo,
    author: authorFilter
  });
}

/**
 * Clear all advanced filters
 */
function clearAdvancedFilters() {
  // Reset form inputs
  document.getElementById('tagFilter').selectedIndex = -1; // Clear all selections
  document.getElementById('dateFrom').value = '';
  document.getElementById('dateTo').value = '';
  document.getElementById('authorFilter').value = '';

  // Reset state
  state.filters.tags = [];
  state.filters.dateFrom = null;
  state.filters.dateTo = null;
  state.filters.author = '';

  // Re-apply filters
  filterAndRenderPrompts();

  toast.info('Advanced filters cleared');

  console.log('Advanced filters cleared');
}

/**
 * Filter and render prompts based on current filters
 */
function filterAndRenderPrompts() {
  let filtered = Object.entries(state.prompts);

  // Apply search filter (enhanced to search name, description, and author)
  if (state.filters.search) {
    const search = state.filters.search.toLowerCase();
    filtered = filtered.filter(([name, versions]) => {
      // Search in prompt name
      if (name.toLowerCase().includes(search)) return true;

      // Search in any version's description or author
      return versions.some(v =>
        (v.description && v.description.toLowerCase().includes(search)) ||
        (v.author && v.author.toLowerCase().includes(search))
      );
    });
  }

  // Apply status filter
  if (state.filters.status !== 'all') {
    filtered = filtered.map(([name, versions]) => {
      const filteredVersions = versions.filter(v =>
        state.filters.status === 'active' ? v.isActive : !v.isActive
      );
      return [name, filteredVersions];
    }).filter(([, versions]) => versions.length > 0);
  }

  // Apply tag filter
  if (state.filters.tags && state.filters.tags.length > 0) {
    filtered = filtered.filter(([name, versions]) => {
      return versions.some(v => {
        if (!v.tags || v.tags.length === 0) return false;
        // Check if any selected tag matches any version's tags
        return state.filters.tags.some(tag => v.tags.includes(tag));
      });
    });
  }

  // Apply date range filter
  if (state.filters.dateFrom || state.filters.dateTo) {
    filtered = filtered.filter(([name, versions]) => {
      return versions.some(v => {
        if (!v.createdAt) return false;

        const createdDate = new Date(v.createdAt);

        if (state.filters.dateFrom) {
          const fromDate = new Date(state.filters.dateFrom);
          if (createdDate < fromDate) return false;
        }

        if (state.filters.dateTo) {
          const toDate = new Date(state.filters.dateTo);
          toDate.setHours(23, 59, 59, 999); // End of day
          if (createdDate > toDate) return false;
        }

        return true;
      });
    });
  }

  // Apply author filter
  if (state.filters.author) {
    const authorSearch = state.filters.author.toLowerCase();
    filtered = filtered.filter(([name, versions]) => {
      return versions.some(v =>
        v.author && v.author.toLowerCase().includes(authorSearch)
      );
    });
  }

  // Apply sorting
  filtered.sort(([nameA, versionsA], [nameB, versionsB]) => {
    switch (state.filters.sortBy) {
      case 'name':
        return nameA.localeCompare(nameB);
      case 'version':
        return versionsB[0].version - versionsA[0].version;
      case 'impressions':
        const impA = versionsA.reduce((sum, v) => sum + (v.stats?.impressions || 0), 0);
        const impB = versionsB.reduce((sum, v) => sum + (v.stats?.impressions || 0), 0);
        return impB - impA;
      case 'positiveRate':
        const rateA = calculatePositiveRate(versionsA);
        const rateB = calculatePositiveRate(versionsB);
        return rateB - rateA;
      default:
        return 0;
    }
  });

  // Render
  promptListView.render(Object.fromEntries(filtered));
  updateStats();
}

/**
 * Calculate positive rate for a prompt group
 */
function calculatePositiveRate(versions) {
  const totals = versions.reduce((acc, v) => ({
    positive: acc.positive + (v.stats?.positiveCount || 0),
    negative: acc.negative + (v.stats?.negativeCount || 0)
  }), { positive: 0, negative: 0 });

  const total = totals.positive + totals.negative;
  return total > 0 ? totals.positive / total : 0;
}

/**
 * Event Handlers
 */

async function handleEdit(event) {
  const { promptName, version } = event.detail;

  // Find the prompt data
  const versions = state.prompts[promptName] || [];
  const promptData = versions.find(v => v.version === version);

  if (!promptData) {
    toast.error(`Could not find ${promptName} v${version}`);
    return;
  }

  // Open editor in edit mode
  promptEditorModal.openEdit(promptData);
}

async function handleDelete(event) {
  const { promptId, promptName, version } = event.detail;

  if (!confirm(`Delete ${promptName} v${version}?\n\nThis action cannot be undone.`)) {
    return;
  }

  try {
    await api.delete(promptId);
    toast.success(`Deleted ${promptName} v${version}`);
    await loadPrompts();
  } catch (error) {
    toast.error(`Failed to delete: ${error.message}`);
  }
}

async function handleConfigureABTest(event) {
  const { promptName } = event.detail;

  // Get versions for this prompt
  const versions = state.prompts[promptName] || [];

  if (versions.length === 0) {
    toast.error(`No versions found for ${promptName}`);
    return;
  }

  // Open A/B test configuration panel
  abTestConfigPanel.open(promptName, versions);
}

async function handleViewMetrics(event) {
  const { promptName } = event.detail;
  // Redirect to analytics page with filter
  window.location.href = `/analytics.html?promptName=${encodeURIComponent(promptName)}`;
}

async function handleTestTemplate(event) {
  const { promptName, version } = event.detail;

  // Find the prompt data
  const versions = state.prompts[promptName] || [];
  const promptData = versions.find(v => v.version === version);

  if (!promptData) {
    toast.error(`Could not find ${promptName} v${version}`);
    return;
  }

  // Open template tester with prompt data
  templateTester.open(promptData);
}

async function handleActivate(event) {
  const { promptId } = event.detail;
  try {
    await api.activate(promptId);
    toast.success('Prompt activated');
    await loadPrompts();
  } catch (error) {
    toast.error(`Failed to activate: ${error.message}`);
  }
}

async function handleDeactivate(event) {
  const { promptId } = event.detail;
  try {
    await api.deactivate(promptId);
    toast.success('Prompt deactivated');
    await loadPrompts();
  } catch (error) {
    toast.error(`Failed to deactivate: ${error.message}`);
  }
}

async function handleNewVersion(event) {
  const { promptName } = event.detail;
  // Open editor modal with promptName pre-filled
  promptEditorModal.openCreate(promptName);
}

/**
 * Handle prompt save from editor modal
 */
async function handlePromptSave(formData, mode, originalData) {
  try {
    if (mode === 'create') {
      // Create new prompt
      await api.create(formData);
      toast.success(`Created new prompt: ${formData.name}`);
    } else {
      // Update existing prompt
      const promptId = originalData._id;
      await api.update(promptId, {
        description: formData.description,
        tags: formData.tags,
        systemPrompt: formData.systemPrompt,
        isActive: formData.isActive,
        trafficWeight: formData.trafficWeight
      });
      toast.success(`Updated ${formData.name} v${originalData.version}`);
    }

    // Reload prompts list
    await loadPrompts();
  } catch (error) {
    // Re-throw to let modal handle the error display
    throw error;
  }
}

/**
 * Handle A/B test configuration save
 */
async function handleABTestSave(promptName, versionConfigs) {
  try {
    // Build versions array for API call
    const versions = versionConfigs
      .filter(v => v.isActive)
      .map(v => ({
        version: v.version,
        weight: v.weight
      }));

    // Call API to configure A/B test
    await api.configureABTest(promptName, versions);

    // Update individual versions with new settings
    const updatePromises = versionConfigs.map(config => {
      const version = state.prompts[promptName].find(v => v.version === config.version);
      if (!version) return Promise.resolve();

      return api.update(version._id, {
        isActive: config.isActive,
        trafficWeight: config.weight
      });
    });

    await Promise.all(updatePromises);

    toast.success(`A/B test configured for ${promptName}`);

    // Reload prompts list
    await loadPrompts();
  } catch (error) {
    // Re-throw to let panel handle the error display
    throw error;
  }
}

/**
 * Update dashboard stats
 */
function updateStats() {
  const allPrompts = Object.values(state.prompts).flat();

  // Total prompts
  document.getElementById('totalPrompts').textContent = allPrompts.length;

  // Active A/B tests (names with multiple active versions)
  const activeTests = Object.values(state.prompts).filter(versions =>
    versions.filter(v => v.isActive).length > 1
  ).length;
  document.getElementById('activeTests').textContent = activeTests;

  // Average positive rate
  const totals = allPrompts.reduce((acc, p) => ({
    positive: acc.positive + (p.stats?.positiveCount || 0),
    negative: acc.negative + (p.stats?.negativeCount || 0)
  }), { positive: 0, negative: 0 });
  const total = totals.positive + totals.negative;
  const avgRate = total > 0 ? ((totals.positive / total) * 100).toFixed(1) : 0;
  document.getElementById('avgPositiveRate').textContent = `${avgRate}%`;

  // Total impressions
  const totalImpressions = allPrompts.reduce((sum, p) => sum + (p.stats?.impressions || 0), 0);
  document.getElementById('totalImpressions').textContent = totalImpressions.toLocaleString();
}

/**
 * Check authentication
 */
async function checkAuth() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'include' });
    if (!response.ok) {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
      return false;
    }
    state.user = await response.json();
    return true;
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
}

/**
 * Show/hide loading state
 */
function showLoading(show) {
  document.getElementById('loadingState').style.display = show ? 'flex' : 'none';
  document.getElementById('promptListContainer').style.display = show ? 'none' : 'block';
}

/**
 * Check if user should see onboarding wizard
 */
function checkOnboarding() {
  // Check if user has seen onboarding before (separate from completion)
  const hasSeenOnboarding = localStorage.getItem('agentx_onboarding_seen') === 'true';
  const hasCompletedOnboarding = OnboardingWizard.isCompleted();
  const hasPrompts = Object.keys(state.prompts).length > 0;

  console.log('Onboarding check:', {
    seen: hasSeenOnboarding,
    completed: hasCompletedOnboarding,
    hasPrompts: hasPrompts
  });

  // Show onboarding if user hasn't seen it before AND there are no prompts (first-time user)
  // This allows users to skip onboarding but not see it again unless they click "Show Tutorial"
  if (!hasSeenOnboarding && !hasPrompts) {
    console.log('Showing onboarding wizard for first-time user');
    // Mark as seen immediately to prevent showing again on refresh
    localStorage.setItem('agentx_onboarding_seen', 'true');

    // Small delay to let the page settle
    setTimeout(() => {
      onboardingWizard.open();
    }, 500);
  }
}

/**
 * Export all prompts as JSON file
 */
function exportPrompts() {
  try {
    // Flatten prompt data for export
    const exportData = [];

    Object.entries(state.prompts).forEach(([name, versions]) => {
      versions.forEach(v => {
        exportData.push({
          name: v.name,
          version: v.version,
          description: v.description || '',
          author: v.author || 'unknown',
          tags: v.tags || [],
          systemPrompt: v.systemPrompt,
          isActive: v.isActive || false,
          trafficWeight: v.trafficWeight || 100,
          createdAt: v.createdAt
        });
      });
    });

    // Create JSON blob
    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });

    // Create download link
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agentx-prompts-${new Date().toISOString().split('T')[0]}.json`;

    // Trigger download
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Clean up
    URL.revokeObjectURL(url);

    toast.success(`Exported ${exportData.length} prompt${exportData.length !== 1 ? 's' : ''}`);

    console.log(`Exported ${exportData.length} prompts`);
  } catch (error) {
    console.error('Export failed:', error);
    toast.error(`Export failed: ${error.message}`);
  }
}

/**
 * Handle import file selection
 */
async function handleImportFile(file) {
  if (!file) return;

  try {
    // Read file as text
    const text = await file.text();
    const importData = JSON.parse(text);

    // Validate data format
    if (!Array.isArray(importData)) {
      throw new Error('Invalid format: Expected array of prompts');
    }

    // Show import modal for conflict resolution
    showImportModal(importData);

  } catch (error) {
    console.error('Import failed:', error);
    toast.error(`Import failed: ${error.message}`);
  }
}

/**
 * Show import modal with conflict resolution options
 */
function showImportModal(importData) {
  // Validate each prompt
  const validPrompts = [];
  const invalidPrompts = [];

  importData.forEach((prompt, index) => {
    if (validateImportPrompt(prompt)) {
      validPrompts.push(prompt);
    } else {
      invalidPrompts.push({ index, prompt });
    }
  });

  if (invalidPrompts.length > 0) {
    console.warn(`${invalidPrompts.length} invalid prompts skipped`);
  }

  if (validPrompts.length === 0) {
    toast.error('No valid prompts found in file');
    return;
  }

  // Check for duplicates
  const duplicates = checkDuplicates(validPrompts);

  // Create modal
  const modalHtml = `
    <div class="modal-overlay" id="importModal" style="display: flex;">
      <div class="modal-container">
        <div class="modal-header">
          <h2>
            <i class="fas fa-upload"></i>
            Import Prompts
          </h2>
          <button class="modal-close" onclick="document.getElementById('importModal').remove()">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="modal-body">
          <div class="import-summary">
            <p>Found <strong>${validPrompts.length}</strong> valid prompt${validPrompts.length !== 1 ? 's' : ''} in file</p>
            ${invalidPrompts.length > 0 ? `<p class="text-warning">${invalidPrompts.length} invalid prompt${invalidPrompts.length !== 1 ? 's' : ''} will be skipped</p>` : ''}
            ${duplicates.length > 0 ? `<p class="text-warning">${duplicates.length} prompt${duplicates.length !== 1 ? 's' : ''} already exist</p>` : ''}
          </div>

          ${duplicates.length > 0 ? `
            <div class="form-group">
              <label>Handle duplicates:</label>
              <select id="duplicateStrategy" class="form-control">
                <option value="skip">Skip duplicates (keep existing)</option>
                <option value="overwrite">Overwrite existing versions</option>
                <option value="newVersion">Create new versions</option>
              </select>
            </div>
          ` : ''}
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" onclick="document.getElementById('importModal').remove()">
            <i class="fas fa-times"></i> Cancel
          </button>
          <button class="btn-primary" id="confirmImportBtn">
            <i class="fas fa-check"></i> Import
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // Attach confirm handler
  document.getElementById('confirmImportBtn').addEventListener('click', async () => {
    const strategy = document.getElementById('duplicateStrategy')?.value || 'skip';
    await executeImport(validPrompts, strategy);
    document.getElementById('importModal').remove();
  });
}

/**
 * Validate import prompt format
 */
function validateImportPrompt(prompt) {
  // Required fields
  if (!prompt.name || typeof prompt.name !== 'string') return false;
  if (!prompt.systemPrompt || typeof prompt.systemPrompt !== 'string') return false;

  // Name format
  if (!/^[a-z0-9_]+$/.test(prompt.name)) return false;

  return true;
}

/**
 * Check for duplicate prompts
 */
function checkDuplicates(importPrompts) {
  const duplicates = [];

  importPrompts.forEach(p => {
    if (state.prompts[p.name]) {
      const existing = state.prompts[p.name].find(v => v.version === p.version);
      if (existing) {
        duplicates.push(p);
      }
    }
  });

  return duplicates;
}

/**
 * Execute import with selected strategy
 */
async function executeImport(prompts, strategy) {
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const prompt of prompts) {
    try {
      const isDuplicate = state.prompts[prompt.name]?.some(v => v.version === prompt.version);

      if (isDuplicate && strategy === 'skip') {
        skipped++;
        continue;
      }

      // Prepare prompt data
      const promptData = {
        name: prompt.name,
        description: prompt.description || '',
        author: prompt.author || 'imported',
        tags: Array.isArray(prompt.tags) ? prompt.tags : [],
        systemPrompt: prompt.systemPrompt,
        isActive: false, // Import as inactive for safety
        trafficWeight: prompt.trafficWeight || 100
      };

      // Create via API
      await api.create(promptData);
      imported++;

    } catch (error) {
      console.error(`Failed to import prompt ${prompt.name}:`, error);
      failed++;
    }
  }

  // Show results
  if (imported > 0) {
    toast.success(`Imported ${imported} prompt${imported !== 1 ? 's' : ''} successfully`);
  }
  if (skipped > 0) {
    toast.info(`Skipped ${skipped} duplicate${skipped !== 1 ? 's' : ''}`);
  }
  if (failed > 0) {
    toast.error(`Failed to import ${failed} prompt${failed !== 1 ? 's' : ''}`);
  }

  // Reload prompts
  await loadPrompts();

  console.log(`Import complete: ${imported} imported, ${skipped} skipped, ${failed} failed`);
}

/**
 * Show prompt selector for version comparison
 */
function showVersionCompareSelector() {
  const promptNames = Object.keys(state.prompts);

  if (promptNames.length === 0) {
    toast.info('No prompts available to compare');
    return;
  }

  // Filter prompts that have at least 2 versions
  const comparablePrompts = promptNames.filter(name => {
    const versions = state.prompts[name];
    return versions && versions.length >= 2;
  });

  if (comparablePrompts.length === 0) {
    toast.info('No prompts with multiple versions found. Create additional versions to enable comparison.');
    return;
  }

  // Create selection modal
  const modalHtml = `
    <div class="modal-overlay" id="promptSelectorModal" style="display: flex;">
      <div class="modal-container" style="max-width: 500px;">
        <div class="modal-header">
          <h2>
            <i class="fas fa-columns"></i>
            Select Prompt to Compare
          </h2>
          <button class="modal-close" onclick="document.getElementById('promptSelectorModal').remove()">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="modal-body">
          <p style="margin-bottom: 16px; color: var(--muted);">
            Choose a prompt with multiple versions to compare:
          </p>
          <div class="form-group">
            <label>Prompt Name</label>
            <select id="promptNameSelect" class="form-control" size="8" style="width: 100%;">
              ${comparablePrompts.map(name => {
                const versions = state.prompts[name];
                return `<option value="${name}">${name} (${versions.length} versions)</option>`;
              }).join('')}
            </select>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" onclick="document.getElementById('promptSelectorModal').remove()">
            <i class="fas fa-times"></i> Cancel
          </button>
          <button class="btn-primary" id="confirmPromptSelectBtn">
            <i class="fas fa-columns"></i> Compare Versions
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // Auto-select first item
  const select = document.getElementById('promptNameSelect');
  if (select && select.options.length > 0) {
    select.selectedIndex = 0;
  }

  // Attach confirm handler
  document.getElementById('confirmPromptSelectBtn').addEventListener('click', () => {
    const selectedPrompt = select.value;
    document.getElementById('promptSelectorModal').remove();

    if (selectedPrompt) {
      versionCompare.open(selectedPrompt);
    }
  });

  // Double-click to select
  select.addEventListener('dblclick', () => {
    const selectedPrompt = select.value;
    document.getElementById('promptSelectorModal').remove();

    if (selectedPrompt) {
      versionCompare.open(selectedPrompt);
    }
  });

  // Click outside to close
  const modal = document.getElementById('promptSelectorModal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}

/**
 * Listen for version change events from comparison modal
 */
window.addEventListener('prompt-version-changed', async (e) => {
  console.log('Version changed, reloading prompts:', e.detail);
  await loadPrompts();
});

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
