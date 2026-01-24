// ===============================================
// EXECUTION TIMELINE COMPONENT
// Displays execution progress and timeline visualization
// ===============================================

class ExecutionTimeline {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.events = [];
        this.isRunning = false;
        this.startTime = null;
    }

    init() {
        if (!this.container) return;
        this.render();
    }

    addEvent(eventName, status = 'pending', details = {}) {
        this.events.push({
            name: eventName,
            status, // 'pending', 'running', 'complete', 'error'
            timestamp: Date.now(),
            details,
            duration: 0
        });
        this.render();
    }

    updateEvent(index, status, details = {}) {
        if (this.events[index]) {
            const event = this.events[index];
            const previousStatus = event.status;
            event.status = status;
            event.details = { ...event.details, ...details };
            
            if (previousStatus === 'running' && status === 'complete') {
                event.duration = Date.now() - event.timestamp;
            }
            this.render();
        }
    }

    start(timelineTitle = 'Execution Timeline') {
        this.isRunning = true;
        this.startTime = Date.now();
        this.events = [];
        if (this.container) {
            this.container.innerHTML = '';
        }
    }

    stop() {
        this.isRunning = false;
    }

    render() {
        if (!this.container) return;

        const timeline = document.createElement('div');
        timeline.className = 'execution-timeline';
        timeline.style.cssText = `
            padding: 15px;
            background: rgba(0, 0, 0, 0.1);
            border-radius: 8px;
            font-family: monospace;
            font-size: 0.9rem;
        `;

        this.events.forEach((event, idx) => {
            const eventEl = document.createElement('div');
            eventEl.style.cssText = `
                margin-bottom: 10px;
                padding: 8px 12px;
                background: rgba(255, 255, 255, 0.05);
                border-left: 3px solid ${this.getStatusColor(event.status)};
                border-radius: 4px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            `;

            const statusIcon = this.getStatusIcon(event.status);
            const durationStr = event.duration > 0 ? ` (${event.duration}ms)` : '';
            
            eventEl.innerHTML = `
                <span>${statusIcon} ${event.name}${durationStr}</span>
                <span style="font-size: 0.8rem; color: #aaa;">${event.status}</span>
            `;

            timeline.appendChild(eventEl);
        });

        this.container.innerHTML = '';
        this.container.appendChild(timeline);
    }

    getStatusColor(status) {
        const colors = {
            pending: '#666',
            running: '#4a90e2',
            complete: '#2ecc71',
            error: '#e74c3c'
        };
        return colors[status] || '#666';
    }

    getStatusIcon(status) {
        const icons = {
            pending: '⏳',
            running: '⚙️',
            complete: '✅',
            error: '❌'
        };
        return icons[status] || '•';
    }

    clear() {
        this.events = [];
        this.isRunning = false;
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExecutionTimeline;
}
