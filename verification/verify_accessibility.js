const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Load the local index.html file directly
  // Adjust the path to absolute path for file:// protocol
  const absolutePath = process.cwd() + '/public/index.html';
  await page.goto('file://' + absolutePath);

  // Wait for the page to load
  await page.waitForLoadState('domcontentloaded');

  console.log('Checking for aria-labels...');

  const checks = [
    { selector: '#messageInput', expected: 'Message to AgentX' },
    { selector: '.alert-dismiss', expected: 'Dismiss profile alert' },
    { selector: '.checklist-dismiss', expected: 'Dismiss setup checklist' },
    { selector: '#closeProfileBtn', expected: 'Close profile modal' },
    { selector: '#filterTagsInput', expected: 'Filter tags' },
    { selector: '#userAbout', expected: 'User about me' },
    { selector: '#userInstructions', expected: 'User custom instructions' }
  ];

  let passed = 0;
  for (const check of checks) {
    const element = await page.$(check.selector);
    if (element) {
      const ariaLabel = await element.getAttribute('aria-label');
      if (ariaLabel === check.expected) {
        console.log(`✅ ${check.selector} has correct aria-label: "${ariaLabel}"`);
        passed++;
      } else {
        console.error(`❌ ${check.selector} has WRONG aria-label: "${ariaLabel}" (expected "${check.expected}")`);
      }
    } else {
      console.error(`❌ Element ${check.selector} NOT FOUND`);
    }
  }

  // Take a screenshot of the main chat area to verify it looks normal
  await page.screenshot({ path: 'verification/accessibility_check.png' });

  console.log(`\nVerification complete: ${passed}/${checks.length} checks passed.`);

  await browser.close();

  if (passed === checks.length) {
    process.exit(0);
  } else {
    process.exit(1);
  }
})();
