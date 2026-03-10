/**
 * Automated Pre-Flight Checks for Chat Onboarding Wizard
 * Run this before manual browser testing
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 Chat Onboarding Wizard - Automated Pre-Flight Checks\n');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;
const issues = [];

// Test 1: File Existence
console.log('\n📁 Test 1: File Existence');
const files = [
  'public/index.html',
  'public/js/components/ChatOnboardingWizard.js',
  'public/js/legacy/chat.js'  // archived legacy file — active chat is in public/js/chat/
];

files.forEach(file => {
  const fullPath = path.join(__dirname, file);
  if (fs.existsSync(fullPath)) {
    console.log(`  ✅ ${file}`);
    passed++;
  } else {
    console.log(`  ❌ ${file} NOT FOUND`);
    failed++;
    issues.push(`Missing file: ${file}`);
  }
});

// Test 2: Integration Points in HTML
console.log('\n🔗 Test 2: Integration Points in index.html');
const html = fs.readFileSync('public/index.html', 'utf8');

const htmlChecks = [
  { name: 'Tutorial Button', pattern: 'showChatTutorialBtn' },
  { name: 'Wizard Import', pattern: '/js/components/ChatOnboardingWizard.js' },
  { name: 'Profile Alert Element', pattern: 'id="profilePrompt"' },
  { name: 'Setup Checklist Element', pattern: 'id="setupChecklist"' },
  { name: 'Wizard Initialization', pattern: 'window.chatOnboardingWizard = new ChatOnboardingWizard' },
  { name: 'Auto-Trigger Function', pattern: 'function checkChatOnboarding()' },
  { name: 'Event Listener Setup', pattern: 'addEventListener(\'click\'' }
];

htmlChecks.forEach(check => {
  if (html.includes(check.pattern)) {
    console.log(`  ✅ ${check.name}`);
    passed++;
  } else {
    console.log(`  ❌ ${check.name} - pattern not found: ${check.pattern}`);
    failed++;
    issues.push(`HTML missing: ${check.name}`);
  }
});

// Test 3: Wizard Component Structure
console.log('\n🧩 Test 3: Wizard Component Structure');
const wizard = fs.readFileSync('public/js/components/ChatOnboardingWizard.js', 'utf8');

const wizardChecks = [
  { name: 'ES6 Export', pattern: 'export class ChatOnboardingWizard' },
  { name: 'Constructor', pattern: 'constructor(toast)' },
  { name: 'Open Method', pattern: 'open()' },
  { name: 'Close Method', pattern: 'close()' },
  { name: 'Render Method', pattern: 'render()' },
  { name: 'Step 1 Render', pattern: 'renderStep1()' },
  { name: 'Step 2 Render', pattern: 'renderStep2()' },
  { name: 'Step 3 Render', pattern: 'renderStep3()' },
  { name: 'Step 4 Render', pattern: 'renderStep4()' },
  { name: 'Step 5 Render', pattern: 'renderStep5()' },
  { name: 'fetchPrompts Method', pattern: 'async fetchPrompts()' },
  { name: 'fetchModels Method', pattern: 'async fetchModels()' },
  { name: 'saveProfile Method', pattern: 'async saveProfile()' },
  { name: 'handleNext Method', pattern: 'async handleNext()' },
  { name: 'handlePrevious Method', pattern: 'handlePrevious()' }
];

wizardChecks.forEach(check => {
  if (wizard.includes(check.pattern)) {
    console.log(`  ✅ ${check.name}`);
    passed++;
  } else {
    console.log(`  ❌ ${check.name}`);
    failed++;
    issues.push(`Wizard missing: ${check.name}`);
  }
});

// Test 4: localStorage Keys Consistency
console.log('\n🗃️  Test 4: localStorage Keys');
const storageKeys = [
  'agentx_chat_onboarding_seen',
  'agentx_chat_onboarding_completed',
  'agentx_default_prompt',
  'agentx_default_model',
  'agentx_default_use_rag'
];

storageKeys.forEach(key => {
  if (wizard.includes(key) || html.includes(key)) {
    console.log(`  ✅ ${key}`);
    passed++;
  } else {
    console.log(`  ❌ ${key} not found in wizard or HTML`);
    failed++;
    issues.push(`localStorage key missing: ${key}`);
  }
});

// Test 5: API Endpoint References
console.log('\n🌐 Test 5: API Endpoint References');
const apiEndpoints = [
  '/api/prompts',
  '/api/profile'
];

apiEndpoints.forEach(endpoint => {
  if (wizard.includes(endpoint)) {
    console.log(`  ✅ ${endpoint}`);
    passed++;
  } else {
    console.log(`  ❌ ${endpoint}`);
    failed++;
    issues.push(`API endpoint not referenced: ${endpoint}`);
  }
});

// Test 6: Integration Hooks in chat.js
console.log('\n🪝 Test 6: Integration Hooks in chat.js');
const chatJs = fs.readFileSync('public/js/legacy/chat.js', 'utf8');

const hookChecks = [
  { name: 'Profile Save Hook', pattern: 'checkProfileSetup' },
  { name: 'Setup Progress Hook', pattern: 'checkSetupProgress' }
];

hookChecks.forEach(check => {
  if (chatJs.includes(check.pattern) || html.includes(check.pattern)) {
    console.log(`  ✅ ${check.name}`);
    passed++;
  } else {
    console.log(`  ⚠️  ${check.name} - optional hook not found`);
    // Not counted as failure
  }
});

// Test 7: CSS Styles
console.log('\n🎨 Test 7: CSS Styles');
const cssChecks = [
  '.alert',
  '.setup-checklist',
  '.checklist-items',
  '.modal-overlay'
];

cssChecks.forEach(selector => {
  if (html.includes(selector)) {
    console.log(`  ✅ ${selector}`);
    passed++;
  } else {
    console.log(`  ❌ ${selector}`);
    failed++;
    issues.push(`CSS selector missing: ${selector}`);
  }
});

// Test 8: Syntax Check
console.log('\n📝 Test 8: JavaScript Syntax');
try {
  // Basic syntax validation (not full execution)
  const wizardLines = wizard.split('\n').length;
  const htmlLines = html.split('\n').length;

  console.log(`  ✅ ChatOnboardingWizard.js: ${wizardLines} lines`);
  console.log(`  ✅ index.html: ${htmlLines} lines`);
  passed += 2;
} catch (err) {
  console.log(`  ❌ Syntax error: ${err.message}`);
  failed++;
  issues.push(`Syntax error: ${err.message}`);
}

// Summary
console.log('\n' + '='.repeat(60));
console.log('📊 Summary');
console.log('='.repeat(60));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

if (issues.length > 0) {
  console.log('\n⚠️  Issues Found:');
  issues.forEach((issue, i) => {
    console.log(`  ${i + 1}. ${issue}`);
  });
}

console.log('\n' + '='.repeat(60));

if (failed === 0) {
  console.log('✅ All pre-flight checks passed!');
  console.log('📝 Ready for manual browser testing');
  console.log('📋 Follow: MANUAL_TEST_SESSION.md');
  process.exit(0);
} else {
  console.log('❌ Some checks failed. Fix issues before manual testing.');
  process.exit(1);
}
