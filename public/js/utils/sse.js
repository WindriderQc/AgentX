/**
 * @module sse
 * Manages the Server-Sent Events (SSE) connection for real-time updates.
 */

/**
 * Initializes the SSE connection to the feed endpoint.
 *
 * @param {function} onNewEvent - A callback function that will be executed
 *   when a new event is received from the server. The parsed event data
 *   will be passed as the first argument.
 */
export const initFeed = (onNewEvent) => {
    // Try private (authenticated) feed first. If it fails (e.g., 401), fall back
    // to the public feed so anonymous users still get updates.
    const privateUrl = '/api/v1/feed/events/private';
    const publicUrl = '/api/v1/feed/events';

    const iconMap = {
        info: 'fa-info-circle',
        warning: 'fa-exclamation-triangle',
        error: 'fa-bell',
        success: 'fa-check-circle',
        user: 'fa-user',
        device: 'fa-share-alt',
        userLog: 'fa-eye'
    };

    const colorMap = {
        info: 'info',
        warning: 'warning',
        error: 'danger',
        success: 'success',
        user: 'primary',
        device: 'success',
        userLog: 'primary'
    };

    const timeAgo = (ts) => {
        const then = ts ? new Date(ts).getTime() : Date.now();
        const diff = Math.floor((Date.now() - then) / 1000);
        if (diff < 10) return 'just now';
        if (diff < 60) return `${diff}s ago`;
        const mins = Math.floor(diff / 60);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    const normalize = (raw) => {
        // If already formatted (has timeAgo/icon) return as-is
        if (raw && raw.timeAgo && raw.icon) return raw;

        const evt = raw || {};
        const type = evt.type || 'info';
        return {
            message: evt.message || (evt.msg || JSON.stringify(evt)),
            timestamp: evt.timestamp || evt.created || Date.now(),
            timeAgo: timeAgo(evt.timestamp || evt.created),
            icon: iconMap[type] || 'fa-info-circle',
            color: colorMap[type] || 'secondary'
        };
    };

    let connectedSource = null;

    const connect = (url, fallback = false) => {
        const es = new EventSource(url);

        es.onopen = () => {
            console.log(`SSE connected to ${url}`);
            connectedSource = es;
        };

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                const normalized = normalize(data);
                if (typeof onNewEvent === 'function') onNewEvent(normalized);
            } catch (error) {
                console.error('Error parsing SSE data:', error);
            }
        };

        es.onerror = (err) => {
            console.error(`EventSource error for ${url}:`, err);
            // If this was the private feed, try the public feed as a fallback.
            if (url === privateUrl && fallback) {
                try {
                    es.close();
                } catch (e) {}
                connect(publicUrl, false);
            }
        };

        return es;
    };

    // Start with private feed; on failure the code will attempt public feed.
    connect(privateUrl, true);
};