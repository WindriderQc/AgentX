/**
 * Benchmark Analytics - Configuration Presets
 * Load and apply benchmark configuration presets
 */

import { BENCHMARK_API } from './config.js';
import { showToast } from './utils.js';

/**
 * Load and display configuration presets
 */
export async function loadPresets() {
    try {
        const res = await fetch(`${BENCHMARK_API}/presets`);
        const { data } = await res.json();

        const container = document.getElementById('presetsContainer');
        if (!container) return;

        container.innerHTML = data.presets.map(preset => `
            <div class="preset-card">
                <div class="preset-header">
                    <h4>${preset.name}</h4>
                    <span class="preset-duration">${preset.estimated_duration}</span>
                </div>
                <p class="preset-description">${preset.description}</p>
                <div class="preset-config">
                    <div class="preset-badge">
                        <i class="fas fa-layer-group"></i> Levels: ${preset.config.levels.join(', ')}
                    </div>
                    <div class="preset-badge">
                        ${preset.config.quality_scoring
                            ? '<i class="fas fa-check-circle"></i> Quality Scoring'
                            : '<i class="fas fa-times-circle"></i> No Scoring'}
                    </div>
                </div>
                <div class="preset-recommended">
                    <i class="fas fa-lightbulb"></i> ${preset.recommended_for}
                </div>
                <button class="btn-preset" onclick="BenchmarkAnalytics.applyPreset('${preset.id}')">
                    <i class="fas fa-bolt"></i> Use Preset
                </button>
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to load presets:', err);
    }
}

/**
 * Apply a configuration preset
 */
export async function applyPreset(presetId) {
    try {
        const res = await fetch(`${BENCHMARK_API}/presets`);
        const { data } = await res.json();
        const preset = data.presets.find(p => p.id === presetId);

        if (!preset) return;

        // Apply levels
        [1, 2, 3, 4, 5].forEach(level => {
            const checkbox = document.getElementById(`level${level}`);
            if (checkbox) checkbox.checked = preset.config.levels.includes(level);
        });

        // Apply quality scoring
        const qualityCheckbox = document.getElementById('qualityScoring');
        if (qualityCheckbox) qualityCheckbox.checked = preset.config.quality_scoring;

        showToast(`Applied preset: ${preset.name}`, 'success');
    } catch (err) {
        console.error('Failed to apply preset:', err);
        showToast('Failed to apply preset', 'error');
    }
}
