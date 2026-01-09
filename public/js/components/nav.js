/**
 * Navigation Component
 * Injects the standard AgentX navigation bar with all pages.
 * Usage: injectNav('activePageId') where activePageId is one of:
 * 'chat', 'operations', 'self-healing', 'alerts', 'backup', 'models', 'benchmark',
 * 'performance', 'analytics', 'custom-dashboards', 'features-inventory', 'features-telemetry',
 * 'features-adoption', 'features-admin', 'feature-alignment', 'workspaces', 'audit-logs', 'rag', 'personas', 'profile'
 */

function injectNav(activePageId = '') {
    // Define all navigation items in order
    const navItems = [
        { label: 'Chat', href: 'index.html', icon: 'fa-comments', id: 'chat' },
        { label: 'Operations', href: 'dashboard.html', icon: 'fa-tachometer-alt', id: 'operations' },
        { label: 'Self-Healing', href: 'self-healing.html', icon: 'fa-heart-pulse', id: 'self-healing' },
        { label: 'Alerts', href: 'alerts.html', icon: 'fa-bell', id: 'alerts' },
        { label: 'Backup', href: 'backup.html', icon: 'fa-shield-alt', id: 'backup' },
        { label: 'Models', href: 'models.html', icon: 'fa-cube', id: 'models' },
        { label: 'Benchmark', href: 'benchmark.html', icon: 'fa-rocket', id: 'benchmark' },
        { label: 'Performance', href: 'performance.html', icon: 'fa-gauge-high', id: 'performance' },
        { label: 'Analytics', href: 'analytics.html', icon: 'fa-chart-line', id: 'analytics' },
        { label: 'Cost', href: 'cost-tracking.html', icon: 'fa-dollar-sign', id: 'cost-tracking' },
        { label: 'Dashboards', href: 'custom-dashboard.html', icon: 'fa-columns', id: 'custom-dashboards' },
        { label: 'Dashboard Builder', href: 'dashboard-builder.html', icon: 'fa-layer-group', id: 'dashboard-builder' },
        { label: 'Features', href: 'features-inventory.html', icon: 'fa-list-check', id: 'features-inventory' },
        { label: 'Telemetry', href: 'features-telemetry.html', icon: 'fa-chart-bar', id: 'features-telemetry' },
        { label: 'Adoption', href: 'features-adoption.html', icon: 'fa-users', id: 'features-adoption' },
        { label: 'Admin', href: 'features-admin.html', icon: 'fa-cogs', id: 'features-admin' },
        { label: 'Alignment', href: 'feature-alignment.html', icon: 'fa-diagram-project', id: 'feature-alignment' },
        { label: 'Workspaces', href: 'workspace-settings.html', icon: 'fa-building', id: 'workspaces' },
        { label: 'Audit Logs', href: 'workspace-audit.html', icon: 'fa-history', id: 'audit-logs' },
        { label: 'RAG', href: 'rag.html', icon: 'fa-database', id: 'rag' },
        // Prompt management UI lives at prompts.html.
        { label: 'Prompts', href: 'prompts.html', icon: 'fa-users', id: 'personas' },
        { label: 'Profile', href: 'profile.html', icon: 'fa-user-circle', id: 'profile' }
    ];

    // Build nav HTML with workspace switcher (Week 4 Day 3: Multi-Tenancy UI)
    let navHTML = '<nav class="top-nav">\n';

    // Add workspace dropdown button (left side)
    navHTML += `
        <div class="nav-left">
            <div class="workspace-dropdown">
                <button id="workspaceDropdownBtn" class="workspace-btn">
                    <i class="fas fa-building"></i> Loading...
                </button>
                <div id="workspaceDropdownMenu" class="dropdown-menu">
                    <!-- Workspaces will be populated by workspace.js -->
                </div>
            </div>
        </div>
    `;

    // Add navigation links (right side)
    navHTML += '<div class="nav-right">\n';

    navItems.forEach(item => {
        const activeClass = (activePageId === item.id) ? ' class="active"' : '';
        navHTML += `    <a href="${item.href}"${activeClass}><i class="fas ${item.icon}"></i> <span class="label-text">${item.label}</span></a>\n`;
    });

    navHTML += '  </div>\n';
    navHTML += '  </nav>';

    // Find the nav container and inject
    const navContainer = document.getElementById('nav-container');
    if (navContainer) {
        navContainer.innerHTML = navHTML;

        // The nav uses position: fixed, so it does not take up space in normal flow.
        // Reserve the correct amount of space at the top of the page so content never
        // renders under the nav (common regression when creating new pages).
        const updateNavContainerHeight = () => {
            const navEl = navContainer.querySelector('nav.top-nav');
            if (!navEl) return;
            navContainer.style.height = `${navEl.offsetHeight}px`;
        };

        updateNavContainerHeight();
        window.addEventListener('resize', () => {
            window.requestAnimationFrame(updateNavContainerHeight);
        });
        window.addEventListener('load', updateNavContainerHeight);
    } else {
        console.error('nav.js: #nav-container element not found. Add <div id="nav-container"></div> to your HTML.');
    }
}

// Make function available globally (not using ES6 modules since pages don't use module imports)
window.injectNav = injectNav;
