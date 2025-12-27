// AgentX Dashboard UI Logic
import { API } from './utils/index.js';

// Health Check Logic
async function updateHealthStatus() {
    try {
        // Check local AgentX health
        const localHealth = await API.get('/health');
        const agentxDot = document.querySelector('#health-agentx .status-dot');
        if (agentxDot) {
            agentxDot.className = `status-dot status-${localHealth.status === 'ok' ? 'online' : 'offline'}`;
        }

        // Check external health for associated services (like Ollama)
        const externalHealth = await API.get('/api/health/external');

        const map = {
            ollama99: '#health-ollama99',
            ollama12: '#health-ollama12'
        };

        for (const [key, selector] of Object.entries(map)) {
            const dot = document.querySelector(`${selector} .status-dot`);
            if (dot) {
                dot.className = `status-dot status-${externalHealth[key] === 'online' ? 'online' : 'offline'}`;
            }
        }
    } catch (error) {
        console.error('Health check failed:', error);
    }
}

// Expose setup function for dynamic loading
window.setupDashboardInteractions = function () {
    const summaryCards = document.querySelectorAll('.summary-card');

    summaryCards.forEach(card => {
        card.addEventListener('click', function () {
            summaryCards.forEach(c => c.classList.remove('selected'));
            this.classList.add('selected');
        });
    });
};

document.addEventListener('DOMContentLoaded', async function () {
    // Start health polling
    updateHealthStatus();
    setInterval(updateHealthStatus, 30000); // Every 30 seconds

    // If cards are already present (dynamic load from HTML), setup interactions
    if (document.querySelectorAll('.summary-card').length > 0) {
        window.setupDashboardInteractions();
    }
});
