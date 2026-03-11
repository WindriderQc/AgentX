# E2E Tests for AgentX

This directory is the navigation hub for the AgentX Playwright test suite.

## Start Here

- [QUICKSTART.md](./QUICKSTART.md) - Fast setup and first run.
- [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) - Command-oriented cheat sheet.
- [TESTING_GUIDE.md](./TESTING_GUIDE.md) - Deep-dive guide for the export/import E2E flow.
- [SETUP.md](./SETUP.md) - Environment and setup details.

## Suite-Specific Detail

- [ADVANCED_FILTERING_TESTS.md](./ADVANCED_FILTERING_TESTS.md) - Advanced filtering suite coverage and references.
- [PERFORMANCE_DASHBOARD_TESTS.md](./PERFORMANCE_DASHBOARD_TESTS.md) - Performance dashboard suite coverage and references.
- [TEST_SUMMARY.md](./TEST_SUMMARY.md) - High-level completion/status snapshot.
- [TEST_CHECKLIST.md](./TEST_CHECKLIST.md) - Checklist-style validation reference.
- [EXPORT_IMPORT_TEST_SUMMARY.md](./EXPORT_IMPORT_TEST_SUMMARY.md) - Export/import suite summary.
- [IMPLEMENTATION_REPORT.md](./IMPLEMENTATION_REPORT.md) - Implementation notes and historical context.

## Core Commands

```bash
npm run test:e2e:playwright
npm run test:e2e:playwright:ui
npm run test:e2e:playwright:headed
npm run test:e2e:playwright:debug
npm run test:e2e:playwright:report
```

## Why This File Is Short

This README previously repeated suite coverage, setup steps, debugging notes, and best practices that already existed in the dedicated test documents. Keeping the detailed content in those per-topic files reduces drift and keeps this page focused on navigation.
6. Add appropriate assertions and error messages

## Test Coverage

### Onboarding Wizard
- ✅ Auto-trigger logic
- ✅ Manual trigger
- ✅ All step navigation
- ✅ Form validation (all rules)
- ✅ Skip functionality
- ✅ Prompt creation API
- ✅ localStorage persistence
- ✅ User preferences
- ✅ UI control synchronization
- ✅ Progress indicators

Total: **10 comprehensive test scenarios** covering all major user flows.

### Performance Metrics Dashboard
- ✅ Dashboard rendering on page load
- ✅ Time range selector (7d, 30d, 90d, all time)
- ✅ Auto-refresh toggle (on/off)
- ✅ Collapse/expand functionality
- ✅ Metric cards display and formatting
- ✅ Navigation to analytics page
- ✅ Empty state handling
- ✅ Error state handling (500, 401, etc.)
- ✅ Refresh button functionality
- ✅ Loading state indicators
- ✅ Data integrity (XSS prevention, number formatting)
- ✅ Accessibility (ARIA labels, keyboard navigation)

Total: **50+ test cases** covering all dashboard functionality and edge cases.
