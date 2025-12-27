/**
 * Navigation Component
 * Injects the standard AgentX navigation bar into the header.
 */

export function injectNav(activePage = '') {
    const navContainer = document.querySelector('.agentx-nav') || createNavContainer();

    // Define navigation items
    const navItems = [
        { label: 'Chat', href: '/', id: 'chat' },
        { label: 'Analytics', href: '/analytics.html', id: 'analytics' },
        { label: 'Dashboard', href: '/dashboard.html', id: 'dashboard' }
    ];

    let html = '';
    navItems.forEach(item => {
        const isActive = activePage === item.id || window.location.pathname === item.href;
        const activeClass = isActive ? 'active' : '';
        html += `<a href="${item.href}" class="${activeClass}">${item.label}</a>`;
    });

    navContainer.innerHTML = html;

    // Ensure styles are present if not already loaded (basic fallback)
    if (!document.getElementById('nav-styles')) {
        const style = document.createElement('style');
        style.id = 'nav-styles';
        style.textContent = `
            .agentx-nav {
                display: flex;
                gap: 1.5rem;
                align-items: center;
            }
            .agentx-nav a {
                color: #94a3b8;
                text-decoration: none;
                font-family: 'Space Grotesk', system-ui, sans-serif;
                font-size: 0.95rem;
                transition: color 0.2s ease;
            }
            .agentx-nav a:hover {
                color: #e2e8f0;
            }
            .agentx-nav a.active {
                color: #7cf0ff;
                font-weight: 600;
                text-shadow: 0 0 10px rgba(124, 240, 255, 0.3);
            }
        `;
        document.head.appendChild(style);
    }
}

function createNavContainer() {
    // If no .agentx-nav exists, try to find a suitable header to append to
    const header = document.querySelector('header');
    if (header) {
        const nav = document.createElement('nav');
        nav.className = 'agentx-nav';
        // Try to insert after the title/brand
        const brand = header.querySelector('div') || header.firstElementChild;
        if (brand) {
            brand.parentNode.insertBefore(nav, brand.nextSibling);
        } else {
            header.appendChild(nav);
        }
        return nav;
    }
    return null; // Should not happen if HTML structure is correct
}
