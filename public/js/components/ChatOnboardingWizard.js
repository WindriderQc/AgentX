/**
 * Chat Onboarding Wizard Component (Refactored)
 * Extends BaseOnboardingWizard for chat-specific setup
 */

import { BaseOnboardingWizard } from './BaseOnboardingWizard.js';

export class ChatOnboardingWizard extends BaseOnboardingWizard {
  constructor(toast) {
    super(toast, {
      totalSteps: 5,
      wizardId: 'chatOnboarding',
      title: 'Welcome to AgentX Chat',
      icon: 'fa-comments'
    });
  }

  /**
   * Initialize data when wizard opens
   */
  onOpen() {
    this.data = {
      chatPreferences: {
        promptName: 'default_chat',
        modelName: '',
        useRag: false
      },
      profileData: {
        about: '',
        customInstructions: ''
      },
      availablePrompts: [],
      availableModels: []
    };
  }

  /**
   * Step 1: Welcome Screen
   */
  renderStep1() {
    return `
      <div class="onboarding-step">
        <div class="step-icon"><i class="fas fa-comments"></i></div>
        <h3>Welcome to AgentX Chat!</h3>
        <p class="step-description">Your local AI assistant with memory, RAG, and multi-model support.</p>
        <ul class="feature-list">
          <li><i class="fas fa-check"></i> <strong>User Memory:</strong> Remembers your preferences and context</li>
          <li><i class="fas fa-check"></i> <strong>RAG Search:</strong> Answers based on your documents</li>
          <li><i class="fas fa-check"></i> <strong>Multiple Models:</strong> Choose the right AI for each task</li>
          <li><i class="fas fa-check"></i> <strong>Smart Prompts:</strong> A/B tested system prompts</li>
        </ul>
      </div>
    `;
  }

  /**
   * Step 2: Profile Setup
   */
  renderStep2() {
    return `
      <div class="onboarding-step">
        <div class="step-icon"><i class="fas fa-user"></i></div>
        <h3>Tell Us About Yourself</h3>
        <p class="step-description">Help the AI understand you better by sharing some context.</p>

        <div class="form-group">
          <label for="chatOnboardingAbout">About You</label>
          <textarea
            id="chatOnboardingAbout"
            class="form-control"
            rows="4"
            placeholder="I'm a developer working on...">${this.data.profileData.about}</textarea>
          <small>Share your role, interests, or any context you'd like the AI to know.</small>
        </div>

        <div class="form-group">
          <label for="chatOnboardingInstructions">Custom Instructions</label>
          <textarea
            id="chatOnboardingInstructions"
            class="form-control"
            rows="3"
            placeholder="Always be concise...">${this.data.profileData.customInstructions}</textarea>
          <small>How should the AI respond to you? (e.g., "Be concise", "Use code examples")</small>
        </div>
      </div>
    `;
  }

  /**
   * Step 3: Choose Your Setup
   */
  async renderStep3() {
    // Check if data is loaded
    const promptsLoaded = this.data.availablePrompts.length > 0;
    const modelsLoaded = this.data.availableModels.length > 0;

    if (!promptsLoaded || !modelsLoaded) {
      // Trigger load in background
      this.loadStep3Data();
      
      return `
        <div class="onboarding-step">
          <div class="step-icon"><i class="fas fa-sliders-h"></i></div>
          <h3>Choose Your Setup</h3>
          <p class="step-description">Select your preferred system prompt and model.</p>
          
          <div class="loading-placeholder" style="text-align: center; padding: 40px 20px; color: var(--muted);">
            <i class="fas fa-spinner fa-spin fa-2x"></i>
            <p style="margin-top: 15px;">Loading available options...</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="onboarding-step">
        <div class="step-icon"><i class="fas fa-sliders-h"></i></div>
        <h3>Choose Your Setup</h3>
        <p class="step-description">Select your preferred system prompt and model.</p>

        <div class="form-group">
          <label for="chatOnboardingPromptSelect">
            System Prompt <i class="fas fa-info-circle" title="Controls AI behavior and personality"></i>
          </label>
          <select id="chatOnboardingPromptSelect" class="form-control">
            ${this.data.availablePrompts.map(p => `
              <option value="${p.name}" ${p.name === 'default_chat' ? 'selected' : ''}>
                ${p.name} (v${p.latestVersion})${p.description ? ' - ' + p.description : ''}
              </option>
            `).join('')}
          </select>
          <small>Choose how the AI should behave. You can change this anytime in settings.</small>
        </div>

        <div class="form-group">
          <label for="chatOnboardingModelSelect">
            Default Model <i class="fas fa-info-circle" title="Which Ollama model to use"></i>
          </label>
          <select id="chatOnboardingModelSelect" class="form-control">
            ${this.data.availableModels.map(m => `
              <option value="${m.name}">${m.name}${m.size ? ' (' + m.size + ')' : ''}</option>
            `).join('')}
          </select>
          <small>Select the AI model. Different models have different capabilities.</small>
        </div>
      </div>
    `;
  }

  /**
   * Helper to load data for Step 3
   */
  async loadStep3Data() {
    try {
      const [prompts, models] = await Promise.all([
        this.fetchPrompts(),
        this.fetchModels()
      ]);
      
      this.data.availablePrompts = prompts;
      this.data.availableModels = models;
      
      // Re-render if still on step 3
      if (this.currentStep === 3) {
        this.renderStep();
      }
    } catch (error) {
      console.error('Error loading step 3 data:', error);
      if (this.toast) this.toast.error('Failed to load options. Using defaults.');
      
      // Set defaults to avoid stuck loading state
      this.data.availablePrompts = [{ name: 'default_chat', latestVersion: 1, description: 'Default system prompt' }];
      this.data.availableModels = [];
      
      if (this.currentStep === 3) {
        this.renderStep();
      }
    }
  }

  /**
   * Step 4: RAG Introduction
   */
  renderStep4() {
    return `
      <div class="onboarding-step">
        <div class="step-icon"><i class="fas fa-database"></i></div>
        <h3>RAG: Search Your Documents</h3>
        <p class="step-description">Enable RAG to search your ingested documents for context.</p>

        <div class="info-box">
          <i class="fas fa-info-circle"></i>
          <p>RAG stands for Retrieval-Augmented Generation. When enabled, the AI searches your document library before answering.</p>
        </div>

        <div class="form-group" style="display: flex; align-items: center; gap: 12px; margin-top: 1.5rem;">
          <label class="switch">
            <input type="checkbox" id="chatOnboardingEnableRag" ${this.data.chatPreferences.useRag ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
          <span style="font-weight: 500;">Enable RAG by default</span>
        </div>
      </div>
    `;
  }

  /**
   * Step 5: Completion
   */
  renderStep5() {
    return `
      <div class="onboarding-step">
        <div class="step-icon success"><i class="fas fa-check-circle"></i></div>
        <h3>You're All Set!</h3>
        <p class="step-description">Your chat interface is configured and ready to use.</p>

        <div class="next-steps">
          <h4>Next Steps:</h4>
          <ul>
            <li>Type a message below to start chatting</li>
            <li>Use the <i class="fas fa-cog"></i> config panel for advanced settings</li>
            <li>Visit <a href="/prompts.html">Prompts</a> to create custom system prompts</li>
            <li>Check <a href="/dashboard.html">Operations</a> for system health</li>
          </ul>
        </div>

        <div class="form-group" style="display: flex; align-items: center; gap: 12px; margin-top: 1rem;">
          <label class="switch">
            <input type="checkbox" id="chatOnboardingDontShowAgain">
            <span class="slider"></span>
          </label>
          <span style="font-weight: 500;">Don't show this tutorial again</span>
        </div>
      </div>
    `;
  }

  /**
   * Validate step before proceeding
   */
  async validateStep(stepNumber) {
    // No validation needed for most steps
    return true;
  }

  /**
   * Process step data
   */
  async processStep(stepNumber) {
    switch (stepNumber) {
      case 2:
        // Save profile data
        return await this.saveProfile();
      case 3:
        // Save prompt/model selections
        return this.savePreferences();
      case 4:
        // Save RAG preference
        return this.saveRagPreference();
      default:
        return true;
    }
  }

  /**
   * Save profile to backend
   */
  async saveProfile() {
    const about = document.getElementById('chatOnboardingAbout')?.value || '';
    const customInstructions = document.getElementById('chatOnboardingInstructions')?.value || '';

    // Store in data
    this.data.profileData = { about, customInstructions };

    // Skip if both empty
    if (!about.trim() && !customInstructions.trim()) {
      return true;
    }

    try {
      this.setButtonLoading('chatOnboardingNextBtn', true, 'Saving...');

      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          about,
          preferences: { customInstructions }
        })
      });

      const data = await response.json();

      if (data.status === 'success') {
        this.toast.success('Profile saved successfully!');
        return true;
      } else {
        throw new Error(data.message || 'Failed to save profile');
      }
    } catch (error) {
      console.error('Error saving profile:', error);
      this.toast.error('Failed to save profile: ' + error.message);
      return false;
    } finally {
      this.setButtonLoading('chatOnboardingNextBtn', false);
    }
  }

  /**
   * Save prompt/model preferences
   */
  savePreferences() {
    const promptSelect = document.getElementById('chatOnboardingPromptSelect');
    const modelSelect = document.getElementById('chatOnboardingModelSelect');

    if (promptSelect) {
      this.data.chatPreferences.promptName = promptSelect.value;
      localStorage.setItem('agentx_default_prompt', promptSelect.value);
    }

    if (modelSelect) {
      this.data.chatPreferences.modelName = modelSelect.value;
      localStorage.setItem('agentx_default_model', modelSelect.value);
    }

    return true;
  }

  /**
   * Save RAG preference
   */
  saveRagPreference() {
    const ragCheckbox = document.getElementById('chatOnboardingEnableRag');
    if (ragCheckbox) {
      this.data.chatPreferences.useRag = ragCheckbox.checked;
      localStorage.setItem('agentx_default_use_rag', ragCheckbox.checked ? 'true' : 'false');
    }
    return true;
  }

  /**
   * Final actions on wizard completion
   */
  async onFinish() {
    // Apply preferences to chat interface if elements exist
    this.applyPreferences();

    // Show completion message
    this.toast.success('Welcome to AgentX! Start chatting below.');

    // Trigger setup checks if available
    if (window.checkProfileSetup) window.checkProfileSetup();
    if (window.checkSetupProgress) window.checkSetupProgress();
  }

  /**
   * Apply saved preferences to chat interface
   */
  applyPreferences() {
    // Apply prompt selection
    const promptSelect = document.getElementById('promptSelect');
    if (promptSelect && this.data.chatPreferences.promptName) {
      promptSelect.value = this.data.chatPreferences.promptName;
    }

    // Apply model selection
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect && this.data.chatPreferences.modelName) {
      modelSelect.value = this.data.chatPreferences.modelName;
    }

    // Apply RAG toggle
    const ragToggle = document.getElementById('ragToggle');
    if (ragToggle) {
      ragToggle.checked = this.data.chatPreferences.useRag;
    }
  }

  /**
   * Fetch available prompts from API
   */
  async fetchPrompts() {
    try {
      const response = await fetch('/api/prompts');
      if (!response.ok) throw new Error('Failed to fetch prompts');
      const data = await response.json();

      // Transform grouped prompts into flat list
      return Object.entries(data.data?.prompts || data.data || {}).map(([name, versions]) => ({
        name,
        latestVersion: Array.isArray(versions) ? Math.max(...versions.map(v => v.version)) : 1,
        description: Array.isArray(versions) ? versions[0]?.description : ''
      }));
    } catch (error) {
      console.error('Error fetching prompts:', error);
      return [{ name: 'default_chat', latestVersion: 1, description: 'Default system prompt' }];
    }
  }

  /**
   * Fetch available models from Ollama
   */
  async fetchModels() {
    try {
      const response = await fetch('/api/ollama-hosts/proxy/tags');
      if (!response.ok) throw new Error('Failed to fetch models');
      const data = await response.json();

      return (data.models || []).map(m => ({
        name: m.name,
        size: m.size ? this.formatBytes(m.size) : null
      }));
    } catch (error) {
      console.error('Error fetching models:', error);
      return [];
    }
  }

  /**
   * Format bytes to human-readable size
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
}
