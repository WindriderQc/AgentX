/**
 * Unified API Client for AgentX Frontend
 * Handles authentication, error parsing, and common request patterns.
 */

class ApiClient {
    constructor(baseUrl = '/api') {
        this.baseUrl = baseUrl;
    }

    async request(endpoint, options = {}) {
        const url = endpoint.startsWith('/') ? endpoint : `${this.baseUrl}/${endpoint}`;

        const defaultHeaders = {
            'Content-Type': 'application/json'
        };

        const config = {
            ...options,
            headers: {
                ...defaultHeaders,
                ...options.headers
            },
            credentials: 'include' // Important for session cookies
        };

        if (options.body && typeof options.body === 'object') {
            config.body = JSON.stringify(options.body);
        }

        try {
            const response = await fetch(url, config);

            // Handle Unauthorized globally
            if (response.status === 401) {
                // If not already on login page
                if (!window.location.pathname.includes('/login.html')) {
                    window.location.href = `/login.html?redirect=${encodeURIComponent(window.location.pathname)}`;
                }
                throw new Error('Unauthorized');
            }

            const contentType = response.headers.get('content-type');
            let data;
            if (contentType && contentType.includes('application/json')) {
                data = await response.json();
            } else {
                data = await response.text();
            }

            if (!response.ok) {
                throw new Error(data.message || data.error || `Request failed with status ${response.status}`);
            }

            return data;

        } catch (error) {
            console.error(`API Request failed for ${url}:`, error);
            throw error;
        }
    }

    get(endpoint, params = {}) {
        let url = endpoint;
        if (Object.keys(params).length > 0) {
            const qs = new URLSearchParams(params).toString();
            url += `${url.includes('?') ? '&' : '?'}${qs}`;
        }
        return this.request(url, { method: 'GET' });
    }

    post(endpoint, body = {}) {
        return this.request(endpoint, { method: 'POST', body });
    }

    put(endpoint, body = {}) {
        return this.request(endpoint, { method: 'PUT', body });
    }

    delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    }
}

export const apiClient = new ApiClient();
export default apiClient;
