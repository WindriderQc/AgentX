/**
 * CategoryBadge Component
 * Reusable category badge with confidence indicator (visual ring + percentage)
 * Used across benchmark and categorization pages
 */

const CategoryBadge = (() => {
    const CATEGORY_CONFIG = {
        coding: { color: '#7c9fff', icon: '💻', label: 'Coding' },
        reasoning: { color: '#a78bfa', icon: '🧠', label: 'Reasoning' },
        factual: { color: '#34d399', icon: '📚', label: 'Factual' },
        math: { color: '#fbbf24', icon: '🔢', label: 'Math' },
        creative: { color: '#f87171', icon: '✨', label: 'Creative' },
        general: { color: '#94a3b8', icon: '📝', label: 'General' }
    };

    /**
     * Get confidence level class based on percentage
     */
    const getConfidenceLevel = (confidence) => {
        if (confidence >= 80) return 'high';
        if (confidence >= 60) return 'medium';
        if (confidence >= 40) return 'low';
        return 'very-low';
    };

    /**
     * Create a confidence ring SVG
     */
    const createConfidenceRing = (confidence, color) => {
        const radius = 18;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (confidence / 100) * circumference;
        
        return `
            <svg class="confidence-ring" width="44" height="44" viewBox="0 0 44 44">
                <circle class="confidence-ring-bg" cx="22" cy="22" r="${radius}" 
                    stroke="rgba(255,255,255,0.08)" stroke-width="3" fill="none"/>
                <circle class="confidence-ring-progress" cx="22" cy="22" r="${radius}" 
                    stroke="${color}" stroke-width="3" fill="none"
                    stroke-dasharray="${circumference}"
                    stroke-dashoffset="${offset}"
                    stroke-linecap="round"
                    transform="rotate(-90 22 22)"
                    style="transition: stroke-dashoffset 0.6s ease;"/>
                <text x="22" y="22" text-anchor="middle" dy="0.3em" 
                    style="font-size: 9px; font-weight: 600; fill: ${color};">
                    ${confidence}%
                </text>
            </svg>
        `;
    };

    /**
     * Generate a rich tooltip with benchmark breakdown
     */
    const createTooltip = (category, confidence, benchmarkScores = null) => {
        const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.general;
        let tooltip = `
            <div class="category-tooltip">
                <div class="tooltip-header">
                    <span class="tooltip-icon">${config.icon}</span>
                    <span class="tooltip-title">${config.label}</span>
                </div>
                <div class="tooltip-confidence">
                    <span class="confidence-label">Confidence:</span>
                    <span class="confidence-value">${confidence}%</span>
                </div>
        `;

        if (benchmarkScores && Object.keys(benchmarkScores).length > 0) {
            tooltip += `<div class="tooltip-scores">`;
            tooltip += `<div class="scores-title">Based on benchmarks:</div>`;
            for (const [benchmark, score] of Object.entries(benchmarkScores)) {
                const barWidth = Math.min(score, 100);
                tooltip += `
                    <div class="score-row">
                        <span class="score-name">${benchmark}</span>
                        <span class="score-bar">
                            <span class="score-fill" style="width: ${barWidth}%; background: ${config.color};"></span>
                        </span>
                        <span class="score-value">${score}%</span>
                    </div>
                `;
            }
            tooltip += `</div>`;
        }

        tooltip += `</div>`;
        return tooltip;
    };

    /**
     * Render a category badge
     * @param {string} category - Category name (e.g., 'coding', 'reasoning')
     * @param {number} confidence - Confidence percentage (0-100)
     * @param {object} options - Additional options
     * @param {object} options.benchmarkScores - Benchmark scores for tooltip (e.g., { "HumanEval": 85, "MBPP": 78 })
     * @param {boolean} options.showRing - Show confidence ring (default: true)
     * @param {boolean} options.showPercentage - Show percentage text (default: false, shown in ring)
     * @param {boolean} options.interactive - Enable hover effects (default: true)
     * @param {boolean} options.animated - Enable entrance animation (default: true)
     * @param {string} options.size - Size variant: 'small', 'medium', 'large' (default: 'medium')
     * @returns {string} HTML string for the badge
     */
    const render = (category, confidence = null, options = {}) => {
        // Handle empty/null category
        if (!category) {
            return '<span class="category-badge-empty">—</span>';
        }

        const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.general;
        const {
            benchmarkScores = null,
            showRing = true,
            showPercentage = false,
            interactive = true,
            animated = true,
            size = 'medium'
        } = options;

        const hasConfidence = confidence !== null && confidence !== undefined;
        const confidenceLevel = hasConfidence ? getConfidenceLevel(confidence) : '';
        const tooltip = hasConfidence ? createTooltip(category, confidence, benchmarkScores) : '';

        let badgeClasses = ['category-badge', `category-${category}`, `size-${size}`];
        if (hasConfidence) badgeClasses.push(`confidence-${confidenceLevel}`);
        if (interactive) badgeClasses.push('interactive');
        if (animated) badgeClasses.push('animated');

        let badgeHtml = `
            <div class="${badgeClasses.join(' ')}" 
                data-category="${category}" 
                ${hasConfidence ? `data-confidence="${confidence}"` : ''}
                style="--badge-color: ${config.color};">
        `;

        // Optional confidence ring
        if (showRing && hasConfidence) {
            badgeHtml += `
                <div class="badge-ring-wrapper">
                    ${createConfidenceRing(confidence, config.color)}
                </div>
            `;
        }

        // Badge content
        badgeHtml += `
            <div class="badge-content">
                <span class="badge-icon">${config.icon}</span>
                <span class="badge-label">${config.label}</span>
                ${showPercentage && hasConfidence ? `<span class="badge-percentage">${confidence}%</span>` : ''}
            </div>
        `;

        // Tooltip
        if (tooltip && interactive) {
            badgeHtml += tooltip;
        }

        badgeHtml += `</div>`;

        return badgeHtml;
    };

    /**
     * Render a simple badge without confidence (for manual categories)
     */
    const renderSimple = (category, options = {}) => {
        const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.general;
        const { size = 'small', interactive = false } = options;

        return `
            <span class="category-badge-simple size-${size} ${interactive ? 'interactive' : ''}" 
                data-category="${category}"
                style="
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 4px 10px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, ${config.color}22 0%, ${config.color}11 100%);
                    border: 1px solid ${config.color}44;
                    color: ${config.color};
                    font-size: 0.85em;
                    font-weight: 600;
                    transition: all 0.2s ease;
                ">
                ${config.icon} ${config.label}
            </span>
        `;
    };

    /**
     * Get configuration for a category
     */
    const getConfig = (category) => {
        return CATEGORY_CONFIG[category] || CATEGORY_CONFIG.general;
    };

    /**
     * Get all categories
     */
    const getAllCategories = () => {
        return Object.keys(CATEGORY_CONFIG);
    };

    // Public API
    return {
        render,
        renderSimple,
        getConfig,
        getAllCategories,
        CATEGORY_CONFIG
    };
})();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CategoryBadge;
}
