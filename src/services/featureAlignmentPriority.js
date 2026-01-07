const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let n8nWorkflowsCache = null;

// Known false positive orphan endpoints - these ARE used
const FALSE_POSITIVE_ENDPOINTS = [
  // Phase 1 Alignment: These are now detected dynamically by the scanner.
  // Keeping list empty to verify dynamic detection.
];

// Known API-only endpoints (by design, not orphaned)
const API_ONLY_ENDPOINTS = [
  'GET /api/models/routing',
  'POST /api/models/classify',
  'GET /api/models/health'
];

function getN8nWorkflows(rootDir) {
  if (n8nWorkflowsCache) return n8nWorkflowsCache;

  const operationsFile = path.join(rootDir, 'routes/operations.js');
  try {
    const content = fs.readFileSync(operationsFile, 'utf8');
    const match = content.match(/const WORKFLOWS = (\[[\s\S]*?\]);/);
    if (match) {
      // Use eval safely-ish since we know the content format or just parse strict JSON if possible
      // but the file is JS. So we use loose parsing or matchAll
      const workflows = [];
      const regex = /\{ id: '([^']+)', name: '([^']+)', webhook: '([^']+)'/g;
      let m;
      while ((m = regex.exec(match[1])) !== null) {
        workflows.push({ id: m[1], name: m[2], webhook: m[3] });
      }
      n8nWorkflowsCache = workflows;
      return workflows;
    }
  } catch (err) {
    // ignore
  }
  return [];
}

function getLastModifiedDate(filePath, rootDir) {
  try {
    const relPath = path.relative(rootDir, filePath);
    const cmd = `git log -1 --format=%ct -- ${relPath}`;
    const output = execSync(cmd, { cwd: rootDir, encoding: 'utf8' }).trim();

    if (!output) return 0; // No commits
    return parseInt(output, 10) * 1000;
  } catch (err) {
    return 0;
  }
}

function getGitActivityScore(files, rootDir) {
  if (!files || files.length === 0) return 0;

  try {
    // Get latest commit date for any of the files
    let latestTime = 0;
    for (const file of files) {
      const modTime = getLastModifiedDate(file, rootDir);
      if (modTime > latestTime) latestTime = modTime;
    }

    if (latestTime === 0) return 0; // No commits

    const now = Date.now();
    const diffDays = (now - latestTime) / (1000 * 60 * 60 * 24);

    if (diffDays <= 7) return 15;
    if (diffDays <= 30) return 10;
    if (diffDays <= 90) return 5;
    return 0;
  } catch (err) {
    // git might fail if not a repo or files not tracked
    return 0;
  }
}

function checkSecurityRequirements(files) {
  let score = 0;
  if (!files) return 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('requireAuth')) {
        score += 10;
        break; // Max 10 here
      }
    } catch (e) { }
  }

  // Check for admin keywords loosely if we want extra
  // But spec says "admin-only endpoints: +5".
  // Hard to detect strictly without more parsing, but we can look for 'role: admin' or similar
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('admin') || content.includes('isAdmin')) {
        score += 5;
        break; 
      }
    } catch (e) { }
  }
  
  return Math.min(score, 15); // Cap at 15
}

function isN8nEndpoint(endpoint, workflows) {
  // Check if endpoint path includes n8n webhook URLs
  for (const wf of workflows) {
    if (endpoint.path.includes(wf.webhook)) {
      return true;
    }
  }
  return false;
}

function matchN8nUsage(feature, workflows) {
  const endpoints = feature.backend?.endpoints || feature.backendHits || [];

  // Check if feature endpoints are CALLED BY n8n (positive score)
  // vs endpoints that ARE n8n webhooks (negative score)
  let isUsedByN8n = false;
  let isN8nWebhook = false;

  const featureName = feature.key.toLowerCase();

  // Check if feature name matches n8n workflow names (feature used BY n8n)
  for (const wf of workflows) {
    if (featureName.includes(wf.name.toLowerCase()) || wf.name.toLowerCase().includes(featureName)) {
      isUsedByN8n = true;
      break;
    }
    // Also check keys/ids
    if (featureName.includes(wf.id.toLowerCase())) {
      isUsedByN8n = true;
      break;
    }
  }

  // Check if any endpoints ARE n8n webhooks (API-only, negative score)
  for (const ep of endpoints) {
    if (isN8nEndpoint(ep, workflows)) {
      isN8nWebhook = true;
      break;
    }
  }

  // Return score based on usage type
  if (isN8nWebhook) return -30; // Negative for n8n webhook endpoints (API-only)
  if (isUsedByN8n) return 30;   // Positive for features used BY n8n
  return 0;
}

function calculatePriority(feature, rootDir) {
  let score = 0;
  const debug = {};

  // Standardize access according to spec
  const endpoints = feature.backend?.endpoints || feature.backendHits || [];
  const services = feature.backend?.services || feature.backendServices || [];
  const frontendFiles = feature.frontend?.files || feature.frontend || [];
  const docs = feature.docs?.files || feature.docs || [];
  const status = feature.status || 'unknown';

  // 1. n8n Workflow Usage (±30 pts)
  const workflows = getN8nWorkflows(rootDir);
  const n8nScore = matchN8nUsage(feature, workflows);
  score += n8nScore;
  debug.n8n = n8nScore;

  // 2. Endpoint Count (Max 40 pts)
  // 10 pts per endpoint
  const epCount = endpoints.length;
  let epScore = Math.min(epCount * 10, 40);
  score += epScore;
  debug.endpoints = epScore;

  // 3. Documentation (15 pts)
  let docScore = 0;
  if (docs.length > 0) {
    docScore = 15;
  }
  score += docScore;
  debug.docs = docScore;

  // 4. Security/Admin Requirements (Max 15 pts)
  // Combine all backend files (services + endpoints)
  const uniqueRelativeFiles = new Set();
  endpoints.forEach(ep => {
    if (ep.sourceFile) uniqueRelativeFiles.add(ep.sourceFile);
  });
  services.forEach(s => {
    if (s) uniqueRelativeFiles.add(s);
  });
  
  const allBackendFiles = Array.from(uniqueRelativeFiles)
    .filter(f => !!f)
    .map(f => path.isAbsolute(f) ? f : path.join(rootDir, f));

  // Check for requireAuth (+10) and admin (+5) in ALL backend files
  const securityScore = checkSecurityRequirements(allBackendFiles);
  score += securityScore;
  debug.security = securityScore;

  // 5. Recent Activity (Max 15 pts)
  const activityScore = getGitActivityScore(allBackendFiles, rootDir);
  score += activityScore;
  debug.activity = activityScore;

  // 6. False Positive Penalty (-15 pts)
  // If orphan but has frontend (Orphan in this context usually means 'headless' or 'orphan' feature status)
  let falsePositivePenalty = 0;
  if ((status.includes('orphan') || status.includes('headless')) && frontendFiles.length > 0) {
    falsePositivePenalty = -15;
    score += falsePositivePenalty;
  }
  debug.falsePositive = falsePositivePenalty;

  // 7. UI Detection Penalty (-20 pts)
  // If headless but has frontend files (redundant check potentially, but specific penalty required)
  let uiPenalty = 0;
  if (frontendFiles.length > 0) {
    // If it has frontend files, it essentially HAS a UI, so it shouldn't show up as a "Headless Feature to build"
    uiPenalty = -20;
    score += uiPenalty;
  }
  debug.ui = uiPenalty;

  // Determine Level and Category
  let level = 'LOW';
  let category = 'low';

  // Calculate if this is API-only (n8n webhook or known API-only endpoints)
  const isApiOnly = n8nScore < 0 || endpoints.some(ep => {
    const epKey = `${ep.method} ${ep.path}`;
    return API_ONLY_ENDPOINTS.includes(epKey);
  });

  if (isApiOnly) {
    category = 'api-only';
    level = 'API-ONLY';
  } else if (score >= 70) {
    level = 'CRITICAL';
    category = 'critical';
  } else if (score >= 50) {
    level = 'HIGH';
    category = 'high';
  } else if (score >= 30) {
    level = 'MEDIUM';
    category = 'medium';
  }

  // Complete features (have frontend and not explicitly headless/orphan)
  if (status === 'complete') {
    category = 'complete';
    level = 'COMPLETE';
  }

  return {
    score,
    level,
    category,
    breakdown: debug
  };
}

module.exports = {
  calculatePriority,
  FALSE_POSITIVE_ENDPOINTS,
  API_ONLY_ENDPOINTS
};
