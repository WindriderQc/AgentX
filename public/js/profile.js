/**
 * Profile Management Page
 * Handles user profile CRUD operations and preview
 */

import { showToast } from './utils.js';

// State
let currentProfile = null;
let availableModels = [];

/**
 * Initialize page on load
 */
document.addEventListener('DOMContentLoaded', async () => {
  await loadProfile();
  await loadModels();
  attachEventListeners();
  updatePreview();
});

/**
 * Load current user profile
 */
async function loadProfile() {
  try {
    const response = await fetch('/api/profile', {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.status === 'success') {
      currentProfile = result.data;
      populateForm(currentProfile);
    } else {
      throw new Error(result.message || 'Failed to load profile');
    }
  } catch (error) {
    console.error('Failed to load profile:', error);
    showToast(`Failed to load profile: ${error.message}`, 'error');
  }
}

/**
 * Load available Ollama models
 */
async function loadModels() {
  try {
    const response = await fetch('/api/models', {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    if (result.status === 'success') {
      availableModels = result.data || [];
      populateModelSelect(availableModels);
    }
  } catch (error) {
    console.error('Failed to load models:', error);
    // Don't show error toast for optional feature
  }
}

/**
 * Populate form fields with profile data
 */
function populateForm(profile) {
  document.getElementById('profileAbout').value = profile.about || '';
  document.getElementById('profileInstructions').value =
    profile.preferences?.customInstructions || '';
  document.getElementById('profileTheme').value =
    profile.preferences?.theme || 'dark';
  document.getElementById('profileDefaultModel').value =
    profile.preferences?.defaultModel || '';
}

/**
 * Populate model select dropdown
 */
function populateModelSelect(models) {
  const select = document.getElementById('profileDefaultModel');

  // Keep the default "-- Select Model --" option
  const defaultOption = select.querySelector('option[value=""]');
  select.innerHTML = '';
  select.appendChild(defaultOption);

  // Add model options
  models.forEach(model => {
    const option = document.createElement('option');
    option.value = model.name;
    option.textContent = model.name;
    select.appendChild(option);
  });

  // Restore selected value if it exists
  if (currentProfile?.preferences?.defaultModel) {
    select.value = currentProfile.preferences.defaultModel;
  }
}

/**
 * Attach event listeners
 */
function attachEventListeners() {
  // Save button
  document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);

  // Reset button
  document.getElementById('resetProfileBtn').addEventListener('click', resetProfile);

  // Update preview on input change
  ['profileAbout', 'profileInstructions'].forEach(id => {
    document.getElementById(id).addEventListener('input', updatePreview);
  });
}

/**
 * Save profile to server
 */
async function saveProfile() {
  const saveBtn = document.getElementById('saveProfileBtn');
  const originalText = saveBtn.innerHTML;

  try {
    // Show loading state
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    const profileData = {
      about: document.getElementById('profileAbout').value.trim(),
      preferences: {
        customInstructions: document.getElementById('profileInstructions').value.trim(),
        theme: document.getElementById('profileTheme').value,
        defaultModel: document.getElementById('profileDefaultModel').value
      }
    };

    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify(profileData)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.status === 'success') {
      currentProfile = result.data;
      showToast('Profile saved successfully!', 'success');
      updatePreview();
    } else {
      throw new Error(result.message || 'Failed to save profile');
    }
  } catch (error) {
    console.error('Failed to save profile:', error);
    showToast(`Failed to save profile: ${error.message}`, 'error');
  } finally {
    // Restore button state
    saveBtn.disabled = false;
    saveBtn.innerHTML = originalText;
  }
}

/**
 * Reset profile to defaults
 */
async function resetProfile() {
  if (!confirm('Are you sure you want to reset your profile to defaults? This will clear all your information.')) {
    return;
  }

  const resetBtn = document.getElementById('resetProfileBtn');
  const originalText = resetBtn.innerHTML;

  try {
    // Show loading state
    resetBtn.disabled = true;
    resetBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Resetting...';

    const defaultProfile = {
      about: '',
      preferences: {
        customInstructions: '',
        theme: 'dark',
        defaultModel: ''
      }
    };

    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify(defaultProfile)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.status === 'success') {
      currentProfile = result.data;
      populateForm(currentProfile);
      updatePreview();
      showToast('Profile reset to defaults', 'success');
    } else {
      throw new Error(result.message || 'Failed to reset profile');
    }
  } catch (error) {
    console.error('Failed to reset profile:', error);
    showToast(`Failed to reset profile: ${error.message}`, 'error');
  } finally {
    // Restore button state
    resetBtn.disabled = false;
    resetBtn.innerHTML = originalText;
  }
}

/**
 * Update preview of effective system prompt
 */
async function updatePreview() {
  const previewContent = document.getElementById('previewContent');

  const about = document.getElementById('profileAbout').value.trim();
  const instructions = document.getElementById('profileInstructions').value.trim();

  // Build preview showing how profile is injected
  let preview = '=== BASE SYSTEM PROMPT ===\n';
  preview += 'You are AgentX, a concise and capable local assistant. Keep answers brief and actionable.\n\n';

  if (about) {
    preview += '=== USER PROFILE (INJECTED) ===\n';
    preview += 'User Profile/Memory:\n';
    preview += about + '\n\n';
  }

  if (instructions) {
    preview += '=== CUSTOM INSTRUCTIONS (INJECTED) ===\n';
    preview += 'Custom Instructions:\n';
    preview += instructions + '\n\n';
  }

  if (!about && !instructions) {
    preview += '(No profile or custom instructions set - only base system prompt will be used)\n';
  }

  preview += '=== END EFFECTIVE SYSTEM PROMPT ===';

  previewContent.textContent = preview;
}
