/**
 * Navigation Component
 * Injects the standard AgentX navigation bar with all pages.
 * Also handles auth state: checks /api/auth/me and shows login/logout in nav.
 *
 * Usage: injectNav('activePageId') where activePageId is one of:
 * 'chat', 'operations', 'self-healing', 'alerts', 'backup', 'models', 'benchmark', 'courthouse',
 * 'performance', 'analytics', 'features-inventory', 'features-telemetry',
 * 'features-adoption', 'features-admin', 'feature-alignment', 'workspaces', 'audit-logs', 'rag', 'personas', 'profile',
 * 'results-explorer', 'model-explorer', 'leaderboard', 'hardware-matrix', 'config-optimizer', 'docjanitor'
 */

// Global auth state — accessible by all pages via window.AgentXAuth
window.AgentXAuth = { user: null, isAuthenticated: false, checked: false };

async function checkNavAuth() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            if (data.status === 'success' && data.user) {
                window.AgentXAuth = { user: data.user, isAuthenticated: true, checked: true };
                updateNavAuthUI();
                return;
            }
        }
    } catch (e) {
        // Auth check failed — treat as not authenticated
    }
    window.AgentXAuth = { user: null, isAuthenticated: false, checked: true };
    updateNavAuthUI();
}

function updateNavAuthUI() {
    const authArea = document.getElementById('nav-auth-area');
    if (!authArea) return;

    if (window.AgentXAuth.isAuthenticated) {
        const user = window.AgentXAuth.user;
        const name = user.name || user.email || 'User';
        authArea.innerHTML = `
            <span class="nav-user-name">${name.replace(/</g, '&lt;')}</span>
            <button id="navLogoutBtn" class="nav-link" title="Logout">
                <i class="fas fa-sign-out-alt"></i>
            </button>`;
        document.getElementById('navLogoutBtn').addEventListener('click', async () => {
            try {
                await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
            } catch (e) { /* ignore */ }
            localStorage.removeItem('user');
            window.location.href = '/login.html';
        });
    } else {
        authArea.innerHTML = `
            <a href="/login.html" class="nav-link" title="Login">
                <i class="fas fa-sign-in-alt"></i> Login
            </a>`;
    }
}

function injectNav(activePageId = '') {
    const navStructure = [
        { label: 'Chat', href: 'index.html', icon: 'fa-comments', id: 'chat' },
        {
            label: 'Agent', icon: 'fa-robot', id: 'grp-agent',
            children: [
                { label: 'Models', href: 'models.html', icon: 'fa-cube', id: 'models' },
                { label: 'RAG', href: 'rag.html', icon: 'fa-database', id: 'rag' },
                { label: 'Prompts', href: 'prompts.html', icon: 'fa-users', id: 'personas' },
                { label: 'Benchmark', href: 'benchmark.html', icon: 'fa-rocket', id: 'benchmark' },
                { label: 'Courthouse', href: 'courthouse.html', icon: 'fa-balance-scale', id: 'courthouse' },
                { label: 'Compare Insights', href: 'compare-insights.html', icon: 'fa-chart-radar', id: 'compare-insights' },
                { label: 'Config Optimizer', href: 'config-optimizer.html', icon: 'fa-sliders-h', id: 'config-optimizer' },
                { label: 'Model Explorer', href: 'model-explorer.html', icon: 'fa-microscope', id: 'model-explorer' },
                { label: 'Results Explorer', href: 'results-explorer.html', icon: 'fa-magnifying-glass-chart', id: 'results-explorer' },
                { label: 'Leaderboard', href: 'leaderboard.html', icon: 'fa-trophy', id: 'leaderboard' },
                { label: 'Hardware Matrix', href: 'hardware-matrix.html', icon: 'fa-server', id: 'hardware-matrix' }
            ]
        },
        {
            label: 'Monitor', icon: 'fa-heart-pulse', id: 'grp-monitor',
            children: [
                { label: 'Operations', href: 'dashboard.html', icon: 'fa-tachometer-alt', id: 'operations' },
                { label: 'DocJanitor', href: 'docjanitor.html', icon: 'fa-broom', id: 'docjanitor' },
                { label: 'Self-Healing', href: 'self-healing.html', icon: 'fa-heart-pulse', id: 'self-healing' },
                { label: 'Alerts', href: 'alerts.html', icon: 'fa-bell', id: 'alerts' },
                { label: 'Performance', href: 'performance.html', icon: 'fa-gauge-high', id: 'performance' },
                { label: 'Analytics', href: 'analytics.html', icon: 'fa-chart-line', id: 'analytics' },
                { label: 'Cost', href: 'cost-tracking.html', icon: 'fa-dollar-sign', id: 'cost-tracking' }
            ]
        },
        {
            label: 'Features', icon: 'fa-list-check', id: 'grp-feat',
            children: [
                { label: 'Inventory', href: 'features-inventory.html', icon: 'fa-list-check', id: 'features-inventory' },
                { label: 'Telemetry', href: 'features-telemetry.html', icon: 'fa-chart-bar', id: 'features-telemetry' },
                { label: 'Adoption', href: 'features-adoption.html', icon: 'fa-users', id: 'features-adoption' },
                { label: 'Alignment', href: 'feature-alignment.html', icon: 'fa-diagram-project', id: 'feature-alignment' },
                { label: 'Admin', href: 'features-admin.html', icon: 'fa-cogs', id: 'features-admin' }
            ]
        },
        {
            label: 'System', icon: 'fa-server', id: 'grp-sys',
            children: [
                { label: 'Workspaces', href: 'workspace-settings.html', icon: 'fa-building', id: 'workspaces' },
                { label: 'Audit Logs', href: 'workspace-audit.html', icon: 'fa-history', id: 'audit-logs' },
                { label: 'Backup', href: 'backup.html', icon: 'fa-shield-alt', id: 'backup' }
            ]
        },
        { label: 'Profile', href: 'profile.html', icon: 'fa-user-circle', id: 'profile' }
    ];

    // CSS for Dropdowns
    const style = document.createElement('style');
    style.textContent = `
        /* Parent container override to ensure overflow visibility */
        #nav-container {
            position: sticky !important; /* Use sticky so it pushes content down */
            top: 0;
            width: 100%;
            overflow: visible !important;
            z-index: 9000 !important; /* Ensure it stays on top */
        }

        .top-nav {
            background: rgba(13, 17, 23, 0.95);
            backdrop-filter: blur(12px);
            border-bottom: 1px solid rgba(255,255,255,0.06);
            height: 64px;
            display: flex;
            align-items: center;
            padding: 0 24px;
            width: 100%;
            /* Removed duplicate fixed positioning, handled by #nav-container */
            justify-content: space-between;
            overflow: visible !important; /* Ensure dropdowns can escape */
        }
        .nav-left { display: flex; align-items: center; gap: 20px; }
        .nav-right { 
            display: flex; 
            align-items: center; 
            gap: 4px; 
            height: 100%; 
            position: relative; 
            overflow: visible !important; /* Ensure dropdowns can escape */
        }
        
        .nav-item {
            position: relative;
            height: 100%;
            display: flex;
            align-items: center;
        }
        
        .nav-link {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            color: #94a3b8;
            text-decoration: none;
            border-radius: 8px;
            transition: all 0.2s;
            font-size: 14px;
            font-weight: 500;
            white-space: nowrap;
            cursor: pointer;
            background: none;
            border: none;
            height: 40px;
        }
        .nav-link:hover, .nav-item:hover > .nav-link { 
            color: #fff; 
            background: rgba(255,255,255,0.05); 
        }
        .nav-link.active, .nav-item.open > .nav-link { 
            color: #7cf0ff; 
            background: rgba(124, 240, 255, 0.1); 
        }
        
        /* Dropdown */
        .nav-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            background: #1e293b;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
            min-width: 200px;
            padding: 8px;
            display: none; /* Force hidden by default */
            z-index: 10000; /* Super high z-index */
            margin-top: 8px; /* Slight gap */
        }
        
        .nav-item:hover .nav-dropdown,
        .nav-item.open .nav-dropdown {
            display: block; /* Force visible on interaction */
            animation: fadeIn 0.2s ease-out;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* Adjust last 2 dropdowns to align right to prevent overflow */
        .nav-item:nth-last-child(-n+2) .nav-dropdown {
            left: auto;
            right: 0;
        }
        
        .dropdown-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            color: #cbd5e1;
            text-decoration: none;
            border-radius: 8px;
            transition: all 0.2s;
            font-size: 13px;
        }
        .dropdown-item:hover {
            background: rgba(255,255,255,0.05);
            color: #fff;
            transform: translateX(4px);
        }
        .dropdown-item.active {
            color: #7cf0ff;
            background: rgba(124, 240, 255, 0.05);
        }
        .dropdown-item i { width: 16px; text-align: center; }

        /* Workspace Switcher Override */
        .workspace-btn {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            color: #e2e8f0;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .workspace-btn:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.2); }

        /* Auth area in nav */
        .nav-auth-area {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-left: 8px;
            padding-left: 12px;
            border-left: 1px solid rgba(255,255,255,0.08);
        }
        .nav-user-name {
            color: #e2e8f0;
            font-size: 13px;
            font-weight: 500;
            max-width: 120px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
    `;
    document.head.appendChild(style);

    // Build nav HTML
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

    navStructure.forEach(item => {
        if (item.children) {
            // Group with Dropdown
            // Check if any child is active
            const isGroupActive = item.children.some(child => child.id === activePageId);
            const activeClass = isGroupActive ? ' active' : '';
            
            navHTML += `
            <div class="nav-item">
                <button class="nav-link${activeClass}">
                    <i class="fas ${item.icon}"></i> ${item.label} <i class="fas fa-angle-down" style="font-size: 10px; margin-left: 4px; opacity: 0.5;"></i>
                </button>
                <div class="nav-dropdown">
                    ${item.children.map(child => {
                        const childActive = (child.id === activePageId) ? ' active' : '';
                        return `<a href="${child.href}" class="dropdown-item${childActive}"><i class="fas ${child.icon}"></i> ${child.label}</a>`;
                    }).join('')}
                </div>
            </div>`;
        } else {
            // Single Link
            const activeClass = (activePageId === item.id) ? ' active' : '';
            navHTML += `
            <div class="nav-item">
                <a href="${item.href}" class="nav-link${activeClass}">
                    <i class="fas ${item.icon}"></i> ${item.label}
                </a>
            </div>`;
        }
    });

    // Auth area (login/logout)
    navHTML += '    <div id="nav-auth-area" class="nav-auth-area"></div>\n';
    navHTML += '  </div>\n';
    navHTML += '  </nav>';

    // Find the nav container and inject
    const navContainer = document.getElementById('nav-container');
    if (navContainer) {
        navContainer.innerHTML = navHTML;

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

        // Add dropdown click handlers
        const navItems = navContainer.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            const btn = item.querySelector('button.nav-link');
            if (btn) {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // Close other opened menus
                    navItems.forEach(other => {
                        if (other !== item) other.classList.remove('open');
                    });
                    
                    item.classList.toggle('open');
                });
            }
        });

        // Close dropdowns when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.nav-item')) {
                navItems.forEach(item => item.classList.remove('open'));
            }
        });

    } else {
        console.error('nav.js: #nav-container element not found. Add <div id="nav-container"></div> to your HTML.');
    }

    // Check auth state and update nav
    checkNavAuth();
}

// Make function available globally (not using ES6 modules since pages don't use module imports)
window.injectNav = injectNav;
