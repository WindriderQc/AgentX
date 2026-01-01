/**
 * PromptImprovementWizard Component
 * Multi-step wizard for AI-powered prompt improvement
 * Guides users through analyzing failures and creating improved versions
 */

export class PromptImprovementWizard {
  constructor(api, toast) {
    this.api = api;
    this.toast = toast;
    this.currentStep = 1;
    this.totalSteps = 5;
    this.promptName = null;
    this.promptVersion = null;
    this.analysisData = null;
    this.suggestedPrompt = '';
    this.customizedPrompt = '';
    this.enableABTest = false;
    this.trafficSplit = 50;
    this.overlay = null;
    this.isOpen = false;
    this.loading = false;
  }

  /**
   * Open wizard to improve a prompt
   */
  async open(promptName, promptVersion) {
    if (this.isOpen) return;

    this.promptName = promptName;
    this.promptVersion = promptVersion;
    this.currentStep = 1;
    this.analysisData = null;
    this.suggestedPrompt = '';
    this.customizedPrompt = '';
    this.enableABTest = false;
    this.trafficSplit = 50;

    this.render();
    this.isOpen = true;

    // Start analysis immediately
    await this.performAnalysis();
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
   * Perform failure analysis
   */
  async performAnalysis() {
    this.loading = true;
    this.renderStep(); // Show loading state

    try {
      const response = await fetch(`/api/prompts/${this.promptName}/analyze-failures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          version: this.promptVersion,
          limit: 20
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      if (result.status !== 'success') {
        throw new Error(result.message || 'Analysis failed');
      }

      this.analysisData = result.data;
      const basePrompt = this.analysisData?.prompt?.systemPrompt || '';
      this.suggestedPrompt = this.analysisData?.llmAnalysis?.suggested_prompt || basePrompt;
      this.customizedPrompt = this.suggestedPrompt;

    } catch (error) {
      console.error('Analysis failed:', error);
      this.toast.error(`Analysis failed: ${error.message}`);
      this.analysisData = { error: error.message };
    } finally {
      this.loading = false;
      this.renderStep();
    }
  }

  /**
   * Render the wizard
   */
  render() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay improvement-wizard-overlay';
    this.overlay.innerHTML = `
      <div class="modal-container improvement-wizard-modal">
        <div class="modal-header">
          <h2>
            <i class="fas fa-magic"></i>
            Improve Prompt: ${this.escapeHtml(this.promptName)}
          </h2>
          <button class="modal-close" id="wizardClose" title="Close">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="wizard-progress">
          <div class="progress-steps">
            ${this.renderProgressSteps()}
          </div>
        </div>

        <div class="modal-body" id="wizardBody">
          <!-- Step content will be injected here -->
        </div>

        <div class="modal-footer" id="wizardFooter">
          <!-- Navigation buttons will be injected here -->
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    // Attach event listeners
    document.getElementById('wizardClose').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.renderStep();
  }

  /**
   * Render progress steps indicator
   */
  renderProgressSteps() {
    const steps = [
      { num: 1, label: 'Analyze', icon: 'fa-search' },
      { num: 2, label: 'Review', icon: 'fa-eye' },
      { num: 3, label: 'Customize', icon: 'fa-edit' },
      { num: 4, label: 'A/B Test', icon: 'fa-flask' },
      { num: 5, label: 'Confirm', icon: 'fa-check' }
    ];

    return steps.map(step => {
      const active = step.num === this.currentStep;
      const completed = step.num < this.currentStep;
      return `
        <div class="progress-step ${active ? 'active' : ''} ${completed ? 'completed' : ''}">
          <div class="step-circle">
            <i class="fas ${completed ? 'fa-check' : step.icon}"></i>
          </div>
          <div class="step-label">${step.label}</div>
        </div>
      `;
    }).join('');
  }

  /**
   * Render current step
   */
  renderStep() {
    const body = document.getElementById('wizardBody');
    const footer = document.getElementById('wizardFooter');

    if (!body || !footer) return;

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

    footer.innerHTML = this.renderNavigation();
    this.attachStepListeners();
  }

  /**
   * Step 1: Analysis Loading/Results
   */
  renderStep1() {
    if (this.loading) {
      return `
        <div class="wizard-step loading-step">
          <div class="loading-spinner">
            <div class="spinner"></div>
          </div>
          <h3>Analyzing Failures...</h3>
          <p>AI is examining negative feedback patterns and generating insights.</p>
        </div>
      `;
    }

    if (this.analysisData?.error) {
      return `
        <div class="wizard-step error-step">
          <i class="fas fa-exclamation-triangle"></i>
          <h3>Analysis Failed</h3>
          <p>${this.escapeHtml(this.analysisData.error)}</p>
        </div>
      `;
    }

    if (!this.analysisData) return '<div class="wizard-step"><p>Loading...</p></div>';

    const patternAnalysis = this.analysisData?.patternAnalysis || {
      patterns: [],
      themes: [],
      stats: {
        totalConversations: 0,
        avgMessagesPerConversation: 0,
        mostCommonFailurePoints: []
      }
    };
    const { llmAnalysis } = this.analysisData;

    return `
      <div class="wizard-step analysis-step">
        <h3><i class="fas fa-chart-pie"></i> Analysis Complete</h3>
        
        <div class="analysis-summary">
          <div class="summary-stat">
            <span class="stat-value">${this.analysisData.conversations}</span>
            <span class="stat-label">Conversations Analyzed</span>
          </div>
          <div class="summary-stat">
            <span class="stat-value">${patternAnalysis.themes.length}</span>
            <span class="stat-label">Failure Themes</span>
          </div>
          <div class="summary-stat">
            <span class="stat-value">${patternAnalysis.patterns.length}</span>
            <span class="stat-label">Patterns Found</span>
          </div>
        </div>

        ${patternAnalysis.themes.length > 0 ? `
          <div class="analysis-section">
            <h4><i class="fas fa-tags"></i> Top Failure Themes</h4>
            <ul class="theme-list">
              ${patternAnalysis.themes.slice(0, 5).map(t => `
                <li>${this.escapeHtml(t.theme)} <span class="badge">${t.count}</span></li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        ${llmAnalysis?.root_causes ? `
          <div class="analysis-section">
            <h4><i class="fas fa-lightbulb"></i> Root Causes (AI Analysis)</h4>
            <ul class="root-causes">
              ${llmAnalysis.root_causes.map(cause => `
                <li>${this.escapeHtml(cause)}</li>
              `).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Step 2: Current vs Suggested (Side-by-side)
   */
  renderStep2() {
    const currentPrompt = this.analysisData?.prompt?.systemPrompt || '';
    
    return `
      <div class="wizard-step comparison-step">
        <h3><i class="fas fa-columns"></i> Current vs Suggested</h3>
        
        <div class="prompt-comparison">
          <div class="prompt-column">
            <h4>Current Prompt (v${this.promptVersion})</h4>
            <div class="prompt-box current-prompt">
              <pre>${this.escapeHtml(currentPrompt)}</pre>
            </div>
          </div>
          
          <div class="comparison-divider">
            <i class="fas fa-arrow-right"></i>
          </div>
          
          <div class="prompt-column">
            <h4>AI-Suggested Improvement</h4>
            <div class="prompt-box suggested-prompt">
              <pre>${this.escapeHtml(this.suggestedPrompt)}</pre>
            </div>
          </div>
        </div>

        ${this.analysisData?.llmAnalysis?.improvement_suggestions ? `
          <div class="suggestions-section">
            <h4><i class="fas fa-list-check"></i> Key Improvements</h4>
            <ul class="suggestions-list">
              ${this.analysisData.llmAnalysis.improvement_suggestions.slice(0, 3).map(s => `
                <li>
                  <strong>${this.escapeHtml(s.category)}:</strong> 
                  ${this.escapeHtml(s.suggestion)}
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Step 3: Customize
   */
  renderStep3() {
    return `
      <div class="wizard-step customize-step">
        <h3><i class="fas fa-edit"></i> Customize Your Prompt</h3>
        <p>Review and modify the suggested prompt before creating a new version.</p>
        
        <div class="form-group">
          <label for="customPromptText">System Prompt</label>
          <textarea 
            id="customPromptText" 
            rows="15" 
            class="custom-prompt-textarea"
            placeholder="Enter your customized system prompt..."
          >${this.escapeHtml(this.customizedPrompt)}</textarea>
          <small class="form-hint">This will become version ${this.promptVersion + 1}</small>
        </div>

        <div class="form-group">
          <label for="promptDescription">Description (Optional)</label>
          <input 
            type="text" 
            id="promptDescription" 
            class="form-input"
            placeholder="e.g., Improved tone and accuracy based on user feedback"
          />
        </div>
      </div>
    `;
  }

  /**
   * Step 4: A/B Test Configuration
   */
  renderStep4() {
    return `
      <div class="wizard-step abtest-step">
        <h3><i class="fas fa-flask"></i> A/B Test Configuration</h3>
        <p>Want to test the new version against the current one?</p>
        
        <div class="abtest-option">
          <label class="checkbox-label">
            <input type="checkbox" id="enableABTest" ${this.enableABTest ? 'checked' : ''} />
            <span>Enable A/B Testing</span>
          </label>
          <p class="option-description">
            Split traffic between old and new versions to compare performance.
          </p>
        </div>

        <div id="abtestConfig" style="display: ${this.enableABTest ? 'block' : 'none'}">
          <div class="form-group">
            <label>Traffic Split</label>
            <div class="traffic-slider">
              <div class="slider-labels">
                <span>v${this.promptVersion}: <strong id="oldTraffic">50</strong>%</span>
                <span>v${this.promptVersion + 1}: <strong id="newTraffic">50</strong>%</span>
              </div>
              <input 
                type="range" 
                id="trafficSlider" 
                min="10" 
                max="90" 
                value="${this.trafficSplit}" 
                class="traffic-range"
              />
            </div>
          </div>

          <div class="abtest-info">
            <i class="fas fa-info-circle"></i>
            <p>A/B test will run until you manually deactivate one version.</p>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Step 5: Confirmation
   */
  renderStep5() {
    return `
      <div class="wizard-step confirm-step">
        <div class="confirm-icon">
          <i class="fas fa-check-circle"></i>
        </div>
        <h3>Ready to Create?</h3>
        
        <div class="confirm-summary">
          <div class="summary-item">
            <span class="summary-label">Prompt Name:</span>
            <span class="summary-value">${this.escapeHtml(this.promptName)}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">New Version:</span>
            <span class="summary-value">v${this.promptVersion + 1}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">A/B Test:</span>
            <span class="summary-value">${this.enableABTest ? `Yes (${this.trafficSplit}/${100 - this.trafficSplit} split)` : 'No'}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Status:</span>
            <span class="summary-value">${this.enableABTest ? 'Active (A/B Test)' : 'Inactive'}</span>
          </div>
        </div>

        <div class="confirm-preview">
          <h4>Prompt Preview:</h4>
          <div class="prompt-preview-box">
            <pre>${this.escapeHtml(this.customizedPrompt.substring(0, 300))}${this.customizedPrompt.length > 300 ? '...' : ''}</pre>
          </div>
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
    const canProceed = !this.loading && this.analysisData && !this.analysisData.error;

    return `
      <button 
        class="btn-secondary" 
        id="btnBack" 
        ${isFirstStep || this.loading ? 'disabled' : ''}
      >
        <i class="fas fa-arrow-left"></i> Back
      </button>
      
      ${isLastStep ? `
        <button class="btn-primary" id="btnCreate" ${!canProceed ? 'disabled' : ''}>
          <i class="fas fa-check"></i> Create Improved Version
        </button>
      ` : `
        <button class="btn-primary" id="btnNext" ${!canProceed ? 'disabled' : ''}>
          Next <i class="fas fa-arrow-right"></i>
        </button>
      `}
    `;
  }

  /**
   * Attach step-specific event listeners
   */
  attachStepListeners() {
    const btnBack = document.getElementById('btnBack');
    const btnNext = document.getElementById('btnNext');
    const btnCreate = document.getElementById('btnCreate');

    if (btnBack) {
      btnBack.addEventListener('click', () => this.previousStep());
    }

    if (btnNext) {
      btnNext.addEventListener('click', () => this.nextStep());
    }

    if (btnCreate) {
      btnCreate.addEventListener('click', () => this.createImprovedVersion());
    }

    // Step-specific listeners
    if (this.currentStep === 3) {
      const textarea = document.getElementById('customPromptText');
      if (textarea) {
        textarea.addEventListener('input', (e) => {
          this.customizedPrompt = e.target.value;
        });
      }
    }

    if (this.currentStep === 4) {
      const enableCheckbox = document.getElementById('enableABTest');
      const trafficSlider = document.getElementById('trafficSlider');
      const configSection = document.getElementById('abtestConfig');

      if (enableCheckbox) {
        enableCheckbox.addEventListener('change', (e) => {
          this.enableABTest = e.target.checked;
          if (configSection) {
            configSection.style.display = e.target.checked ? 'block' : 'none';
          }
        });
      }

      if (trafficSlider) {
        trafficSlider.addEventListener('input', (e) => {
          const newTraffic = parseInt(e.target.value);
          const oldTraffic = 100 - newTraffic;
          this.trafficSplit = newTraffic;
          
          document.getElementById('oldTraffic').textContent = oldTraffic;
          document.getElementById('newTraffic').textContent = newTraffic;
        });
      }
    }
  }

  /**
   * Navigate to next step
   */
  nextStep() {
    if (this.currentStep < this.totalSteps) {
      this.currentStep++;
      this.renderStep();
    }
  }

  /**
   * Navigate to previous step
   */
  previousStep() {
    if (this.currentStep > 1) {
      this.currentStep--;
      this.renderStep();
    }
  }

  /**
   * Create the improved prompt version
   */
  async createImprovedVersion() {
    try {
      this.toast.show('Creating improved version...', 'info');

      // Get description from step 3
      const description = document.getElementById('promptDescription')?.value || 
                         `Improved version based on failure analysis`;

      // Create new version
      const createResponse = await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: this.promptName,
          systemPrompt: this.customizedPrompt,
          description,
          isActive: this.enableABTest, // Activate if A/B testing
          trafficWeight: this.enableABTest ? this.trafficSplit : 100
        })
      });

      if (!createResponse.ok) throw new Error('Failed to create prompt');
      const createResult = await createResponse.json();
      const newVersion = createResult?.data?.version || this.promptVersion + 1;

      // If A/B testing, update old version's traffic weight
      if (this.enableABTest) {
        const oldTraffic = 100 - this.trafficSplit;
        const abResponse = await fetch(`/api/prompts/${encodeURIComponent(this.promptName)}/ab-test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            versions: [
              { version: this.promptVersion, weight: oldTraffic },
              { version: newVersion, weight: this.trafficSplit }
            ]
          })
        });
        if (!abResponse.ok) {
          const errorPayload = await abResponse.json().catch(() => ({}));
          throw new Error(errorPayload.message || 'Failed to configure A/B test');
        }
      }

      this.toast.success('Improved version created successfully!');
      
      // Broadcast event to refresh UI
      document.dispatchEvent(new CustomEvent('prompt-version-changed'));
      
      this.close();

    } catch (error) {
      console.error('Failed to create version:', error);
      this.toast.error(`Failed to create version: ${error.message}`);
    }
  }

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
