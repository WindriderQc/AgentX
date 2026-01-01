/**
 * Prompts API Client
 * Wrapper for all prompt management API endpoints
 */

export class PromptsAPI {
  constructor(baseUrl = '/api/prompts') {
    this.baseUrl = baseUrl;
  }

  /**
   * List all prompts grouped by name
   * @returns {Promise<Object>} { status: 'success', data: { [name]: [versions] } }
   */
  async listAll() {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 401) {
        throw new Error('Authentication required');
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to list prompts:', error);
      throw error;
    }
  }

  /**
   * Get all versions of a specific prompt
   * @param {string} promptName - Name of the prompt
   * @returns {Promise<Array>} Array of prompt versions
   */
  async getByName(promptName) {
    try {
      const response = await fetch(`${this.baseUrl}/${encodeURIComponent(promptName)}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `HTTP ${response.status}`);
      }

      const result = await response.json();
      return result.data;
    } catch (error) {
      console.error(`Failed to get prompt ${promptName}:`, error);
      throw error;
    }
  }

  /**
   * Create new prompt or version
   * @param {Object} data - { name, systemPrompt, description?, isActive?, trafficWeight? }
   * @returns {Promise<Object>} Created prompt object
   */
  async create(data) {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: data.name?.trim(),
          systemPrompt: data.systemPrompt?.trim(),
          description: data.description?.trim(),
          author: data.author?.trim(),
          tags: data.tags || [],
          isActive: data.isActive ?? false,
          trafficWeight: data.trafficWeight ?? 100
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `HTTP ${response.status}`);
      }

      const result = await response.json();
      return result.data;
    } catch (error) {
      console.error('Failed to create prompt:', error);
      throw error;
    }
  }

  /**
   * Update prompt configuration
   * @param {string} promptId - Prompt ID
   * @param {Object} updates - { isActive?, trafficWeight?, description? }
   * @returns {Promise<Object>} Updated prompt object
   */
  async update(promptId, updates) {
    try {
      const response = await fetch(`${this.baseUrl}/${promptId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
      });

      if (response.status === 404) {
        throw new Error('Prompt not found');
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `HTTP ${response.status}`);
      }

      const result = await response.json();
      return result.data;
    } catch (error) {
      console.error(`Failed to update prompt ${promptId}:`, error);
      throw error;
    }
  }

  /**
   * Activate a prompt version
   * @param {string} promptId - Prompt ID
   * @returns {Promise<Object>} Updated prompt object
   */
  async activate(promptId) {
    return this.update(promptId, { isActive: true });
  }

  /**
   * Deactivate a prompt version
   * @param {string} promptId - Prompt ID
   * @returns {Promise<Object>} Updated prompt object
   */
  async deactivate(promptId) {
    return this.update(promptId, { isActive: false });
  }

  /**
   * Delete a prompt version
   * @param {string} promptId - Prompt ID
   * @returns {Promise<Object>} Success response
   */
  async delete(promptId) {
    try {
      const response = await fetch(`${this.baseUrl}/${promptId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 404) {
        throw new Error('Prompt not found');
      }

      if (response.status === 400) {
        const error = await response.json();
        throw new Error(error.message);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to delete prompt ${promptId}:`, error);
      throw error;
    }
  }

  /**
   * Configure A/B test for a prompt
   * @param {string} promptName - Prompt name
   * @param {Array} versions - [{ version: number, weight: number }]
   * @returns {Promise<Object>} A/B test configuration result
   */
  async configureABTest(promptName, versions) {
    // Validate weights sum to 100
    const totalWeight = versions.reduce((sum, v) => sum + v.weight, 0);
    if (totalWeight !== 100) {
      throw new Error(`Weights must sum to 100 (got ${totalWeight})`);
    }

    try {
      const response = await fetch(`${this.baseUrl}/${encodeURIComponent(promptName)}/ab-test`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ versions })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `HTTP ${response.status}`);
      }

      const result = await response.json();
      return result.data;
    } catch (error) {
      console.error(`Failed to configure A/B test for ${promptName}:`, error);
      throw error;
    }
  }

  /**
   * Render prompt template with variables
   * @param {string} promptName - Prompt name
   * @param {number} version - Prompt version (optional)
   * @param {Object} variables - Template variables
   * @returns {Promise<string>} Rendered prompt text
   */
  async renderTemplate(promptName, version, variables = {}) {
    try {
      const body = { name: promptName, variables };
      if (version) {
        body.version = version;
      }

      const response = await fetch(`${this.baseUrl}/render`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (response.status === 404) {
        throw new Error(`Prompt "${promptName}" not found`);
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `HTTP ${response.status}`);
      }

      const result = await response.json();
      return result.data.rendered;
    } catch (error) {
      console.error(`Failed to render template ${promptName}:`, error);
      throw error;
    }
  }

  /**
   * Handle API errors with user-friendly messages
   * @private
   */
  _handleError(error, operation) {
    const errorMessages = {
      'Authentication required': 'Please log in to manage prompts',
      'Prompt not found': 'The requested prompt no longer exists',
      'Cannot delete active prompt': 'Please deactivate the prompt before deleting'
    };

    return errorMessages[error.message] || error.message;
  }
}
