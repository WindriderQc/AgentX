/**
 * Navigation Component
 * Injects the standard AgentX navigation bar with all pages.
 * Usage: injectNav('activePageId') where activePageId is one of:
 * 'chat', 'operations', 'alerts', 'n8n', 'benchmark', 'analytics', 'rag', 'personas', 'profile'
 */

function injectNav(activePageId = '') {
    // Define all navigation items in order
    const navItems = [
        { label: 'Chat', href: 'index.html', icon: 'fa-comments', id: 'chat' },
        { label: 'Operations', href: 'dashboard.html', icon: 'fa-tachometer-alt', id: 'operations' },
        { label: 'Alerts', href: 'alerts.html', icon: 'fa-bell', id: 'alerts' },
        { label: 'n8n Monitor', href: 'n8n-monitor.html', icon: 'fa-network-wired', id: 'n8n' },
        { label: 'Backup', href: 'backup.html', icon: 'fa-shield-alt', id: 'backup' },
        { label: 'Models', href: 'models.html', icon: 'fa-cube', id: 'models' },
        { label: 'Benchmark', href: 'benchmark.html', icon: 'fa-rocket', id: 'benchmark' },
        { label: 'Analytics', href: 'analytics.html', icon: 'fa-chart-line', id: 'analytics' },
        { label: 'RAG', href: 'rag.html', icon: 'fa-database', id: 'rag' },
        // Prompt management UI lives at prompts.html.
        { label: 'Prompts', href: 'prompts.html', icon: 'fa-users', id: 'personas' },
        { label: 'Profile', href: 'profile.html', icon: 'fa-user-circle', id: 'profile' }
    ];

    // Build nav HTML
    let navHTML = '<nav class="top-nav">\n';

    navItems.forEach(item => {
        const activeClass = (activePageId === item.id) ? ' class="active"' : '';
        navHTML += `    <a href="${item.href}"${activeClass}><i class="fas ${item.icon}"></i> ${item.label}</a>\n`;
    });

    navHTML += '  </nav>';

    // Find the nav container and inject
    const navContainer = document.getElementById('nav-container');
    if (navContainer) {
        navContainer.innerHTML = navHTML;
    } else {
        console.error('nav.js: #nav-container element not found. Add <div id="nav-container"></div> to your HTML.');
    }
}

// Make function available globally (not using ES6 modules since pages don't use module imports)
window.injectNav = injectNav;
