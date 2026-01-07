/**
 * Workspace Management Module (Week 4 Day 3: Multi-Tenancy UI)
 *
 * Handles workspace switching, localStorage persistence, and API calls.
 * Usage:
 *   WorkspaceManager.init() - Initialize on page load
 *   WorkspaceManager.getCurrentWorkspace() - Get current workspace
 *   WorkspaceManager.switchWorkspace(slug) - Switch to different workspace
 */

const WorkspaceManager = {
  STORAGE_KEY: 'agentx_current_workspace',
  currentWorkspace: null,
  workspaces: [],

  /**
   * Initialize workspace manager
   */
  async init() {
    console.log('[Workspace] Initializing...');

    // Load workspaces from API
    await this.loadWorkspaces();

    // Restore last selected workspace from localStorage
    const saved = localStorage.getItem(this.STORAGE_KEY);
    if (saved && this.workspaces.find(w => w.slug === saved)) {
      this.currentWorkspace = saved;
    } else if (this.workspaces.length > 0) {
      // Default to first workspace
      this.currentWorkspace = this.workspaces[0].slug;
    }

    console.log('[Workspace] Current workspace:', this.currentWorkspace);

    // Update UI
    this.updateUI();

    return this.currentWorkspace;
  },

  /**
   * Load workspaces from API
   */
  async loadWorkspaces() {
    try {
      const response = await fetch('/api/workspaces', {
        credentials: 'include'
      });

      if (!response.ok) {
        console.error('[Workspace] Failed to load workspaces:', response.statusText);
        return;
      }

      const data = await response.json();
      this.workspaces = data.data || [];

      console.log(`[Workspace] Loaded ${this.workspaces.length} workspaces`);
    } catch (err) {
      console.error('[Workspace] Error loading workspaces:', err);
    }
  },

  /**
   * Switch to a different workspace
   */
  async switchWorkspace(slug) {
    console.log('[Workspace] Switching to:', slug);

    // Validate workspace exists
    const workspace = this.workspaces.find(w => w.slug === slug);
    if (!workspace) {
      console.error('[Workspace] Workspace not found:', slug);
      return false;
    }

    // Update current workspace
    this.currentWorkspace = slug;

    // Save to localStorage
    localStorage.setItem(this.STORAGE_KEY, slug);

    // Update UI
    this.updateUI();

    // Notify other modules (custom event)
    window.dispatchEvent(new CustomEvent('workspaceChanged', {
      detail: { slug, workspace }
    }));

    console.log('[Workspace] Switched to:', workspace.name);
    return true;
  },

  /**
   * Get current workspace object
   */
  getCurrentWorkspace() {
    return this.workspaces.find(w => w.slug === this.currentWorkspace);
  },

  /**
   * Get current workspace slug
   */
  getCurrentSlug() {
    return this.currentWorkspace;
  },

  /**
   * Add workspace query parameter to URL
   */
  addWorkspaceParam(url) {
    if (!this.currentWorkspace) return url;

    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}workspace=${this.currentWorkspace}`;
  },

  /**
   * Add workspace header to fetch options
   */
  addWorkspaceHeader(options = {}) {
    if (!this.currentWorkspace) return options;

    return {
      ...options,
      headers: {
        ...options.headers,
        'X-Workspace-Slug': this.currentWorkspace
      }
    };
  },

  /**
   * Update UI elements
   */
  updateUI() {
    // Update workspace dropdown button
    const btn = document.getElementById('workspaceDropdownBtn');
    const dropdown = document.getElementById('workspaceDropdownMenu');

    if (btn && this.currentWorkspace) {
      const workspace = this.getCurrentWorkspace();
      btn.innerHTML = `<i class="fas fa-building"></i> ${workspace ? workspace.name : 'Select Workspace'}`;
    }

    // Update dropdown menu
    if (dropdown && this.workspaces.length > 0) {
      dropdown.innerHTML = this.workspaces.map(w => {
        const active = w.slug === this.currentWorkspace ? ' active' : '';
        const icon = w.slug === this.currentWorkspace ? '<i class="fas fa-check"></i> ' : '';
        return `
          <a href="#" class="dropdown-item${active}" data-workspace="${w.slug}">
            ${icon}${w.name}
            ${w.description ? `<span class="workspace-desc">${w.description}</span>` : ''}
          </a>
        `;
      }).join('');

      // Add divider and settings link
      dropdown.innerHTML += `
        <div class="dropdown-divider"></div>
        <a href="workspace-settings.html" class="dropdown-item">
          <i class="fas fa-cog"></i> Workspace Settings
        </a>
      `;

      // Attach click handlers
      dropdown.querySelectorAll('.dropdown-item[data-workspace]').forEach(item => {
        item.addEventListener('click', async (e) => {
          e.preventDefault();
          const slug = item.dataset.workspace;
          await this.switchWorkspace(slug);

          // Reload current page to fetch workspace-specific data
          window.location.reload();
        });
      });
    }
  },

  /**
   * Create new workspace (opens modal or redirects)
   */
  async createWorkspace(data) {
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        throw new Error('Failed to create workspace');
      }

      const result = await response.json();

      // Reload workspaces
      await this.loadWorkspaces();

      // Switch to new workspace
      await this.switchWorkspace(result.data.slug);

      return result.data;
    } catch (err) {
      console.error('[Workspace] Error creating workspace:', err);
      throw err;
    }
  }
};

// Auto-initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WorkspaceManager.init());
} else {
  WorkspaceManager.init();
}

// Make available globally
window.WorkspaceManager = WorkspaceManager;
