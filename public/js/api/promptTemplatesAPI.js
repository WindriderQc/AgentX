/**
 * Prompt Templates API Client
 * Wrapper for all prompt template CRUD operations
 */

class PromptTemplatesAPI {
  constructor(baseURL = '/api/prompt-templates') {
    this.baseURL = baseURL;
  }

  /**
   * Get authorization headers
   */
  getHeaders() {
    const token = localStorage.getItem('token');
    const headers = {
      'Content-Type': 'application/json'
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  /**
   * Handle API response
   */
  async handleResponse(response) {
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return data;
  }

  /**
   * List all templates
   * @param {Object} filters - Optional filters (category, search, sortBy, sortOrder)
   * @returns {Promise<Array>} - Array of templates
   */
  async list(filters = {}) {
    const params = new URLSearchParams();

    if (filters.category) params.append('category', filters.category);
    if (filters.search) params.append('search', filters.search);
    if (filters.sortBy) params.append('sortBy', filters.sortBy);
    if (filters.sortOrder) params.append('sortOrder', filters.sortOrder);

    const url = `${this.baseURL}?${params.toString()}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    const result = await this.handleResponse(response);
    return result.data;
  }

  /**
   * Get category statistics
   * @returns {Promise<Object>} - Category counts
   */
  async getCategoryStats() {
    const response = await fetch(`${this.baseURL}/categories/stats`, {
      method: 'GET',
      headers: this.getHeaders()
    });

    const result = await this.handleResponse(response);
    return result.data;
  }

  /**
   * Get single template by ID
   * @param {String} id - Template ID
   * @returns {Promise<Object>} - Template object
   */
  async get(id) {
    const response = await fetch(`${this.baseURL}/${id}`, {
      method: 'GET',
      headers: this.getHeaders()
    });

    const result = await this.handleResponse(response);
    return result.data;
  }

  /**
   * Create new template
   * @param {Object} templateData - Template data (name, template, category, description, tags)
   * @returns {Promise<Object>} - Created template
   */
  async create(templateData) {
    const response = await fetch(this.baseURL, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(templateData)
    });

    const result = await this.handleResponse(response);
    return result.data;
  }

  /**
   * Update template
   * @param {String} id - Template ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} - Updated template
   */
  async update(id, updates) {
    const response = await fetch(`${this.baseURL}/${id}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(updates)
    });

    const result = await this.handleResponse(response);
    return result.data;
  }

  /**
   * Delete template
   * @param {String} id - Template ID
   * @returns {Promise<Object>} - Success message
   */
  async delete(id) {
    const response = await fetch(`${this.baseURL}/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders()
    });

    return await this.handleResponse(response);
  }

  /**
   * Render template with variables
   * @param {String} id - Template ID
   * @param {Object} variables - Variable values for substitution
   * @returns {Promise<Object>} - Rendered template
   */
  async render(id, variables = {}) {
    const response = await fetch(`${this.baseURL}/${id}/render`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ variables })
    });

    const result = await this.handleResponse(response);
    return result.data;
  }

  /**
   * Duplicate template
   * @param {String} id - Template ID to duplicate
   * @returns {Promise<Object>} - Duplicated template
   */
  async duplicate(id) {
    const response = await fetch(`${this.baseURL}/${id}/duplicate`, {
      method: 'POST',
      headers: this.getHeaders()
    });

    const result = await this.handleResponse(response);
    return result.data;
  }

  /**
   * Extract placeholders from template text
   * Client-side helper to preview placeholders before saving
   * @param {String} template - Template string
   * @returns {Array<String>} - Array of placeholder names
   */
  extractPlaceholders(template) {
    if (!template || typeof template !== 'string') {
      return [];
    }

    const regex = /\{\{([\w.]+)\}\}/g;
    const matches = template.matchAll(regex);
    const found = new Set();

    for (const match of matches) {
      const varName = match[1];
      found.add(varName);
    }

    return Array.from(found).sort();
  }

  /**
   * Simple template renderer for client-side preview
   * @param {String} template - Template string
   * @param {Object} variables - Variable values
   * @returns {String} - Rendered template
   */
  renderLocal(template, variables = {}) {
    let rendered = template;

    // Handle simple {{variable}} substitution
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      rendered = rendered.replace(regex, variables[key] || '');
    });

    return rendered;
  }
}

// Export as singleton
const promptTemplatesAPI = new PromptTemplatesAPI();

// For ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = promptTemplatesAPI;
}
