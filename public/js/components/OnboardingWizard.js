/**
 * Onboarding Wizard Component
 * Multi-step wizard to guide first-time users through creating their first prompt
 */

export class OnboardingWizard {
  constructor(api, toast) {
    this.api = api;
    this.toast = toast;
    this.currentStep = 1;
    this.totalSteps = 5;
    this.promptData = {
      name: '',
      description: '',
      systemPrompt: '',
      isActive: false,
      trafficWeight: 100
    };
    this.overlay = null;
    this.isOpen = false;
  }

  /**
   * Open the wizard
   */
  open() {
    if (this.isOpen) return;

    this.currentStep = 1;
    this.promptData = {
      name: '',
      description: '',
      systemPrompt: '',
      isActive: false,
      trafficWeight: 100
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
    localStorage.setItem('agentx_onboarding_completed', 'true');
  }

  /**
   * Check if user has completed onboarding
   */
  static isCompleted() {
    return localStorage.getItem('agentx_onboarding_completed') === 'true';
  }

  /**
   * Reset onboarding status (for testing or re-onboarding)
   */
  static reset() {
    localStorage.removeItem('agentx_onboarding_completed');
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
            <i class="fas fa-graduation-cap"></i>
            Getting Started with Prompt Management
          </h2>
          <button class="modal-close" id="onboardingSkip" title="Skip Tutorial">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="onboarding-progress">
          <div class="progress-bar">
            <div class="progress-fill" id="onboardingProgress"></div>
          </div>
          <div class="progress-text">
            Step <span id="currentStepNum">1</span> of ${this.totalSteps}
          </div>
        </div>

        <div class="modal-body" id="onboardingBody">
          <!-- Step content will be injected here -->
        </div>

        <div class="modal-footer" id="onboardingFooter">
          <!-- Navigation buttons will be injected here -->
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    // Attach event listeners
    document.getElementById('onboardingSkip').addEventListener('click', () => {
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
    const progressBar = document.getElementById('onboardingProgress');
    const stepNum = document.getElementById('currentStepNum');

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
  renderStep() {
    const body = document.getElementById('onboardingBody');
    const footer = document.getElementById('onboardingFooter');

    if (!body || !footer) return;

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
        <h3>Welcome to Prompt Management!</h3>
        <p class="step-description">
          This wizard will guide you through creating your first system prompt.
          You'll learn how to:
        </p>
        <ul class="feature-list">
          <li>
            <i class="fas fa-check-circle"></i>
            Create and manage prompt versions
          </li>
          <li>
            <i class="fas fa-check-circle"></i>
            Use template variables for dynamic content
          </li>
          <li>
            <i class="fas fa-check-circle"></i>
            Configure A/B testing for optimization
          </li>
          <li>
            <i class="fas fa-check-circle"></i>
            Test prompts with live variable preview
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
   * Step 2: Create Your First Prompt
   */
  renderStep2() {
    return `
      <div class="onboarding-step step-create">
        <div class="step-icon">
          <i class="fas fa-edit"></i>
        </div>
        <h3>Create Your First Prompt</h3>
        <p class="step-description">
          Let's create a basic system prompt. Fill in the fields below:
        </p>

        <div class="form-section">
          <div class="form-group">
            <label>
              Prompt Name <span class="required">*</span>
              <span class="field-hint">Unique identifier (e.g., "default_chat", "code_assistant")</span>
            </label>
            <input
              type="text"
              id="wizardPromptName"
              placeholder="my_first_prompt"
              value="${this.promptData.name}"
            />
            <div class="field-note">
              Use lowercase with underscores. This name groups different versions together.
            </div>
          </div>

          <div class="form-group">
            <label>
              Description
              <span class="field-hint">Brief explanation of what this prompt does</span>
            </label>
            <input
              type="text"
              id="wizardDescription"
              placeholder="A helpful assistant for general queries"
              value="${this.promptData.description}"
            />
          </div>

          <div class="form-group">
            <label>
              System Prompt <span class="required">*</span>
              <span class="field-hint">The actual prompt text sent to the AI model</span>
            </label>
            <textarea
              id="wizardSystemPrompt"
              rows="8"
              placeholder="You are a helpful AI assistant. Answer questions clearly and concisely..."
            >${this.promptData.systemPrompt}</textarea>
            <div class="field-note">
              <i class="fas fa-lightbulb"></i>
              Tip: Be specific about the AI's role, tone, and behavior. You can use template variables like <code>{{userName}}</code> for dynamic content.
            </div>
          </div>

          <div class="form-error" id="wizardError" style="display: none;">
            <i class="fas fa-exclamation-triangle"></i>
            <span id="wizardErrorText"></span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 3: Understand Variables
   */
  renderStep3() {
    return `
      <div class="onboarding-step step-variables">
        <div class="step-icon">
          <i class="fas fa-code"></i>
        </div>
        <h3>Template Variables</h3>
        <p class="step-description">
          Make your prompts dynamic with template variables using <code>{{variableName}}</code> syntax.
        </p>

        <div class="variables-examples">
          <div class="example-box">
            <h4><i class="fas fa-star"></i> Common Variables</h4>
            <ul class="variables-list">
              <li><code>{{userName}}</code> - User's display name</li>
              <li><code>{{userProfile}}</code> - User's profile information</li>
              <li><code>{{conversationHistory}}</code> - Previous chat messages</li>
              <li><code>{{currentDate}}</code> - Current date/time</li>
              <li><code>{{context}}</code> - Additional context or RAG results</li>
            </ul>
          </div>

          <div class="example-box">
            <h4><i class="fas fa-eye"></i> Example Usage</h4>
            <div class="code-example">
              <pre>You are a helpful assistant talking to {{userName}}.

Today's date is {{currentDate}}.

User Profile:
{{userProfile}}

Please respond to their questions professionally.</pre>
            </div>
          </div>

          <div class="example-box info">
            <i class="fas fa-info-circle"></i>
            <div>
              <strong>Testing Templates</strong><br>
              After creating your prompt, use the "Test Template" button to preview how variables are replaced with actual values.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 4: Activation Settings
   */
  renderStep4() {
    return `
      <div class="onboarding-step step-activation">
        <div class="step-icon">
          <i class="fas fa-toggle-on"></i>
        </div>
        <h3>Activation & Traffic Control</h3>
        <p class="step-description">
          Configure when and how your prompt is used in production.
        </p>

        <div class="activation-section">
          <div class="setting-box">
            <div class="setting-header">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  id="wizardIsActive"
                  ${this.promptData.isActive ? 'checked' : ''}
                />
                <span>Activate Immediately</span>
              </label>
            </div>
            <p class="setting-description">
              When active, this prompt can be selected for conversations.
              Inactive prompts are drafts that won't be used until activated.
            </p>
          </div>

          <div class="setting-box">
            <label>
              Traffic Weight
              <span class="field-hint">Percentage of traffic if multiple versions are active (1-100)</span>
            </label>
            <div class="traffic-weight-control">
              <input
                type="range"
                id="wizardTrafficWeight"
                min="1"
                max="100"
                value="${this.promptData.trafficWeight}"
                class="weight-slider"
              />
              <input
                type="number"
                id="wizardTrafficWeightNum"
                min="1"
                max="100"
                value="${this.promptData.trafficWeight}"
                class="weight-input"
              />
              <span class="weight-unit">%</span>
            </div>
            <p class="setting-description">
              For A/B testing: If you have multiple active versions of a prompt,
              traffic is distributed based on these weights (must sum to 100%).
            </p>
          </div>

          <div class="info-box">
            <i class="fas fa-lightbulb"></i>
            <div>
              <strong>Recommendation:</strong> Start with the prompt inactive so you can test it first.
              You can activate it later from the prompts list.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 5: Complete
   */
  renderStep5() {
    const promptName = this.promptData.name || 'your prompt';

    return `
      <div class="onboarding-step step-complete">
        <div class="step-icon success">
          <i class="fas fa-check-circle"></i>
        </div>
        <h3>You're All Set!</h3>
        <p class="step-description">
          ${this.promptData.name ?
            `Your prompt "<strong>${promptName}</strong>" has been created successfully!` :
            'Complete the setup to create your first prompt.'}
        </p>

        <div class="next-steps">
          <h4><i class="fas fa-map-signs"></i> What's Next?</h4>
          <ul class="action-list">
            <li>
              <i class="fas fa-flask"></i>
              <strong>Test Your Prompt:</strong> Use the "Test Template" button to preview with different variables
            </li>
            <li>
              <i class="fas fa-chart-line"></i>
              <strong>A/B Testing:</strong> Create additional versions and configure traffic weights for optimization
            </li>
            <li>
              <i class="fas fa-star"></i>
              <strong>Monitor Performance:</strong> Check metrics like impressions and positive feedback rates
            </li>
            <li>
              <i class="fas fa-book"></i>
              <strong>Learn More:</strong> Read the documentation for advanced features
            </li>
          </ul>
        </div>

        <div class="completion-options">
          <label class="checkbox-label">
            <input type="checkbox" id="wizardDontShowAgain" />
            <span>Don't show this wizard again</span>
          </label>
        </div>

        <div class="quick-links">
          <a href="#" class="quick-link" id="viewPromptsLink">
            <i class="fas fa-list"></i>
            View All Prompts
          </a>
          <a href="#" class="quick-link" id="createAnotherLink">
            <i class="fas fa-plus"></i>
            Create Another Prompt
          </a>
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
    const isSecondStep = this.currentStep === 2;

    let buttons = '';

    // Previous button (not on first step)
    if (!isFirstStep) {
      buttons += `
        <button class="btn-secondary" id="onboardingPrev">
          <i class="fas fa-arrow-left"></i>
          Previous
        </button>
      `;
    }

    // Skip button (not on last step)
    if (!isLastStep) {
      buttons += `
        <button class="btn-secondary" id="onboardingSkipBtn">
          Skip Tutorial
        </button>
      `;
    }

    // Next/Create/Finish button
    if (isLastStep) {
      buttons += `
        <button class="btn-primary" id="onboardingFinish">
          <i class="fas fa-check"></i>
          Finish
        </button>
      `;
    } else if (isSecondStep) {
      buttons += `
        <button class="btn-primary" id="onboardingNext">
          Continue
          <i class="fas fa-arrow-right"></i>
        </button>
      `;
    } else {
      buttons += `
        <button class="btn-primary" id="onboardingNext">
          Next
          <i class="fas fa-arrow-right"></i>
        </button>
      `;
    }

    return buttons;
  }

  /**
   * Attach event listeners for current step
   */
  attachStepListeners() {
    // Navigation buttons
    const prevBtn = document.getElementById('onboardingPrev');
    const nextBtn = document.getElementById('onboardingNext');
    const skipBtn = document.getElementById('onboardingSkipBtn');
    const finishBtn = document.getElementById('onboardingFinish');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.handlePrevious());
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.handleNext());
    }
    if (skipBtn) {
      skipBtn.addEventListener('click', () => this.handleSkip());
    }
    if (finishBtn) {
      finishBtn.addEventListener('click', () => this.handleFinish());
    }

    // Step-specific listeners
    if (this.currentStep === 2) {
      this.attachStep2Listeners();
    } else if (this.currentStep === 4) {
      this.attachStep4Listeners();
    } else if (this.currentStep === 5) {
      this.attachStep5Listeners();
    }
  }

  /**
   * Attach Step 2 listeners (form inputs)
   */
  attachStep2Listeners() {
    const nameInput = document.getElementById('wizardPromptName');
    const descInput = document.getElementById('wizardDescription');
    const promptInput = document.getElementById('wizardSystemPrompt');

    if (nameInput) {
      nameInput.addEventListener('input', (e) => {
        this.promptData.name = e.target.value;
      });
    }
    if (descInput) {
      descInput.addEventListener('input', (e) => {
        this.promptData.description = e.target.value;
      });
    }
    if (promptInput) {
      promptInput.addEventListener('input', (e) => {
        this.promptData.systemPrompt = e.target.value;
      });
    }
  }

  /**
   * Attach Step 4 listeners (activation settings)
   */
  attachStep4Listeners() {
    const activeCheckbox = document.getElementById('wizardIsActive');
    const weightSlider = document.getElementById('wizardTrafficWeight');
    const weightNum = document.getElementById('wizardTrafficWeightNum');

    if (activeCheckbox) {
      activeCheckbox.addEventListener('change', (e) => {
        this.promptData.isActive = e.target.checked;
      });
    }

    if (weightSlider && weightNum) {
      weightSlider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        this.promptData.trafficWeight = value;
        weightNum.value = value;
      });

      weightNum.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        if (value >= 1 && value <= 100) {
          this.promptData.trafficWeight = value;
          weightSlider.value = value;
        }
      });
    }
  }

  /**
   * Attach Step 5 listeners (completion actions)
   */
  attachStep5Listeners() {
    const viewLink = document.getElementById('viewPromptsLink');
    const createLink = document.getElementById('createAnotherLink');

    if (viewLink) {
      viewLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleFinish();
      });
    }

    if (createLink) {
      createLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleFinish();
        // Trigger create prompt modal (will be handled by parent)
        setTimeout(() => {
          const createBtn = document.getElementById('createPromptBtn');
          if (createBtn) createBtn.click();
        }, 500);
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
    // Validate current step before proceeding
    if (this.currentStep === 2) {
      if (!this.validateStep2()) {
        return;
      }
    }

    // If on step 4, create the prompt before going to step 5
    if (this.currentStep === 4) {
      const success = await this.createPrompt();
      if (!success) {
        return; // Stay on step 4 if creation failed
      }
    }

    if (this.currentStep < this.totalSteps) {
      this.currentStep++;
      this.renderStep();
    }
  }

  /**
   * Validate Step 2 (form validation)
   */
  validateStep2() {
    const name = this.promptData.name.trim();
    const systemPrompt = this.promptData.systemPrompt.trim();
    const errorDiv = document.getElementById('wizardError');
    const errorText = document.getElementById('wizardErrorText');

    // Clear previous errors
    if (errorDiv) {
      errorDiv.style.display = 'none';
    }

    // Validate name
    if (!name) {
      this.showError('Prompt name is required');
      return false;
    }

    if (!/^[a-z0-9_]+$/.test(name)) {
      this.showError('Prompt name must be lowercase with underscores (a-z, 0-9, _)');
      return false;
    }

    // Validate system prompt
    if (!systemPrompt) {
      this.showError('System prompt is required');
      return false;
    }

    if (systemPrompt.length < 10) {
      this.showError('System prompt must be at least 10 characters');
      return false;
    }

    return true;
  }

  /**
   * Show validation error
   */
  showError(message) {
    const errorDiv = document.getElementById('wizardError');
    const errorText = document.getElementById('wizardErrorText');

    if (errorDiv && errorText) {
      errorText.textContent = message;
      errorDiv.style.display = 'flex';

      // Scroll to error
      errorDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  /**
   * Create the prompt via API
   */
  async createPrompt() {
    const nextBtn = document.getElementById('onboardingNext');

    try {
      // Show loading state
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
      }

      // Call API to create prompt
      await this.api.create({
        name: this.promptData.name.trim(),
        description: this.promptData.description.trim(),
        systemPrompt: this.promptData.systemPrompt.trim(),
        isActive: this.promptData.isActive,
        trafficWeight: this.promptData.trafficWeight
      });

      // Success - show toast notification
      if (this.toast) {
        this.toast.success(`Prompt "${this.promptData.name}" created successfully!`);
      }

      return true;

    } catch (error) {
      console.error('Failed to create prompt:', error);

      // Show error toast
      if (this.toast) {
        this.toast.error(`Failed to create prompt: ${error.message}`);
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
   * Handle Skip button
   */
  handleSkip() {
    const confirmed = confirm(
      'Are you sure you want to skip the tutorial?\n\n' +
      'You can always access it again by clicking "Show Onboarding" in the header menu.'
    );

    if (confirmed) {
      this.close();
    }
  }

  /**
   * Handle Finish button
   */
  handleFinish() {
    // Check if user wants to hide wizard permanently
    const dontShowAgain = document.getElementById('wizardDontShowAgain');
    if (dontShowAgain && dontShowAgain.checked) {
      this.markCompleted();
    }

    this.close();

    // Reload prompts list to show newly created prompt
    if (window.location.href.includes('prompts.html')) {
      window.location.reload();
    }
  }
}
