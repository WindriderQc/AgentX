# Codebase Feature & Automation Audit (Generated)

Generated from `npm run scan:features` output to provide a full feature inventory and highlight what is still pending/headless.

## Inventory Summary

- Total features discovered: **298**
- Total orphan endpoints: **1**
- complete: **229**
- partial: **35**
- headless-documented: **33**
- orphan-backend: **1**

## Features That Should Be Prioritized (Headless/Partial/Orphan)

| Feature | Status | Priority score | Endpoint count | Suggested action |
|---|---:|---:|---:|---|
| dashboards | headless-documented | 80 | 9 | Build UI / UX layer |
| dataset | headless-documented | 80 | 4 | Build UI / UX layer |
| invitations | headless-documented | 80 | 6 | Build UI / UX layer |
| model-registry | headless-documented | 80 | 12 | Build UI / UX layer |
| model-routing | headless-documented | 75 | 3 | Build UI / UX layer |
| diagnostics | headless-documented | 70 | 12 | Build UI / UX layer |
| notification-channels | headless-documented | 60 | 3 | Build UI / UX layer |
| voice | headless-documented | 60 | 4 | Build UI / UX layer |
| workflowgenerator | headless-documented | 60 | 4 | Build UI / UX layer |
| deployment | headless-documented | 55 | 0 | Build UI / UX layer |
| 01-architecture | headless-documented | 45 | 0 | Build UI / UX layer |
| ab-test-architecture-diagram | headless-documented | 45 | 0 | Build UI / UX layer |
| architecture-reality | headless-documented | 45 | 0 | Build UI / UX layer |
| brainx-deep-architecture | headless-documented | 45 | 0 | Build UI / UX layer |
| dimension-architecture | headless-documented | 45 | 0 | Build UI / UX layer |
| n6-1-architecture | headless-documented | 45 | 0 | Build UI / UX layer |
| sbqc-expansion-architecture | headless-documented | 45 | 0 | Build UI / UX layer |
| security-implementation | headless-documented | 45 | 0 | Build UI / UX layer |
| testing-patterns | headless-documented | 45 | 0 | Build UI / UX layer |
| v3-snapshot | headless-documented | 45 | 0 | Build UI / UX layer |
| claude | headless-documented | 40 | 0 | Build UI / UX layer |
| configvariant | orphan-backend | 40 | 3 | Validate endpoint ownership |
| contributing | headless-documented | 40 | 0 | Build UI / UX layer |
| security-hardening | headless-documented | 40 | 0 | Build UI / UX layer |
| security-hardening-phase2 | headless-documented | 40 | 0 | Build UI / UX layer |
| 00-overview | partial | 35 | 0 | Close implementation gaps |
| authentication-implementation | headless-documented | 35 | 0 | Build UI / UX layer |
| categorybadge | partial | 35 | 0 | Close implementation gaps |
| courthouse | partial | 35 | 0 | Close implementation gaps |
| imagegen | partial | 35 | 0 | Close implementation gaps |
| keyboard-shortcuts | partial | 35 | 0 | Close implementation gaps |
| model-explorer | partial | 35 | 0 | Close implementation gaps |
| onboardingwizard | partial | 35 | 0 | Close implementation gaps |
| shortcuts-modal | partial | 35 | 0 | Close implementation gaps |
| toast | partial | 35 | 0 | Close implementation gaps |
| v3-implementation | headless-documented | 35 | 0 | Build UI / UX layer |
| v4-implementation | headless-documented | 35 | 0 | Build UI / UX layer |
| 07-agentx-api-reference | headless-documented | 30 | 0 | Build UI / UX layer |
| authentication | headless-documented | 30 | 0 | Build UI / UX layer |
| reference | headless-documented | 30 | 0 | Build UI / UX layer |
| v4-contract | headless-documented | 30 | 0 | Build UI / UX layer |
| 05-deployment | headless-documented | 25 | 0 | Build UI / UX layer |
| fixes-applied | headless-documented | 25 | 0 | Build UI / UX layer |
| diagrams | partial | 15 | 0 | Close implementation gaps |
| quickstart | partial | 15 | 0 | Close implementation gaps |
| troubleshooting | partial | 15 | 0 | Close implementation gaps |
| troubleshooting-readme | partial | 15 | 0 | Close implementation gaps |
| abtestconfigpanel | partial | -5 | 0 | Close implementation gaps |
| agentlistview | partial | -5 | 0 | Close implementation gaps |
| baseonboardingwizard | partial | -5 | 0 | Close implementation gaps |
| chatonboardingwizard | partial | -5 | 0 | Close implementation gaps |
| conversationreviewmodal | partial | -5 | 0 | Close implementation gaps |
| databases | partial | -5 | 0 | Close implementation gaps |
| performancemetricsdashboard | partial | -5 | 0 | Close implementation gaps |
| prompteditormodal | partial | -5 | 0 | Close implementation gaps |
| prompthealthmonitor | partial | -5 | 0 | Close implementation gaps |
| promptimprovementwizard | partial | -5 | 0 | Close implementation gaps |
| promptlistview | partial | -5 | 0 | Close implementation gaps |
| promptsapi | partial | -5 | 0 | Close implementation gaps |
| templatetester | partial | -5 | 0 | Close implementation gaps |
| ui-enhancements | partial | -5 | 0 | Close implementation gaps |
| agentbuildermodal | partial | -20 | 0 | Close implementation gaps |
| agentxcard | partial | -20 | 0 | Close implementation gaps |
| commandpalette | partial | -20 | 0 | Close implementation gaps |
| executiontimeline | partial | -20 | 0 | Close implementation gaps |
| promptlibrarymodal | partial | -20 | 0 | Close implementation gaps |
| prompttemplatesapi | partial | -20 | 0 | Close implementation gaps |
| promptversioncompare | partial | -20 | 0 | Close implementation gaps |
| shortcutshelpmodal | partial | -20 | 0 | Close implementation gaps |

## Full Feature Enumeration (All Features)

### complete (229)

- 00-audit-summary _(endpoints: 17, frontend refs: 6, docs refs: 101)_
- 02-dataapi-tasks _(endpoints: 4, frontend refs: 3, docs refs: 60)_
- 03-agentx-tasks _(endpoints: 4, frontend refs: 1, docs refs: 27)_
- 04-n8n-workflows _(endpoints: 21, frontend refs: 2, docs refs: 87)_
- 06-agent-prompts _(endpoints: 26, frontend refs: 44, docs refs: 159)_
- 08-validation-plan _(endpoints: 0, frontend refs: 4, docs refs: 96)_
- accept-invitation _(endpoints: 6, frontend refs: 1, docs refs: 34)_
- admin-feed _(endpoints: 4, frontend refs: 4, docs refs: 69)_
- agent-integration-setup _(endpoints: 14, frontend refs: 41, docs refs: 169)_
- agent-library _(endpoints: 14, frontend refs: 42, docs refs: 151)_
- agent-prompt-for-validation _(endpoints: 46, frontend refs: 57, docs refs: 191)_
- agents _(endpoints: 14, frontend refs: 1, docs refs: 20)_
- agents-vs-personas _(endpoints: 14, frontend refs: 1, docs refs: 27)_
- alert-analytics _(endpoints: 42, frontend refs: 11, docs refs: 97)_
- alert-analytics-dashboard _(endpoints: 42, frontend refs: 11, docs refs: 97)_
- alerts _(endpoints: 14, frontend refs: 5, docs refs: 28)_
- alerts-dashboard _(endpoints: 14, frontend refs: 5, docs refs: 28)_
- alerts-dashboard-implementation _(endpoints: 14, frontend refs: 5, docs refs: 98)_
- alerts-integration-verification _(endpoints: 14, frontend refs: 6, docs refs: 131)_
- analytics _(endpoints: 28, frontend refs: 7, docs refs: 73)_
- api-client _(endpoints: 0, frontend refs: 1, docs refs: 30)_
- api-keys _(endpoints: 5, frontend refs: 1, docs refs: 22)_
- api-utils _(endpoints: 0, frontend refs: 6, docs refs: 13)_
- audit-logs _(endpoints: 10, frontend refs: 1, docs refs: 73)_
- authentication-implementation-details _(endpoints: 0, frontend refs: 10, docs refs: 131)_
- backend-overview _(endpoints: 1, frontend refs: 4, docs refs: 122)_
- backup _(endpoints: 15, frontend refs: 2, docs refs: 30)_
- batch-config _(endpoints: 13, frontend refs: 7, docs refs: 41)_
- batch-execution _(endpoints: 13, frontend refs: 9, docs refs: 68)_
- batches _(endpoints: 11, frontend refs: 1, docs refs: 13)_
- benchmark _(endpoints: 52, frontend refs: 4, docs refs: 47)_
- benchmark-api-enhanced _(endpoints: 52, frontend refs: 5, docs refs: 69)_
- benchmark-color-theme _(endpoints: 52, frontend refs: 5, docs refs: 84)_
- benchmark-colors-fixed _(endpoints: 52, frontend refs: 4, docs refs: 84)_
- benchmark-final-fix _(endpoints: 52, frontend refs: 5, docs refs: 111)_
- benchmark-judging-audit _(endpoints: 61, frontend refs: 5, docs refs: 69)_
- benchmark-judging-comparison _(endpoints: 52, frontend refs: 13, docs refs: 73)_
- benchmark-judging-final-review _(endpoints: 53, frontend refs: 14, docs refs: 106)_
- benchmark-peer-review _(endpoints: 53, frontend refs: 14, docs refs: 92)_
- benchmark-peer-review-v2 _(endpoints: 53, frontend refs: 14, docs refs: 92)_
- benchmark-quality-scoring _(endpoints: 52, frontend refs: 8, docs refs: 84)_
- benchmark-responsive-complete _(endpoints: 53, frontend refs: 7, docs refs: 138)_
- benchmark-system _(endpoints: 54, frontend refs: 9, docs refs: 152)_
- benchmark-ui-10-level-redesign _(endpoints: 52, frontend refs: 6, docs refs: 86)_
- brainx-system-prompt _(endpoints: 23, frontend refs: 25, docs refs: 167)_
- bug-fix-handoff _(endpoints: 1, frontend refs: 1, docs refs: 102)_
- bug-hunt-quick-ref _(endpoints: 3, frontend refs: 19, docs refs: 169)_
- cache _(endpoints: 8, frontend refs: 1, docs refs: 31)_
- categorization-test-summary _(endpoints: 8, frontend refs: 8, docs refs: 101)_
- categorization-tests _(endpoints: 0, frontend refs: 3, docs refs: 22)_
- categorization-validation _(endpoints: 0, frontend refs: 5, docs refs: 86)_
- category-badge-demo _(endpoints: 2, frontend refs: 19, docs refs: 72)_
- charts _(endpoints: 0, frontend refs: 3, docs refs: 34)_
- chat _(endpoints: 5, frontend refs: 7, docs refs: 102)_
- chat-onboarding-test-plan _(endpoints: 5, frontend refs: 13, docs refs: 132)_
- chat-shortcuts _(endpoints: 5, frontend refs: 12, docs refs: 107)_
- chat-v2 _(endpoints: 5, frontend refs: 7, docs refs: 102)_
- chatonboardingwizard-old _(endpoints: 0, frontend refs: 10, docs refs: 79)_
- ci-cd-setup _(endpoints: 0, frontend refs: 4, docs refs: 46)_
- compare-insights _(endpoints: 5, frontend refs: 10, docs refs: 46)_
- comparison _(endpoints: 0, frontend refs: 9, docs refs: 47)_
- config-optimizer _(endpoints: 0, frontend refs: 2, docs refs: 4)_
- contract-spec _(endpoints: 15, frontend refs: 6, docs refs: 134)_
- core _(endpoints: 5, frontend refs: 8, docs refs: 76)_
- cost-analytics-api _(endpoints: 28, frontend refs: 9, docs refs: 79)_
- cost-tracking _(endpoints: 1, frontend refs: 4, docs refs: 54)_
- cost-tracking-component-details _(endpoints: 1, frontend refs: 17, docs refs: 119)_
- cost-tracking-start-here _(endpoints: 2, frontend refs: 5, docs refs: 150)_
- courthouse-analytics _(endpoints: 28, frontend refs: 8, docs refs: 73)_
- critical-conventions _(endpoints: 0, frontend refs: 2, docs refs: 67)_
- critical-gotchas _(endpoints: 0, frontend refs: 2, docs refs: 63)_
- custom-dashboards-next-steps _(endpoints: 23, frontend refs: 10, docs refs: 124)_
- custom-models _(endpoints: 14, frontend refs: 6, docs refs: 69)_
- database _(endpoints: 1, frontend refs: 2, docs refs: 72)_
- database-viewer _(endpoints: 1, frontend refs: 2, docs refs: 80)_
- debug-persona-rendering _(endpoints: 1, frontend refs: 3, docs refs: 81)_
- demand-validation-survey _(endpoints: 0, frontend refs: 2, docs refs: 78)_
- deployment-readiness-checklist _(endpoints: 0, frontend refs: 1, docs refs: 85)_
- docjanitor _(endpoints: 4, frontend refs: 1, docs refs: 1)_
- dom-utils _(endpoints: 0, frontend refs: 6, docs refs: 44)_
- e2e-test-completion-report _(endpoints: 2, frontend refs: 1, docs refs: 93)_
- enhanced-judging-system-plan _(endpoints: 2, frontend refs: 8, docs refs: 160)_
- enhancements-complete _(endpoints: 1, frontend refs: 4, docs refs: 124)_
- export _(endpoints: 6, frontend refs: 15, docs refs: 57)_
- extraction-complete _(endpoints: 1, frontend refs: 3, docs refs: 124)_
- feature-alignment _(endpoints: 17, frontend refs: 11, docs refs: 97)_
- feature-alignment-actions _(endpoints: 18, frontend refs: 11, docs refs: 107)_
- feature-alignment-priority-algorithm _(endpoints: 17, frontend refs: 13, docs refs: 109)_
- feature-alignment-validation _(endpoints: 17, frontend refs: 13, docs refs: 127)_
- features _(endpoints: 17, frontend refs: 9, docs refs: 76)_
- features-admin _(endpoints: 17, frontend refs: 9, docs refs: 76)_
- features-adoption _(endpoints: 17, frontend refs: 9, docs refs: 78)_
- features-inventory _(endpoints: 17, frontend refs: 9, docs refs: 76)_
- features-telemetry _(endpoints: 17, frontend refs: 9, docs refs: 79)_
- file-browser-simple _(endpoints: 5, frontend refs: 16, docs refs: 163)_
- gallery _(endpoints: 1, frontend refs: 2, docs refs: 9)_
- general-utils _(endpoints: 1, frontend refs: 8, docs refs: 40)_
- generalist-scoring-system _(endpoints: 3, frontend refs: 7, docs refs: 153)_
- geo-utils _(endpoints: 0, frontend refs: 7, docs refs: 14)_
- ground-truth _(endpoints: 7, frontend refs: 2, docs refs: 39)_
- hardware _(endpoints: 4, frontend refs: 2, docs refs: 6)_
- hardware-matrix _(endpoints: 4, frontend refs: 4, docs refs: 12)_
- history _(endpoints: 18, frontend refs: 4, docs refs: 60)_
- human-review _(endpoints: 3, frontend refs: 10, docs refs: 70)_
- index _(endpoints: 0, frontend refs: 7, docs refs: 73)_
- integration-examples _(endpoints: 1, frontend refs: 1, docs refs: 129)_
- janitor _(endpoints: 4, frontend refs: 1, docs refs: 11)_
- judge-details _(endpoints: 22, frontend refs: 13, docs refs: 82)_
- judges _(endpoints: 0, frontend refs: 3, docs refs: 3)_
- leaderboard _(endpoints: 2, frontend refs: 3, docs refs: 12)_
- live-data _(endpoints: 6, frontend refs: 9, docs refs: 165)_
- logger _(endpoints: 0, frontend refs: 1, docs refs: 24)_
- login _(endpoints: 1, frontend refs: 2, docs refs: 27)_
- manual-test-now _(endpoints: 1, frontend refs: 5, docs refs: 148)_
- metrics _(endpoints: 11, frontend refs: 7, docs refs: 87)_
- metrics-charts _(endpoints: 11, frontend refs: 9, docs refs: 103)_
- model-categorization _(endpoints: 0, frontend refs: 3, docs refs: 22)_
- model-categorization-enhancements _(endpoints: 0, frontend refs: 3, docs refs: 49)_
- model-categorization-peer-review _(endpoints: 3, frontend refs: 13, docs refs: 73)_
- models-comparison _(endpoints: 0, frontend refs: 9, docs refs: 47)_
- models-management _(endpoints: 0, frontend refs: 3, docs refs: 62)_
- models-ollama-compare _(endpoints: 13, frontend refs: 11, docs refs: 102)_
- models-unified _(endpoints: 13, frontend refs: 1, docs refs: 11)_
- monitoring _(endpoints: 0, frontend refs: 1, docs refs: 57)_
- multi-tenancy _(endpoints: 0, frontend refs: 1, docs refs: 96)_
- n8n _(endpoints: 16, frontend refs: 2, docs refs: 80)_
- n8n-api-setup _(endpoints: 16, frontend refs: 6, docs refs: 100)_
- n8n-deployment _(endpoints: 16, frontend refs: 2, docs refs: 102)_
- n8n-deployment-test-results _(endpoints: 24, frontend refs: 17, docs refs: 139)_
- n8n-heavy-orchestration _(endpoints: 16, frontend refs: 2, docs refs: 85)_
- n8n-ingestion _(endpoints: 16, frontend refs: 2, docs refs: 86)_
- n8n-llm-gateway _(endpoints: 16, frontend refs: 6, docs refs: 110)_
- n8n-prompt-improvement-v4 _(endpoints: 37, frontend refs: 25, docs refs: 158)_
- n8n-workflows _(endpoints: 21, frontend refs: 2, docs refs: 87)_
- nav _(endpoints: 0, frontend refs: 29, docs refs: 75)_
- ollama-hosts _(endpoints: 8, frontend refs: 4, docs refs: 77)_
- ollama-node-setup _(endpoints: 8, frontend refs: 7, docs refs: 129)_
- ollama-vram _(endpoints: 8, frontend refs: 5, docs refs: 78)_
- open-webui-learnings _(endpoints: 0, frontend refs: 4, docs refs: 73)_
- operations _(endpoints: 5, frontend refs: 1, docs refs: 44)_
- p5-helpers _(endpoints: 0, frontend refs: 1, docs refs: 14)_
- partnership-progress-week1 _(endpoints: 0, frontend refs: 7, docs refs: 37)_
- performance _(endpoints: 10, frontend refs: 6, docs refs: 103)_
- performance-api _(endpoints: 10, frontend refs: 6, docs refs: 103)_
- performance-api-testing _(endpoints: 10, frontend refs: 6, docs refs: 145)_
- performance-dashboard _(endpoints: 10, frontend refs: 6, docs refs: 103)_
- performance-monitoring _(endpoints: 10, frontend refs: 7, docs refs: 123)_
- performance-optimization _(endpoints: 10, frontend refs: 6, docs refs: 107)_
- persona-fix-complete _(endpoints: 1, frontend refs: 7, docs refs: 147)_
- persona-selector _(endpoints: 0, frontend refs: 6, docs refs: 41)_
- persona-selector-setup _(endpoints: 0, frontend refs: 10, docs refs: 80)_
- persona-ui-architecture _(endpoints: 0, frontend refs: 3, docs refs: 109)_
- persona-ui-redesign _(endpoints: 0, frontend refs: 3, docs refs: 31)_
- phase3-test-report _(endpoints: 2, frontend refs: 1, docs refs: 67)_
- polling-controller _(endpoints: 0, frontend refs: 1, docs refs: 15)_
- pr88-integration-summary _(endpoints: 8, frontend refs: 6, docs refs: 148)_
- presets _(endpoints: 1, frontend refs: 1, docs refs: 12)_
- profile _(endpoints: 4, frontend refs: 7, docs refs: 47)_
- prompt-templates _(endpoints: 21, frontend refs: 24, docs refs: 119)_
- prompt-ui-test-report _(endpoints: 23, frontend refs: 24, docs refs: 144)_
- prompts _(endpoints: 12, frontend refs: 11, docs refs: 69)_
- qdrant-deployment _(endpoints: 5, frontend refs: 2, docs refs: 65)_
- qdrant-readme _(endpoints: 5, frontend refs: 2, docs refs: 36)_
- query-optimization _(endpoints: 1, frontend refs: 1, docs refs: 102)_
- quick-agent-prompt _(endpoints: 35, frontend refs: 53, docs refs: 183)_
- quick-fix-summary _(endpoints: 8, frontend refs: 6, docs refs: 152)_
- quickstart-qdrant _(endpoints: 5, frontend refs: 2, docs refs: 39)_
- rag _(endpoints: 14, frontend refs: 14, docs refs: 139)_
- rag-search-features _(endpoints: 32, frontend refs: 29, docs refs: 159)_
- rag-system _(endpoints: 16, frontend refs: 18, docs refs: 172)_
- recent-tests _(endpoints: 0, frontend refs: 5, docs refs: 22)_
- recommended-category-feature-complete _(endpoints: 20, frontend refs: 25, docs refs: 154)_
- repo-watcher _(endpoints: 11, frontend refs: 4, docs refs: 89)_
- repo-watcher-summary _(endpoints: 19, frontend refs: 8, docs refs: 133)_
- repowatcher _(endpoints: 6, frontend refs: 1, docs refs: 9)_
- response-handling _(endpoints: 0, frontend refs: 3, docs refs: 132)_
- restore-context-recommended-category-fe _(endpoints: 4, frontend refs: 19, docs refs: 131)_
- results _(endpoints: 8, frontend refs: 15, docs refs: 87)_
- results-analysis _(endpoints: 8, frontend refs: 17, docs refs: 109)_
- results-explorer _(endpoints: 8, frontend refs: 17, docs refs: 87)_
- results-explorer-enhancements _(endpoints: 8, frontend refs: 18, docs refs: 103)_
- results-explorer-final-summary _(endpoints: 16, frontend refs: 18, docs refs: 129)_
- results-explorer-fixes _(endpoints: 8, frontend refs: 17, docs refs: 103)_
- results-explorer-implementation-log _(endpoints: 20, frontend refs: 24, docs refs: 174)_
- results-explorer-phase2-improvements _(endpoints: 8, frontend refs: 17, docs refs: 99)_
- results-explorer-upgrade-summary _(endpoints: 16, frontend refs: 18, docs refs: 120)_
- results-table _(endpoints: 8, frontend refs: 27, docs refs: 127)_
- revised-plan-status _(endpoints: 9, frontend refs: 21, docs refs: 158)_
- roadmap _(endpoints: 0, frontend refs: 1, docs refs: 25)_
- runner-management _(endpoints: 3, frontend refs: 4, docs refs: 67)_
- sbqc-agent-personas _(endpoints: 14, frontend refs: 41, docs refs: 154)_
- scanner-confidence-scoring _(endpoints: 0, frontend refs: 5, docs refs: 53)_
- security-headers-csp _(endpoints: 0, frontend refs: 1, docs refs: 66)_
- self-healing _(endpoints: 8, frontend refs: 5, docs refs: 31)_
- self-healing-architecture _(endpoints: 8, frontend refs: 5, docs refs: 112)_
- self-healing-dashboard _(endpoints: 8, frontend refs: 5, docs refs: 31)_
- self-healing-quick-start _(endpoints: 9, frontend refs: 7, docs refs: 150)_
- setup-summary-2025-12-31 _(endpoints: 8, frontend refs: 8, docs refs: 126)_
- shortcut-hints _(endpoints: 0, frontend refs: 8, docs refs: 13)_
- specialx _(endpoints: 15, frontend refs: 2, docs refs: 1)_
- sse _(endpoints: 0, frontend refs: 4, docs refs: 74)_
- start-bug-squad _(endpoints: 2, frontend refs: 1, docs refs: 135)_
- startup-sequence _(endpoints: 0, frontend refs: 1, docs refs: 25)_
- state _(endpoints: 0, frontend refs: 9, docs refs: 74)_
- storage-tool _(endpoints: 7, frontend refs: 8, docs refs: 99)_
- streaming-tests-quick-start _(endpoints: 1, frontend refs: 2, docs refs: 146)_
- test-onboarding-flow _(endpoints: 9, frontend refs: 8, docs refs: 118)_
- test-results _(endpoints: 8, frontend refs: 15, docs refs: 87)_
- test-template-tester _(endpoints: 8, frontend refs: 9, docs refs: 42)_
- timeline _(endpoints: 1, frontend refs: 4, docs refs: 13)_
- tools _(endpoints: 7, frontend refs: 3, docs refs: 36)_
- track-5-completion-summary _(endpoints: 8, frontend refs: 7, docs refs: 128)_
- trends _(endpoints: 3, frontend refs: 5, docs refs: 24)_
- truncation _(endpoints: 1, frontend refs: 2, docs refs: 3)_
- uat-invitation-acceptance _(endpoints: 8, frontend refs: 2, docs refs: 41)_
- ui-enhancements-summary _(endpoints: 8, frontend refs: 6, docs refs: 102)_
- utils _(endpoints: 0, frontend refs: 6, docs refs: 13)_
- v1-2-enhancement-summary _(endpoints: 8, frontend refs: 6, docs refs: 105)_
- v3-rag-architecture _(endpoints: 14, frontend refs: 14, docs refs: 157)_
- v4-analytics-architecture _(endpoints: 28, frontend refs: 7, docs refs: 130)_
- validation-report-2025-12-31-1622 _(endpoints: 2, frontend refs: 3, docs refs: 113)_
- validation-report-confidence _(endpoints: 2, frontend refs: 5, docs refs: 110)_
- week2-complete-summary _(endpoints: 9, frontend refs: 8, docs refs: 141)_
- wizard-consolidation-final-summary _(endpoints: 8, frontend refs: 11, docs refs: 106)_
- workspace _(endpoints: 18, frontend refs: 6, docs refs: 33)_
- workspace-api _(endpoints: 18, frontend refs: 6, docs refs: 33)_
- workspace-audit _(endpoints: 24, frontend refs: 6, docs refs: 59)_
- workspace-settings _(endpoints: 18, frontend refs: 9, docs refs: 54)_
- workspaces _(endpoints: 18, frontend refs: 2, docs refs: 10)_

### partial (35)

- 00-overview _(endpoints: 0, frontend refs: 1, docs refs: 93)_
- abtestconfigpanel _(endpoints: 0, frontend refs: 1, docs refs: 4)_
- agentbuildermodal _(endpoints: 0, frontend refs: 1, docs refs: 0)_
- agentlistview _(endpoints: 0, frontend refs: 1, docs refs: 1)_
- agentxcard _(endpoints: 0, frontend refs: 1, docs refs: 0)_
- baseonboardingwizard _(endpoints: 0, frontend refs: 1, docs refs: 1)_
- categorybadge _(endpoints: 0, frontend refs: 2, docs refs: 4)_
- chatonboardingwizard _(endpoints: 0, frontend refs: 2, docs refs: 2)_
- commandpalette _(endpoints: 0, frontend refs: 1, docs refs: 0)_
- conversationreviewmodal _(endpoints: 0, frontend refs: 1, docs refs: 2)_
- courthouse _(endpoints: 0, frontend refs: 2, docs refs: 1)_
- databases _(endpoints: 0, frontend refs: 1, docs refs: 7)_
- diagrams _(endpoints: 0, frontend refs: 0, docs refs: 10)_
- executiontimeline _(endpoints: 0, frontend refs: 1, docs refs: 0)_
- imagegen _(endpoints: 0, frontend refs: 1, docs refs: 8)_
- keyboard-shortcuts _(endpoints: 0, frontend refs: 7, docs refs: 17)_
- model-explorer _(endpoints: 0, frontend refs: 4, docs refs: 8)_
- onboardingwizard _(endpoints: 0, frontend refs: 5, docs refs: 3)_
- performancemetricsdashboard _(endpoints: 0, frontend refs: 1, docs refs: 1)_
- prompteditormodal _(endpoints: 0, frontend refs: 1, docs refs: 2)_
- prompthealthmonitor _(endpoints: 0, frontend refs: 1, docs refs: 1)_
- promptimprovementwizard _(endpoints: 0, frontend refs: 1, docs refs: 1)_
- promptlibrarymodal _(endpoints: 0, frontend refs: 1, docs refs: 0)_
- promptlistview _(endpoints: 0, frontend refs: 1, docs refs: 6)_
- promptsapi _(endpoints: 0, frontend refs: 1, docs refs: 6)_
- prompttemplatesapi _(endpoints: 0, frontend refs: 1, docs refs: 0)_
- promptversioncompare _(endpoints: 0, frontend refs: 1, docs refs: 0)_
- quickstart _(endpoints: 0, frontend refs: 0, docs refs: 7)_
- shortcuts-modal _(endpoints: 0, frontend refs: 28, docs refs: 37)_
- shortcutshelpmodal _(endpoints: 0, frontend refs: 1, docs refs: 0)_
- templatetester _(endpoints: 0, frontend refs: 1, docs refs: 2)_
- toast _(endpoints: 0, frontend refs: 9, docs refs: 20)_
- troubleshooting _(endpoints: 0, frontend refs: 0, docs refs: 43)_
- troubleshooting-readme _(endpoints: 0, frontend refs: 0, docs refs: 43)_
- ui-enhancements _(endpoints: 0, frontend refs: 1, docs refs: 38)_

### headless-documented (33)

- 01-architecture _(endpoints: 0, frontend refs: 0, docs refs: 99)_
- 05-deployment _(endpoints: 0, frontend refs: 0, docs refs: 56)_
- 07-agentx-api-reference _(endpoints: 0, frontend refs: 0, docs refs: 93)_
- ab-test-architecture-diagram _(endpoints: 0, frontend refs: 0, docs refs: 101)_
- architecture-reality _(endpoints: 0, frontend refs: 0, docs refs: 101)_
- authentication _(endpoints: 0, frontend refs: 0, docs refs: 51)_
- authentication-implementation _(endpoints: 0, frontend refs: 0, docs refs: 112)_
- brainx-deep-architecture _(endpoints: 0, frontend refs: 0, docs refs: 118)_
- claude _(endpoints: 0, frontend refs: 0, docs refs: 38)_
- contributing _(endpoints: 0, frontend refs: 0, docs refs: 7)_
- dashboards _(endpoints: 9, frontend refs: 0, docs refs: 13)_
- dataset _(endpoints: 4, frontend refs: 0, docs refs: 32)_
- deployment _(endpoints: 0, frontend refs: 0, docs refs: 56)_
- diagnostics _(endpoints: 12, frontend refs: 0, docs refs: 4)_
- dimension-architecture _(endpoints: 0, frontend refs: 0, docs refs: 111)_
- fixes-applied _(endpoints: 0, frontend refs: 0, docs refs: 50)_
- invitations _(endpoints: 6, frontend refs: 0, docs refs: 4)_
- model-registry _(endpoints: 12, frontend refs: 0, docs refs: 18)_
- model-routing _(endpoints: 3, frontend refs: 0, docs refs: 31)_
- n6-1-architecture _(endpoints: 0, frontend refs: 0, docs refs: 99)_
- notification-channels _(endpoints: 3, frontend refs: 0, docs refs: 35)_
- reference _(endpoints: 0, frontend refs: 0, docs refs: 93)_
- sbqc-expansion-architecture _(endpoints: 0, frontend refs: 0, docs refs: 117)_
- security-hardening _(endpoints: 0, frontend refs: 0, docs refs: 48)_
- security-hardening-phase2 _(endpoints: 0, frontend refs: 0, docs refs: 52)_
- security-implementation _(endpoints: 0, frontend refs: 0, docs refs: 105)_
- testing-patterns _(endpoints: 0, frontend refs: 0, docs refs: 129)_
- v3-implementation _(endpoints: 0, frontend refs: 0, docs refs: 85)_
- v3-snapshot _(endpoints: 0, frontend refs: 0, docs refs: 36)_
- v4-contract _(endpoints: 0, frontend refs: 0, docs refs: 24)_
- v4-implementation _(endpoints: 0, frontend refs: 0, docs refs: 85)_
- voice _(endpoints: 4, frontend refs: 0, docs refs: 13)_
- workflowgenerator _(endpoints: 4, frontend refs: 0, docs refs: 2)_

### orphan-backend (1)

- configvariant _(endpoints: 3, frontend refs: 0, docs refs: 0)_

## Orphan Endpoint Details

- POST /api/dashboard/scans/:id/stop (undefined)

## Automation Inventory (from project documentation)

### Running / Implemented Automations

- N4.1 Alert Dispatcher workflow for multi-channel alert delivery (email/Slack/webhook/DataAPI).
- N4.2 Metrics Aggregation workflow for hourly rollups.
- N4.4 Self-Healing Orchestrator workflow for remediation actions.
- N3.3 Performance Monitor workflow for scheduled performance testing.
- n8n document ingestion automations:
  - Scheduled docs folder ingestion (hourly cron).
  - Manual webhook ingestion.
  - N2.3 NAS weekly RAG ingestion (Sun 3AM + webhook).
  - N2.4 codebase markdown ingestion (Mon 2AM + webhook).
- Prompt-improvement automations:
  - Daily prompt health checks.
  - Manual/weekly negative-conversation evaluation.
  - Approval-gated prompt rollout.
  - Weekly dataset export.
- Backup/disaster-recovery automations:
  - Cron setup script for daily backups (2AM).
  - MongoDB/Qdrant backup + restore scripts.

### Automations / Feature Surfaces That Should Be Added or Completed

- High-priority headless features from scanner report that still need UX surface:
  - dashboards
  - dataset
  - invitations
  - model-registry
  - diagnostics
  - notification-channels
  - voice
  - workflowgenerator
- Track 8 manual follow-through still pending in roadmap:
  - Invitation flow UAT
  - Survey distribution + demand validation for Voice and Workflow Generator UI
  - Review external API workspace integration completion
- Endpoint needing explicit ownership/verification:
  - POST /api/dashboard/scans/:id/stop
