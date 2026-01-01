/**
 * Base Onboarding Wizard Component
 * Shared functionality for all onboarding wizards
 * Subclasses should implement: renderStepN() methods and define totalSteps
 */

export class BaseOnboardingWizard {
  constructor(toast, config = {}) {
    this.toast = toast;
    this.currentStep = 1;
    this.totalSteps = config.totalSteps || 5;
    this.wizardId = config.wizardId || 'onboarding';
    this.title = config.title || 'Welcome';
    this.icon = config.icon || 'fa-graduation-cap';
    this.overlay = null;
    this.isOpen = false;
    this.data = {}; // Subclass-specific data storage
  }

  /**
   * Open the wizard
   */
  open() {
    if (this.isOpen) return;
    this.currentStep = 1;
    this.data = {}; // Reset data
    this.onOpen(); // Hook for subclass initialization
    this.render();
    this.isOpen = true;
  }

  /**
   * Hook for subclass to initialize data on open
   */
  onOpen() {
    // Override in subclass if needed
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
   * Mark wizard as completed
   */
  markCompleted() {
    localStorage.setItem(`agentx_${this.wizardId}_completed`, 'true');
  }

  /**
   * Check if wizard has been completed
   */
  isCompleted() {
    return localStorage.getItem(`agentx_${this.wizardId}_completed`) === 'true';
  }

  /**
   * Reset wizard completion status
   */
  reset() {
    localStorage.removeItem(`agentx_${this.wizardId}_completed`);
    localStorage.removeItem(`agentx_${this.wizardId}_seen`);
  }

  /**
   * Render the wizard UI
   */
  render() {
    // Create overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay onboarding-overlay';
    this.overlay.innerHTML = `
      <div class="modal-container onboarding-modal">
        <div class="modal-header">
          <h2>
            <i class="fas ${this.icon}"></i>
            ${this.title}
          </h2>
          <button class="modal-close" id="${this.wizardId}Skip" title="Skip Tutorial">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="onboarding-progress">
          <div class="progress-bar">
            <div class="progress-fill" id="${this.wizardId}Progress"></div>
          </div>
          <div class="progress-text">
            Step <span id="${this.wizardId}CurrentStepNum">1</span> of ${this.totalSteps}
          </div>
        </div>

        <div class="onboarding-content">
          <div class="onboarding-body" id="${this.wizardId}Body">
            <!-- Step content rendered here -->
          </div>
        </div>

        <div class="onboarding-footer">
          <button class="btn ghost" id="${this.wizardId}PrevBtn" ${this.currentStep === 1 ? 'disabled' : ''}>
            <i class="fas fa-arrow-left"></i> Previous
          </button>
          <button class="btn-primary" id="${this.wizardId}NextBtn">
            Next <i class="fas fa-arrow-right"></i>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    this.renderStep();
    this.attachListeners();
    this.updateProgress();
  }

  /**
   * Update progress bar
   */
  updateProgress() {
    const progress = (this.currentStep / this.totalSteps) * 100;
    const progressFill = document.getElementById(`${this.wizardId}Progress`);
    const stepNum = document.getElementById(`${this.wizardId}CurrentStepNum`);

    if (progressFill) progressFill.style.width = `${progress}%`;
    if (stepNum) stepNum.textContent = this.currentStep;

    // Update button states
    const prevBtn = document.getElementById(`${this.wizardId}PrevBtn`);
    const nextBtn = document.getElementById(`${this.wizardId}NextBtn`);

    if (prevBtn) prevBtn.disabled = this.currentStep === 1;
    if (nextBtn) {
      const isLastStep = this.currentStep === this.totalSteps;
      nextBtn.innerHTML = isLastStep
        ? '<i class="fas fa-check"></i> Finish'
        : 'Next <i class="fas fa-arrow-right"></i>';
    }
  }

  /**
   * Render current step (delegates to subclass)
   */
  async renderStep() {
    const body = document.getElementById(`${this.wizardId}Body`);
    if (!body) return;

    try {
      // Call the appropriate renderStepN method
      const methodName = `renderStep${this.currentStep}`;
      if (typeof this[methodName] === 'function') {
        const content = await this[methodName]();
        body.innerHTML = content;
        this.attachStepListeners(); // Hook for step-specific listeners
      } else {
        body.innerHTML = `<p>Step ${this.currentStep} not implemented</p>`;
      }
    } catch (error) {
      console.error(`Error rendering step ${this.currentStep}:`, error);
      body.innerHTML = `<div class="error">Error loading step. Please try again.</div>`;
    }
  }

  /**
   * Hook for step-specific event listeners
   * Override in subclass to attach listeners to step content
   */
  attachStepListeners() {
    // Override in subclass
  }

  /**
   * Attach main event listeners
   */
  attachListeners() {
    // Skip button
    const skipBtn = document.getElementById(`${this.wizardId}Skip`);
    if (skipBtn) {
      skipBtn.addEventListener('click', () => this.handleSkip());
    }

    // Previous button
    const prevBtn = document.getElementById(`${this.wizardId}PrevBtn`);
    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.handlePrevious());
    }

    // Next button
    const nextBtn = document.getElementById(`${this.wizardId}NextBtn`);
    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.handleNext());
    }

    // Close on overlay click (outside modal)
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.handleSkip();
      }
    });
  }

  /**
   * Handle skip/close
   */
  handleSkip() {
    if (confirm('Are you sure you want to skip the tutorial? You can access it again from the tutorial button.')) {
      this.close();
    }
  }

  /**
   * Handle previous step
   */
  handlePrevious() {
    if (this.currentStep > 1) {
      this.currentStep--;
      this.renderStep();
      this.updateProgress();
    }
  }

  /**
   * Handle next/finish
   */
  async handleNext() {
    const isLastStep = this.currentStep === this.totalSteps;

    // Validate current step (if subclass implements validation)
    const isValid = await this.validateStep(this.currentStep);
    if (!isValid) return;

    // Process current step (if subclass needs to save data)
    const processed = await this.processStep(this.currentStep);
    if (!processed) return;

    if (isLastStep) {
      // Finish wizard
      await this.handleFinish();
    } else {
      // Move to next step
      this.currentStep++;
      this.renderStep();
      this.updateProgress();
    }
  }

  /**
   * Validate step before proceeding (override in subclass)
   */
  async validateStep(stepNumber) {
    return true; // Default: always valid
  }

  /**
   * Process step data before moving to next (override in subclass)
   */
  async processStep(stepNumber) {
    return true; // Default: always successful
  }

  /**
   * Handle wizard completion
   */
  async handleFinish() {
    // Check "don't show again" checkbox if present
    const dontShowAgain = document.getElementById(`${this.wizardId}DontShowAgain`);
    if (dontShowAgain && dontShowAgain.checked) {
      this.markCompleted();
    }

    // Call subclass hook for final actions
    await this.onFinish();

    // Close wizard
    this.close();

    // Show completion message
    if (this.toast) {
      this.toast.success('Tutorial completed! You can access it again anytime from the tutorial button.');
    }
  }

  /**
   * Hook for subclass to perform final actions
   */
  async onFinish() {
    // Override in subclass
  }

  /**
   * Utility: Show loading state on button
   */
  setButtonLoading(buttonId, isLoading, loadingText = 'Loading...') {
    const btn = document.getElementById(buttonId);
    if (!btn) return;

    if (isLoading) {
      btn.disabled = true;
      btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${loadingText}`;
    } else {
      btn.disabled = false;
      btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
    }
  }

  /**
   * Utility: Get form data from step
   */
  getStepFormData(formId) {
    const form = document.getElementById(formId);
    if (!form) return {};

    const formData = new FormData(form);
    const data = {};
    for (const [key, value] of formData.entries()) {
      data[key] = value;
    }
    return data;
  }
}
