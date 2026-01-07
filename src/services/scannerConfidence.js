const fs = require('fs');

/**
 * Calculates a confidence score (0-100) for an endpoint based on collected evidence.
 * 
 * @param {Object} endpoint - The endpoint definition ({ path, method }).
 * @param {Object} evidence - Collected evidence object.
 * @param {Object} evidence.frontend - Frontend detections { references: [], directFetch: bool, apiHelper: bool, htmlForm: bool }.
 * @param {Object} evidence.docs - Documentation detections { files: [], explicitMention: bool }.
 * @param {string} [evidence.featureKey] - The key of the feature this endpoint is associated with (for semantic matching).
 * @param {Date} [evidence.lastModified] - The most recent modification date of the evidence files.
 * @param {string} [evidence.detectionMethod] - 'auth-heuristic', etc.
 * 
 * @returns {Object} result - { score, breakdown, confidenceLabel }
 */
function calculateEndpointConfidence(endpoint, evidence) {
  let score = 0;
  const breakdown = {};

  // 1. Evidence Type (0-40 points)
  let evidenceScore = 0;
  if (evidence.frontend?.directFetch) evidenceScore += 20;      // fetch('/api/endpoint')
  if (evidence.frontend?.apiHelper) evidenceScore += 15;        // API.get('/api/endpoint')
  if (evidence.frontend?.htmlForm) evidenceScore += 15;         // <form action="/api/endpoint">
  if (evidence.docs?.explicitMention) evidenceScore += 10;      // Documented in specs
  breakdown.evidenceType = Math.min(evidenceScore, 40);
  score += breakdown.evidenceType;

  // 2. Evidence Count (0-20 points)
  const feRefs = evidence.frontend?.references?.length || 0;
  const docRefs = evidence.docs?.files?.length || 0;
  const evidenceCount = feRefs + docRefs;
  breakdown.evidenceCount = Math.min(evidenceCount * 5, 20);   // 5 pts per reference, max 20
  score += breakdown.evidenceCount;

  // 3. Semantic Match (0-20 points)
  // Use endpoint.path and evidence.featureKey
  const semanticScore = calculateSemanticMatch(endpoint.path, evidence.featureKey);
  breakdown.semanticMatch = semanticScore;
  score += semanticScore;

  // 4. Recency (0-10 points)
  const recencyScore = calculateRecencyScore(evidence.lastModified);
  breakdown.recency = recencyScore;
  score += recencyScore;

  // 5. Auth Pattern Heuristic Penalty (-10 points)
  if (evidence.detectionMethod === 'auth-heuristic') {
    breakdown.authHeuristic = -10;
    score -= 10;
  }

  // 6. No Evidence Penalty (-30 points)
  if (evidenceCount === 0 && !evidence.frontend?.directFetch && !evidence.frontend?.apiHelper && !evidence.frontend?.htmlForm && !evidence.docs?.explicitMention) {
    breakdown.noEvidence = -30;
    // score -= 30; // Wait, if I subtract 30 from 0 (if nothing above triggered), it goes negative.
    // The instructions say "if evidenceCount === 0 && !evidence.frontend && !evidence.docs", then -30.
    // But then score is likely 0 initially or just recency/semantic. 
    // And finally calculateEndpointConfidence clamps output 0-100.
    // Let's stick to the instruction logic.
    score -= 30;
  }

  const finalScore = Math.max(0, Math.min(100, score));

  return {
    score: finalScore,
    breakdown,
    confidence: getConfidenceLabel(finalScore)
  };
}

// Helper: Semantic match between endpoint path and feature name
function calculateSemanticMatch(endpointPath, featureKey) {
  if (!endpointPath || !featureKey) return 0;

  // Normalize paths
  const pathParts = endpointPath.toLowerCase().split('/').filter(Boolean);
  const featureParts = featureKey.toLowerCase().split('-');

  // Check for exact matches
  let exactMatches = 0;
  for (const part of featureParts) {
    if (pathParts.includes(part)) exactMatches++;
  }

  // Score: 10 points per match, max 20
  // Reward any strong semantic link regardless of feature name length
  if (featureParts.length === 0) return 0;
  
  // Bonus for complete match (e.g. 'auth' matching '/api/auth')
  if (exactMatches === featureParts.length && exactMatches > 0) return 20;

  return Math.min(exactMatches * 10, 20);
}

// Helper: Recency scoring based on last modified date
function calculateRecencyScore(lastModified) {
  if (!lastModified) return 0;

  const daysSince = (Date.now() - new Date(lastModified).getTime()) / (1000 * 60 * 60 * 24);

  if (daysSince <= 7) return 10;       // Modified this week
  if (daysSince <= 30) return 7;       // Modified this month
  if (daysSince <= 90) return 5;       // Modified this quarter
  return 2;                             // Older than 90 days
}

// Helper: Confidence label
function getConfidenceLabel(score) {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  if (score >= 20) return 'low';
  return 'very-low';
}

module.exports = {
  calculateEndpointConfidence
};
