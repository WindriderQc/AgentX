/**
 * Onboarding Wizard Component (Refactored)
 * Multi-step wizard to guide first-time users through creating their first prompt
 * Extends BaseOnboardingWizard for shared functionality
 */

import { BaseOnboardingWizard } from './BaseOnboardingWizard.js';

export class OnboardingWizard extends BaseOnboardingWizard {
  constructor(api, toast) {
    super(toast, {
      totalSteps: 7,
      wizardId: 'onboarding',
      title: 'Getting Started with Prompt Management',
      icon: 'fa-graduation-cap'
    });

    // Store API client for prompt creation
    this.api = api;
  }

  /**
   * Initialize data when wizard opens
   */
  onOpen() {
    this.data = {
      promptData: {
        name: '',
        description: '',
        systemPrompt: '',
        isActive: false,
        trafficWeight: 100
      },
      profileData: {
        about: '',
        customInstructions: ''
      }
    };
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
   * Step 2: User Profile Setup
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
              id="wizardProfileAbout"
              rows="4"
              placeholder="I'm a software engineer working on Node.js projects. I prefer concise technical explanations."
            >${this.data.profileData.about}</textarea>
            <div class="field-note">
              <i class="fas fa-lightbulb"></i>
              Example: "I'm a data scientist at a healthcare startup. I work with Python and SQL daily."
            </div>
          </div>

          <div class="form-group">
            <label>
              Custom Instructions (Optional)
              <span class="field-hint">Specific behavior preferences</span>
            </label>
            <textarea
              id="wizardProfileInstructions"
              rows="3"
              placeholder="Always format code blocks with syntax highlighting. Use metric units."
            >${this.data.profileData.customInstructions}</textarea>
          </div>
        </div>

        <div class="info-box">
          <i class="fas fa-info-circle"></i>
          <div>
            <strong>Privacy Note:</strong> This information is stored locally in your AgentX database and never sent to external services (only to your local Ollama).
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 3: Understanding Profiles vs Prompts
   */
  renderStep3() {
    return `
      <div class="onboarding-step step-concepts">
        <div class="step-icon">
          <i class="fas fa-graduation-cap"></i>
        </div>
        <h3>Two Key Concepts</h3>
        <p class="step-description">
          AgentX uses two layers to customize your AI experience:
        </p>

        <div class="concepts-grid">
          <div class="concept-card">
            <div class="concept-icon">
              <i class="fas fa-user-circle"></i>
            </div>
            <h4>User Profile</h4>
            <ul class="concept-points">
              <li><strong>Who YOU are</strong></li>
              <li>Injected into ALL conversations</li>
              <li>Your "memory" and preferences</li>
              <li>Set once, applies everywhere</li>
            </ul>
            <div class="concept-example">
              <strong>Example:</strong><br>
              "I'm a Python developer. I prefer concise answers."
            </div>
          </div>

          <div class="concept-card">
            <div class="concept-icon">
              <i class="fas fa-code"></i>
            </div>
            <h4>System Prompt</h4>
            <ul class="concept-points">
              <li><strong>How the AI BEHAVES</strong></li>
              <li>Selected per conversation</li>
              <li>Defines AI's role and tone</li>
              <li>Can have multiple versions</li>
            </ul>
            <div class="concept-example">
              <strong>Example:</strong><br>
              "You are a code review assistant. Focus on best practices."
            </div>
          </div>
        </div>

        <div class="info-box success">
          <i class="fas fa-layer-group"></i>
          <div>
            <strong>How They Work Together:</strong><br>
            Profile + Prompt = Effective System Prompt sent to AI<br>
            <code>System Prompt + "\\n\\nUser Profile: [your profile]" + Custom Instructions</code>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 4: Create Your First Prompt
   */
  renderStep4() {
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
              value="${this.data.promptData.name}"
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
              value="${this.data.promptData.description}"
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
            >${this.data.promptData.systemPrompt}</textarea>
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
   * Step 5: Understand Variables
   */
  renderStep5() {
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
   * Step 6: Activation Settings
   */
  renderStep6() {
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
                  ${this.data.promptData.isActive ? 'checked' : ''}
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
                value="${this.data.promptData.trafficWeight}"
                class="weight-slider"
              />
              <input
                type="number"
                id="wizardTrafficWeightNum"
                min="1"
                max="100"
                value="${this.data.promptData.trafficWeight}"
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
   * Step 7: Complete
   */
  renderStep7() {
    const promptName = this.data.promptData.name || 'your prompt';

    return `
      <div class="onboarding-step step-complete">
        <div class="step-icon success">
          <i class="fas fa-check-circle"></i>
        </div>
        <h3>You're All Set!</h3>
        <p class="step-description">
          ${this.data.promptData.name ?
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
            <input type="checkbox" id="onboardingDontShowAgain" />
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
   * Attach step-specific event listeners
   */
  attachStepListeners() {
    if (this.currentStep === 2) {
      this.attachStep2Listeners();
    } else if (this.currentStep === 4) {
      this.attachStep4Listeners();
    } else if (this.currentStep === 6) {
      this.attachStep6Listeners();
    } else if (this.currentStep === 7) {
      this.attachStep7Listeners();
    }
  }

  /**
   * Attach Step 2 listeners (profile inputs)
   */
  attachStep2Listeners() {
    const aboutField = document.getElementById('wizardProfileAbout');
    const instructionsField = document.getElementById('wizardProfileInstructions');

    if (aboutField) {
      aboutField.addEventListener('input', (e) => {
        this.data.profileData.about = e.target.value;
      });
    }
    if (instructionsField) {
      instructionsField.addEventListener('input', (e) => {
        this.data.profileData.customInstructions = e.target.value;
      });
    }
  }

  /**
   * Attach Step 4 listeners (prompt creation form)
   */
  attachStep4Listeners() {
    const nameField = document.getElementById('wizardPromptName');
    const descField = document.getElementById('wizardDescription');
    const promptField = document.getElementById('wizardSystemPrompt');

    if (nameField) {
      nameField.addEventListener('input', (e) => {
        this.data.promptData.name = e.target.value;
      });
    }
    if (descField) {
      descField.addEventListener('input', (e) => {
        this.data.promptData.description = e.target.value;
      });
    }
    if (promptField) {
      promptField.addEventListener('input', (e) => {
        this.data.promptData.systemPrompt = e.target.value;
      });
    }
  }

  /**
   * Attach Step 6 listeners (activation settings)
   */
  attachStep6Listeners() {
    const activeCheckbox = document.getElementById('wizardIsActive');
    const weightSlider = document.getElementById('wizardTrafficWeight');
    const weightNum = document.getElementById('wizardTrafficWeightNum');

    if (activeCheckbox) {
      activeCheckbox.addEventListener('change', (e) => {
        this.data.promptData.isActive = e.target.checked;
      });
    }

    if (weightSlider && weightNum) {
      weightSlider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        this.data.promptData.trafficWeight = value;
        weightNum.value = value;
      });

      weightNum.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        if (value >= 1 && value <= 100) {
          this.data.promptData.trafficWeight = value;
          weightSlider.value = value;
        }
      });
    }
  }

  /**
   * Attach Step 7 listeners (completion actions)
   */
  attachStep7Listeners() {
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
   * Validate step before proceeding
   */
  async validateStep(stepNumber) {
    if (stepNumber === 4) {
      const name = this.data.promptData.name.trim();
      const systemPrompt = this.data.promptData.systemPrompt.trim();

      // Clear previous errors
      const errorDiv = document.getElementById('wizardError');
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
    }

    return true;
  }

  /**
   * Process step data before moving to next
   */
  async processStep(stepNumber) {
    switch (stepNumber) {
      case 2:
        // Save profile on step 2
        return await this.saveProfile();
      case 6:
        // Create prompt on step 6 (after activation settings)
        return await this.createPrompt();
      default:
        return true;
    }
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
    try {
      // Show loading state
      this.setButtonLoading('onboardingNextBtn', true, 'Creating...');

      // Call API to create prompt
      await this.api.create({
        name: this.data.promptData.name.trim(),
        description: this.data.promptData.description.trim(),
        systemPrompt: this.data.promptData.systemPrompt.trim(),
        isActive: this.data.promptData.isActive,
        trafficWeight: this.data.promptData.trafficWeight
      });

      // Success - show toast notification
      if (this.toast) {
        this.toast.success(`Prompt "${this.data.promptData.name}" created successfully!`);
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
      this.setButtonLoading('onboardingNextBtn', false);
    }
  }

  /**
   * Save user profile via API
   */
  async saveProfile() {
    try {
      // Show loading state
      this.setButtonLoading('onboardingNextBtn', true, 'Saving...');

      // Call API to save profile
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          about: this.data.profileData.about.trim(),
          preferences: {
            customInstructions: this.data.profileData.customInstructions.trim()
          }
        })
      });

      const result = await response.json();

      if (result.status !== 'success') {
        throw new Error(result.message || 'Failed to save profile');
      }

      // Success - show toast notification
      if (this.toast) {
        this.toast.success('Profile saved successfully!');
      }

      return true;

    } catch (error) {
      console.error('Failed to save profile:', error);

      // Show error in toast
      if (this.toast) {
        this.toast.error(`Failed to save profile: ${error.message}`);
      } else {
        alert(`Failed to save profile: ${error.message}`);
      }

      return false;

    } finally {
      // Reset button state
      this.setButtonLoading('onboardingNextBtn', false);
    }
  }

  /**
   * Final actions on wizard completion
   */
  async onFinish() {
    // Reload prompts list to show newly created prompt
      if (window.location.href.includes('prompts.html')) {
      this.toast.success('Onboarding complete! Reloading prompts...');
      setTimeout(() => window.location.reload(), 500);
    }
  }
}
