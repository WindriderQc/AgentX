/**
 * @fileoverview Workspace-aware API utilities for multi-tenancy support
 * 
 * This module provides utility functions and classes for making workspace-aware
 * API calls in AgentX. All functions automatically inject the X-Workspace-Slug
 * header based on the current workspace context from WorkspaceManager.
 * 
 * @module workspace-api
 * @requires window.WorkspaceManager - Global workspace manager instance
 * 
 * @example
 * // Using the wrapper functions
 * import { workspaceFetchJSON } from './utils/workspace-api.js';
 * const models = await workspaceFetchJSON('/api/models');
 * 
 * @example
 * // Using the WorkspaceApiClient class
 * import { WorkspaceApiClient } from './utils/workspace-api.js';
 * const client = new WorkspaceApiClient('/api');
 * const data = await client.get('/models');
 * 
 * @author AgentX Team
 * @version 1.0.0
 * @since 2026-01-07
 */

/**
 * Workspace-aware fetch wrapper that automatically injects workspace headers
 * 
 * This function wraps the native fetch() API and automatically adds the
 * X-Workspace-Slug header for multi-tenancy support. It ensures all API
 * calls are scoped to the current workspace context.
 * 
 * @async
 * @function workspaceFetch
 * @param {string} url - The URL to fetch (relative or absolute)
 * @param {RequestInit} [options={}] - Standard fetch options
 * @param {HeadersInit} [options.headers] - Additional headers to merge
 * @returns {Promise<Response>} The fetch Response object
 * @throws {Error} If WorkspaceManager is not available or fetch fails
 * 
 * @example
 * const response = await workspaceFetch('/api/models', {
 *   method: 'POST',
 *   body: JSON.stringify({ name: 'gpt-4' })
 * });
 * const data = await response.json();
 */
export async function workspaceFetch(url, options = {}) {
  // Ensure workspace context is added
  const wsOptions = window.WorkspaceManager
    ? window.WorkspaceManager.addWorkspaceHeader(options)
    : options;

  // Always include credentials
  wsOptions.credentials = wsOptions.credentials || 'include';

  return fetch(url, wsOptions);
}

/**
 * Workspace-aware fetch with JSON parsing
 * Handles response parsing and error handling automatically
 *
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @returns {Promise<any>} - Parsed JSON response
 */
export async function workspaceFetchJSON(url, options = {}) {
  const response = await workspaceFetch(url, options);

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      message: response.statusText
    }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Get current workspace headers
 * Returns object with X-Workspace-Slug header if workspace is selected
 *
 * @returns {object} Headers object with workspace context
 */
export function getWorkspaceHeaders() {
  if (!window.WorkspaceManager) {
    return {};
  }

  const slug = window.WorkspaceManager.getCurrentSlug();
  return slug ? { 'X-Workspace-Slug': slug } : {};
}

/**
 * Add workspace query parameter to URL
 * Legacy support - prefer using headers (addWorkspaceHeader)
 *
 * @param {string} url - Base URL
 * @returns {string} URL with workspace parameter
 */
export function addWorkspaceParam(url) {
  if (!window.WorkspaceManager) {
    return url;
  }

  return window.WorkspaceManager.addWorkspaceParam(url);
}

/**
 * Enhanced ApiClient with automatic workspace injection
 * Drop-in replacement for standard ApiClient with workspace awareness
 */
export class WorkspaceApiClient {
  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
  }

  /**
   * Make workspace-aware API request
   * Automatically injects workspace headers and handles errors
   *
   * @param {string} endpoint - API endpoint path
   * @param {object} options - Fetch options
   * @returns {Promise<any>} Parsed JSON response
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;

    // Add workspace headers
    const headers = {
      'Content-Type': 'application/json',
      ...getWorkspaceHeaders(),
      ...(options.headers || {})
    };

    const fetchOptions = {
      ...options,
      headers,
      credentials: 'include'
    };

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        message: response.statusText
      }));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * GET request with workspace context
   */
  async get(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;
    return this.request(url, { method: 'GET' });
  }

  /**
   * POST request with workspace context
   */
  async post(endpoint, body = {}) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  /**
   * PUT request with workspace context
   */
  async put(endpoint, body = {}) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  /**
   * PATCH request with workspace context
   */
  async patch(endpoint, body = {}) {
    return this.request(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
  }

  /**
   * DELETE request with workspace context
   */
  async delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }
}

// For non-module usage
if (typeof window !== 'undefined') {
  window.workspaceFetch = workspaceFetch;
  window.workspaceFetchJSON = workspaceFetchJSON;
  window.WorkspaceApiClient = WorkspaceApiClient;
}
