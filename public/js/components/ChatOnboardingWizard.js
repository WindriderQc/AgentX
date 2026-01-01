/**
 * Chat Onboarding Wizard Component
 * Multi-step wizard to guide first-time users through chat interface setup
 */

export class ChatOnboardingWizard {
  constructor(toast) {
    this.toast = toast;
    this.currentStep = 1;
    this.totalSteps = 5;
    this.chatPreferences = {
      promptName: 'default_chat',
      modelName: '',
      useRag: false
    };
    this.profileData = {
      about: '',
      customInstructions: ''
    };
    this.overlay = null;
    this.isOpen = false;
    this.availablePrompts = [];
    this.availableModels = [];
  }

  /**
   * Open the wizard
   */
  open() {
    if (this.isOpen) return;

    this.currentStep = 1;
    this.chatPreferences = {
      promptName: 'default_chat',
      modelName: '',
      useRag: false
    };
    this.profileData = {
      about: '',
      customInstructions: ''
    };

    this.render();
    this.isOpen = true;
  }

  /**
   * Close the wizard
   */
  close() {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.isOpen = false;
  }

  /**
   * Mark wizard as completed (won't auto-show again)
   */
  markCompleted() {
    localStorage.setItem('agentx_chat_onboarding_completed', 'true');
  }

  /**
   * Check if user has completed chat onboarding
   */
  static isCompleted() {
    return localStorage.getItem('agentx_chat_onboarding_completed') === 'true';
  }

  /**
   * Reset onboarding status (for testing or re-onboarding)
   */
  static reset() {
    localStorage.removeItem('agentx_chat_onboarding_completed');
    localStorage.removeItem('agentx_chat_onboarding_seen');
  }

  /**
   * Render the wizard
   */
  render() {
    // Create overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay onboarding-overlay';
    this.overlay.innerHTML = `
      <div class="modal-container onboarding-modal">
        <div class="modal-header">
          <h2>
            <i class="fas fa-comments"></i>
            Welcome to AgentX Chat
          </h2>
          <button class="modal-close" id="chatOnboardingSkip" title="Skip Tutorial">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="onboarding-progress">
          <div class="progress-bar">
            <div class="progress-fill" id="chatOnboardingProgress"></div>
          </div>
          <div class="progress-text">
            Step <span id="chatCurrentStepNum">1</span> of ${this.totalSteps}
          </div>
        </div>

        <div class="modal-body" id="chatOnboardingBody">
          <!-- Step content will be injected here -->
        </div>

        <div class="modal-footer" id="chatOnboardingFooter">
          <!-- Navigation buttons will be injected here -->
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    // Attach event listeners
    document.getElementById('chatOnboardingSkip').addEventListener('click', () => {
      this.handleSkip();
    });

    // Render current step
    this.renderStep();
  }

  /**
   * Update progress bar
   */
  updateProgress() {
    const progress = (this.currentStep / this.totalSteps) * 100;
    const progressBar = document.getElementById('chatOnboardingProgress');
    const stepNum = document.getElementById('chatCurrentStepNum');

    if (progressBar) {
      progressBar.style.width = `${progress}%`;
    }
    if (stepNum) {
      stepNum.textContent = this.currentStep;
    }
  }

  /**
   * Render current step content
   */
  async renderStep() {
    const body = document.getElementById('chatOnboardingBody');
    const footer = document.getElementById('chatOnboardingFooter');

    if (!body || !footer) return;

    // Show loading for steps that need data
    if (this.currentStep === 3 && this.availablePrompts.length === 0) {
      body.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
      await this.fetchPrompts();
      await this.fetchModels();
    }

    // Render step content
    switch (this.currentStep) {
      case 1:
        body.innerHTML = this.renderStep1();
        break;
      case 2:
        body.innerHTML = this.renderStep2();
        break;
      case 3:
        body.innerHTML = this.renderStep3();
        break;
      case 4:
        body.innerHTML = this.renderStep4();
        break;
      case 5:
        body.innerHTML = this.renderStep5();
        break;
    }

    // Render navigation buttons
    footer.innerHTML = this.renderNavigation();

    // Update progress bar
    this.updateProgress();

    // Attach step-specific event listeners
    this.attachStepListeners();
  }

  /**
   * Step 1: Welcome
   */
  renderStep1() {
    return `
      <div class="onboarding-step step-welcome">
        <div class="step-icon">
          <i class="fas fa-rocket"></i>
        </div>
        <h3>Welcome to AgentX Chat!</h3>
        <p class="step-description">
          Your local AI assistant with powerful features. Let's get you set up in just a few minutes!
        </p>
        <ul class="feature-list">
          <li>
            <i class="fas fa-check-circle"></i>
            <strong>User Memory:</strong> The AI remembers your preferences and context
          </li>
          <li>
            <i class="fas fa-check-circle"></i>
            <strong>RAG Search:</strong> Get answers based on your documents
          </li>
          <li>
            <i class="fas fa-check-circle"></i>
            <strong>Multiple Models:</strong> Choose the right AI for each task
          </li>
          <li>
            <i class="fas fa-check-circle"></i>
            <strong>Smart Prompts:</strong> A/B tested system prompts for optimal performance
          </li>
        </ul>
        <p class="step-note">
          <i class="fas fa-info-circle"></i>
          This will only take a few minutes, and you can skip at any time.
        </p>
      </div>
    `;
  }

  /**
   * Step 2: User Profile Setup (REUSED from OnboardingWizard)
   */
  renderStep2() {
    return `
      <div class="onboarding-step step-profile">
        <div class="step-icon">
          <i class="fas fa-user-circle"></i>
        </div>
        <h3>Tell AgentX About Yourself</h3>
        <p class="step-description">
          Your profile information is injected into EVERY conversation, helping the AI remember your preferences and context.
        </p>

        <div class="form-section">
          <div class="form-group">
            <label>
              About You
              <span class="field-hint">Background, role, interests (this is your "memory")</span>
            </label>
            <textarea
              id="chatWizardProfileAbout"
              class="form-control"
              rows="4"
              placeholder="Example: I'm a software engineer working on web applications. I prefer TypeScript and React. I'm learning about AI/ML systems."
            >${this.profileData.about}</textarea>
          </div>

          <div class="form-group">
            <label>
              Custom Instructions
              <span class="field-hint">How should the AI behave when talking to you?</span>
            </label>
            <textarea
              id="chatWizardCustomInstructions"
              class="form-control"
              rows="4"
              placeholder="Example: Be concise and direct. Always provide code examples. Explain complex concepts step-by-step."
            >${this.profileData.customInstructions}</textarea>
          </div>
        </div>

        <div class="info-box">
          <i class="fas fa-lightbulb"></i>
          <div>
            <strong>Pro Tip:</strong> The more context you provide, the better the AI can tailor responses to your needs. You can always update this later in your <a href="/profile.html">profile settings</a>.
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 3: Choose Your Setup (NEW - with prompt selection)
   */
  renderStep3() {
    const promptOptions = this.availablePrompts.map(p => {
      const isDefault = p.name === 'default_chat';
      return `
        <option value="${p.name}" ${isDefault ? 'selected' : ''}>
          ${p.name} (v${p.latestVersion})${p.description ? ' - ' + p.description : ''}
        </option>
      `;
    }).join('');

    const modelOptions = this.availableModels.map(m => {
      return `<option value="${m.name}">${m.name}</option>`;
    }).join('');

    return `
      <div class="onboarding-step step-setup">
        <div class="step-icon">
          <i class="fas fa-cog"></i>
        </div>
        <h3>Choose Your Setup</h3>
        <p class="step-description">
          Select your preferred system prompt and AI model. Don't worry - you can change these anytime!
        </p>

        <div class="form-section">
          <div class="form-group">
            <label>
              System Prompt
              <i class="fas fa-info-circle" title="Controls AI behavior and personality"></i>
            </label>
            <select id="chatWizardPromptSelect" class="form-control">
              ${promptOptions}
            </select>
            <small>This controls how the AI behaves and responds. You can create custom prompts in <a href="/prompts.html">Prompt Management</a>.</small>
          </div>

          <div class="form-group">
            <label>
              Default Model
              <i class="fas fa-info-circle" title="Which Ollama model to use"></i>
            </label>
            <select id="chatWizardModelSelect" class="form-control">
              ${modelOptions || '<option value="">Loading models...</option>'}
            </select>
            <small>Select the AI model. Different models have different capabilities (speed, reasoning, code generation).</small>
          </div>
        </div>

        <div class="info-box">
          <i class="fas fa-magic"></i>
          <div>
            <strong>Did you know?</strong> AgentX supports A/B testing of prompts, so you can compare different prompt versions to see which performs better!
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 4: RAG Introduction
   */
  renderStep4() {
    return `
      <div class="onboarding-step step-rag">
        <div class="step-icon">
          <i class="fas fa-database"></i>
        </div>
        <h3>RAG: Search Your Documents</h3>
        <p class="step-description">
          RAG (Retrieval-Augmented Generation) searches your ingested documents to provide context-aware answers.
        </p>

        <div class="info-box bg-primary">
          <i class="fas fa-book"></i>
          <div>
            <strong>How RAG Works:</strong>
            <ol class="feature-list" style="margin-top: 8px; margin-left: 20px;">
              <li>You ask a question</li>
              <li>AgentX searches your document library for relevant information</li>
              <li>The AI answers using both its knowledge AND your documents</li>
              <li>You see which documents were used as sources</li>
            </ol>
          </div>
        </div>

        <div class="form-section">
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="chatWizardEnableRag" ${this.chatPreferences.useRag ? 'checked' : ''}>
              <span>Enable RAG by default</span>
            </label>
            <small>You can toggle this on/off for each conversation using the switch in the config panel.</small>
          </div>
        </div>

        <div class="info-box">
          <i class="fas fa-lightbulb"></i>
          <div>
            <strong>Pro Tip:</strong> Use RAG when you need answers based on your specific documents. Disable it for general questions where external context isn't needed.
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 5: Completion
   */
  renderStep5() {
    return `
      <div class="onboarding-step step-complete">
        <div class="step-icon success">
          <i class="fas fa-check-circle"></i>
        </div>
        <h3>You're All Set!</h3>
        <p class="step-description">
          Your chat interface is configured and ready to use. Here's what you can do next:
        </p>

        <div class="next-steps">
          <h4><i class="fas fa-rocket"></i> Next Steps:</h4>
          <ul class="feature-list">
            <li><i class="fas fa-arrow-right"></i> Type a message below to start your first conversation</li>
            <li><i class="fas fa-arrow-right"></i> Use the <i class="fas fa-cog"></i> config panel for advanced settings (temperature, context length, etc.)</li>
            <li><i class="fas fa-arrow-right"></i> Visit <a href="/prompts.html">Prompt Management</a> to create custom system prompts</li>
            <li><i class="fas fa-arrow-right"></i> Check <a href="/dashboard.html">Operations Dashboard</a> for system health</li>
            <li><i class="fas fa-arrow-right"></i> Review <a href="/analytics.html">Analytics</a> to track prompt performance</li>
          </ul>
        </div>

        <div class="info-box bg-success">
          <i class="fas fa-graduation-cap"></i>
          <div>
            <strong>Keyboard Shortcuts:</strong> Press <kbd>Ctrl+Enter</kbd> to send messages, <kbd>Ctrl+K</kbd> to clear chat, and click the <i class="fas fa-graduation-cap"></i> button anytime to reopen this tutorial.
          </div>
        </div>

        <div class="form-section">
          <label class="checkbox-label">
            <input type="checkbox" id="chatWizardDontShowAgain">
            <span>Don't show this tutorial again</span>
          </label>
        </div>
      </div>
    `;
  }

  /**
   * Render navigation buttons
   */
  renderNavigation() {
    const isFirstStep = this.currentStep === 1;
    const isLastStep = this.currentStep === this.totalSteps;

    return `
      <button
        class="btn btn-secondary"
        id="chatOnboardingPrev"
        ${isFirstStep ? 'disabled' : ''}
      >
        <i class="fas fa-arrow-left"></i> Previous
      </button>
      <button
        class="btn btn-primary"
        id="chatOnboardingNext"
      >
        ${isLastStep ? 'Finish' : 'Next'} <i class="fas fa-arrow-right"></i>
      </button>
    `;
  }

  /**
   * Attach step-specific event listeners
   */
  attachStepListeners() {
    // Navigation buttons
    const prevBtn = document.getElementById('chatOnboardingPrev');
    const nextBtn = document.getElementById('chatOnboardingNext');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.handlePrevious());
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.handleNext());
    }

    // Step-specific listeners
    switch (this.currentStep) {
      case 2:
        this.attachStep2Listeners();
        break;
      case 3:
        this.attachStep3Listeners();
        break;
      case 4:
        this.attachStep4Listeners();
        break;
      case 5:
        this.attachStep5Listeners();
        break;
    }
  }

  /**
   * Attach Step 2 listeners (profile setup)
   */
  attachStep2Listeners() {
    const aboutField = document.getElementById('chatWizardProfileAbout');
    const instructionsField = document.getElementById('chatWizardCustomInstructions');

    if (aboutField) {
      aboutField.addEventListener('input', (e) => {
        this.profileData.about = e.target.value;
      });
    }
    if (instructionsField) {
      instructionsField.addEventListener('input', (e) => {
        this.profileData.customInstructions = e.target.value;
      });
    }
  }

  /**
   * Attach Step 3 listeners (setup selection)
   */
  attachStep3Listeners() {
    const promptSelect = document.getElementById('chatWizardPromptSelect');
    const modelSelect = document.getElementById('chatWizardModelSelect');

    if (promptSelect) {
      promptSelect.addEventListener('change', (e) => {
        this.chatPreferences.promptName = e.target.value;
      });
      // Set initial value
      this.chatPreferences.promptName = promptSelect.value;
    }

    if (modelSelect) {
      modelSelect.addEventListener('change', (e) => {
        this.chatPreferences.modelName = e.target.value;
      });
      // Set initial value if models are loaded
      if (modelSelect.value) {
        this.chatPreferences.modelName = modelSelect.value;
      }
    }
  }

  /**
   * Attach Step 4 listeners (RAG toggle)
   */
  attachStep4Listeners() {
    const ragCheckbox = document.getElementById('chatWizardEnableRag');

    if (ragCheckbox) {
      ragCheckbox.addEventListener('change', (e) => {
        this.chatPreferences.useRag = e.target.checked;
      });
    }
  }

  /**
   * Attach Step 5 listeners (completion)
   */
  attachStep5Listeners() {
    const dontShowCheckbox = document.getElementById('chatWizardDontShowAgain');

    if (dontShowCheckbox) {
      dontShowCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.markCompleted();
        }
      });
    }
  }

  /**
   * Handle Previous button
   */
  handlePrevious() {
    if (this.currentStep > 1) {
      this.currentStep--;
      this.renderStep();
    }
  }

  /**
   * Handle Next button
   */
  async handleNext() {
    // Save profile on step 2 before proceeding
    if (this.currentStep === 2) {
      const success = await this.saveProfile();
      if (!success) {
        return; // Stay on step 2 if save failed
      }
    }

    // Apply preferences on step 5 (finish)
    if (this.currentStep === 5) {
      this.applyPreferences();
      this.handleFinish();
      return;
    }

    if (this.currentStep < this.totalSteps) {
      this.currentStep++;
      this.renderStep();
    }
  }

  /**
   * Handle Skip button
   */
  handleSkip() {
    if (confirm('Are you sure you want to skip the tutorial? You can always reopen it by clicking the tutorial button in the header.')) {
      this.close();
    }
  }

  /**
   * Handle Finish button
   */
  handleFinish() {
    if (this.toast) {
      this.toast.success('Welcome to AgentX! Start chatting below.');
    }
    this.close();
  }

  /**
   * Fetch available prompts from API
   */
  async fetchPrompts() {
    try {
      const response = await fetch('/api/prompts');
      if (!response.ok) throw new Error('Failed to fetch prompts');
      const data = await response.json();

      // Transform grouped prompts into flat list with latest version
      this.availablePrompts = Object.entries(data.prompts || {}).map(([name, versions]) => ({
        name,
        latestVersion: Math.max(...versions.map(v => v.version)),
        description: versions[0]?.description || ''
      }));

      // Fallback if no prompts
      if (this.availablePrompts.length === 0) {
        this.availablePrompts = [{
          name: 'default_chat',
          latestVersion: 1,
          description: 'Default system prompt'
        }];
      }
    } catch (error) {
      console.error('Error fetching prompts:', error);
      // Fallback to default if API fails
      this.availablePrompts = [{
        name: 'default_chat',
        latestVersion: 1,
        description: 'Default system prompt'
      }];
    }
  }

  /**
   * Fetch available models from Ollama through proxy endpoint to avoid CORS
   */
  async fetchModels() {
    try {
      const ollamaHost = localStorage.getItem('ollama_host') || '';
      
      // Use proxy endpoint to avoid CORS issues
      let proxyUrl = '/api/ollama-hosts/proxy/tags';
      if (ollamaHost && ollamaHost !== 'http://localhost:11434') {
        // Pass custom host as query parameter
        proxyUrl += `?host=${encodeURIComponent(ollamaHost)}`;
      }
      
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error('Failed to fetch models');
      const data = await response.json();

      this.availableModels = (data.models || []).map(m => ({
        name: m.name || m.model,
        size: m.size
      }));

      // Set default model if available
      if (this.availableModels.length > 0 && !this.chatPreferences.modelName) {
        this.chatPreferences.modelName = this.availableModels[0].name;
      }
    } catch (error) {
      console.error('Error fetching models:', error);
      this.availableModels = [];
    }
  }

  /**
   * Save user profile via API
   */
  async saveProfile() {
    const nextBtn = document.getElementById('chatOnboardingNext');

    try {
      // Show loading state
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
      }

      // Call API to save profile
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          about: this.profileData.about,
          preferences: {
            customInstructions: this.profileData.customInstructions
          }
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save profile');
      }

      // Success - show toast notification
      if (this.toast) {
        this.toast.success('Profile saved successfully!');
      }

      return true;

    } catch (error) {
      console.error('Failed to save profile:', error);

      // Show error toast
      if (this.toast) {
        this.toast.error(`Failed to save profile: ${error.message}`);
      }

      return false;

    } finally {
      // Restore button state
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.innerHTML = 'Next <i class="fas fa-arrow-right"></i>';
      }
    }
  }

  /**
   * Apply chat preferences to the UI
   */
  applyPreferences() {
    // Store preferences in localStorage for chat interface to pick up
    if (this.chatPreferences.promptName) {
      localStorage.setItem('agentx_default_prompt', this.chatPreferences.promptName);
    }
    if (this.chatPreferences.modelName) {
      localStorage.setItem('agentx_default_model', this.chatPreferences.modelName);
    }
    if (this.chatPreferences.useRag !== undefined) {
      localStorage.setItem('agentx_default_use_rag', this.chatPreferences.useRag.toString());
    }

    // Try to update UI elements if they exist
    try {
      // Update prompt selector
      const promptSelector = document.getElementById('systemPromptSelect');
      if (promptSelector && this.chatPreferences.promptName) {
        promptSelector.value = this.chatPreferences.promptName;
        // Trigger change event
        promptSelector.dispatchEvent(new Event('change'));
      }

      // Update model selector
      const modelSelector = document.getElementById('modelSelect');
      if (modelSelector && this.chatPreferences.modelName) {
        modelSelector.value = this.chatPreferences.modelName;
        modelSelector.dispatchEvent(new Event('change'));
      }

      // Update RAG toggle
      const ragToggle = document.getElementById('useRagToggle');
      if (ragToggle) {
        ragToggle.checked = this.chatPreferences.useRag;
        ragToggle.dispatchEvent(new Event('change'));
      }
    } catch (error) {
      console.error('Error applying preferences to UI:', error);
      // Non-fatal - preferences are saved to localStorage
    }
  }
}
