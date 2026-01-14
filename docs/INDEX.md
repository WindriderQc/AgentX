# AgentX Documentation Index

**Last Updated:** 2026-01-14
**Version:** 1.4.1
**Status:** Production Ready ✅

Welcome to the AgentX documentation hub. This is your central navigation point for all project documentation.

---

## 🚀 Where Should I Start?

### I'm a New User
→ **[User Manual](user-manual/README.md)** - Complete user guide with UI navigation
→ **[Quick Start Guide](onboarding/quickstart.md)** - Get up and running in 15 minutes
→ **[Troubleshooting](guides/TROUBLESHOOTING.md)** - Common issues and solutions

### I'm a Developer
→ **[Contributing Guide](../CONTRIBUTING.md)** - Development workflow and conventions
→ **[Architecture Overview](architecture/backend-overview.md)** - System design and patterns
→ **[API Reference](architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)** - Complete API documentation (40+ endpoints)
→ **[Testing Patterns](patterns/TESTING_PATTERNS.md)** - Jest and integration testing

### I'm an Operator/Admin
→ **[Deployment Guide](architecture/SBQC-Stack-Final/05-DEPLOYMENT.md)** - Production deployment
→ **[Operations Documentation](operations/)** - Auth, monitoring, deployment readiness
→ **[Critical Gotchas](operations/CRITICAL_GOTCHAS.md)** - Known issues and pitfalls

### I'm Claude Code / AI Agent
→ **[CLAUDE.md](../CLAUDE.md)** - Start here! Complete agent guidance
→ **[Critical Conventions](patterns/CRITICAL_CONVENTIONS.md)** - Mandatory patterns
→ **[Project Roadmap](../ROADMAP.md)** - Current status and priorities

### I Need Help Troubleshooting
→ **[Troubleshooting Guide](guides/TROUBLESHOOTING.md)** - Comprehensive troubleshooting playbook
→ **[Critical Gotchas](operations/CRITICAL_GOTCHAS.md)** - Top 8 common issues
→ **[Bug Reporting](testing/BUG_REPORTING_GUIDE.md)** - How to report issues

### I Want to See What's Been Built
→ **[Project Roadmap](../ROADMAP.md)** - All 8 tracks complete, current status
→ **[Changelog](../CHANGELOG.md)** - Version history and release notes

---

## 📖 Core Documentation

### Getting Started
| Document | Purpose | Audience |
|----------|---------|----------|
| [Quick Start Guide](onboarding/quickstart.md) | Installation and first steps | New users |
| [Onboarding Hub](onboarding/README.md) | Complete onboarding resources | New users |
| [User Manual](user-manual/README.md) | Complete user guide with UI pages | End users |
| [V4 Quick Reference](onboarding/v4-quick-reference.md) | V4 features overview | Users |

### Architecture & System Design
| Document | Purpose | When to Read |
|----------|---------|--------------|
| [Backend Overview](architecture/backend-overview.md) | Service-oriented architecture | Understanding system design |
| [SBQC Stack Overview](architecture/SBQC-Stack-Final/00-OVERVIEW.md) | Complete stack architecture | Big picture understanding |
| [Complete Architecture](architecture/SBQC-Stack-Final/01-ARCHITECTURE.md) | Detailed system design | Deep technical dive |
| [Multi-Tenancy](architecture/MULTI_TENANCY.md) | Team collaboration & RBAC | Workspace features |
| [Model Registry](architecture/MODEL_REGISTRY.md) | Model categorization system | Model management |
| [Model Routing](architecture/MODEL_ROUTING.md) | Smart routing & failover | Load balancing |
| [RAG System](architecture/RAG_SYSTEM.md) | Vector store & retrieval | Knowledge augmentation |
| [Startup Sequence](architecture/STARTUP_SEQUENCE.md) | Bootstrap order | Debugging startup |
| [Database Schema](architecture/database.md) | MongoDB models | Data modeling |
| [Architecture Diagrams](architecture/diagrams.md) | Visual system documentation | Visual learners |

### API Reference
| Document | Purpose | Audience |
|----------|---------|----------|
| [AgentX API Reference](architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) | Complete API docs (40+ endpoints) | Developers |
| [API Overview](api/reference.md) | General API reference | Developers |
| [V3 RAG Contract](api/contracts/v3-snapshot.md) | RAG ingestion API | RAG developers |
| [V4 Analytics Contract](api/contracts/v4-contract.md) | Analytics API | Analytics developers |
| [Workspace API Guide](api/WORKSPACE_API_GUIDE.md) | Workspace-specific APIs | Multi-tenancy |
| [Benchmark API](api/BENCHMARK_API_ENHANCED.md) | Benchmark endpoints | Performance testing |

### Development Patterns
| Document | Purpose | Audience |
|----------|---------|----------|
| [Critical Conventions](patterns/CRITICAL_CONVENTIONS.md) | **Mandatory patterns** | All developers |
| [Testing Patterns](patterns/TESTING_PATTERNS.md) | Jest & integration tests | Developers |

### Operations & Deployment
| Document | Purpose | Audience |
|----------|---------|----------|
| [Deployment Guide](architecture/SBQC-Stack-Final/05-DEPLOYMENT.md) | Production deployment | Ops/Admins |
| [Operations Deployment](operations/DEPLOYMENT.md) | Deployment procedures | Ops/Admins |
| [Deployment Readiness Checklist](operations/DEPLOYMENT_READINESS_CHECKLIST.md) | Pre-deployment verification | Ops/Admins |
| [Authentication](operations/AUTHENTICATION.md) | Dual auth system | Ops/Admins |
| [Response Handling](operations/RESPONSE_HANDLING.md) | LLM response processing | Developers |
| [Benchmark System](operations/BENCHMARK_SYSTEM.md) | Quality scoring | Ops/Admins |
| [Benchmark Color Theme](operations/BENCHMARK_COLOR_THEME.md) | Level-based colors | UI developers |
| [Categorization Tests](operations/CATEGORIZATION_TESTS.md) | Model category assignment | ML engineers |
| [Critical Gotchas](operations/CRITICAL_GOTCHAS.md) | **Top 8 common issues** | Everyone |
| [Qdrant Deployment](operations/QDRANT_DEPLOYMENT.md) | Vector store setup | Ops/Admins |
| [CI/CD Setup](operations/CI_CD_SETUP.md) | Pipeline configuration | DevOps |
| [Runner Management](operations/RUNNER_MANAGEMENT.md) | GitHub Actions runners | DevOps |
| [Notification Channels](operations/NOTIFICATION_CHANNELS.md) | Alert notifications | Ops/Admins |

---

## 🔧 Features & Guides

### User Guides
| Document | Purpose | Audience |
|----------|---------|----------|
| [Troubleshooting Guide](guides/TROUBLESHOOTING.md) | Comprehensive playbook (36KB) | Everyone |
| [Integration Guide](guides/INTEGRATION_GUIDE.md) | Integration implementation | Developers |
| [Integration Examples](guides/INTEGRATION_EXAMPLES.md) | Detailed code samples | Developers |
| [A/B Testing Guide](guides/ab-testing-guide.md) | Prompt A/B testing | Product |
| [RAG Metrics Guide](guides/RAG_METRICS_GUIDE.md) | RAG monitoring | Ops/Admins |
| [Self-Healing Quick Start](guides/SELF_HEALING_QUICK_START.md) | Automated remediation | Ops/Admins |
| [Qdrant Quick Start](guides/QUICKSTART_QDRANT.md) | Vector database setup | Developers |
| [Onboarding Wizard Guide](guides/onboarding-wizard-guide.md) | Onboarding feature | Product |

### Feature Documentation
| Document | Purpose | Audience |
|----------|---------|----------|
| [Performance Monitoring](features/PERFORMANCE_MONITORING.md) | Comprehensive guide (25KB) | Ops/Admins |
| [Performance Dashboard](features/PERFORMANCE_DASHBOARD.md) | Dashboard usage | Users |
| [Alert Analytics Dashboard](features/ALERT_ANALYTICS_DASHBOARD.md) | Alert analytics UI | Ops/Admins |
| [Alerts Dashboard Implementation](features/ALERTS_DASHBOARD_IMPLEMENTATION.md) | Implementation details | Developers |
| [N4.1 Alert Dispatcher Guide](features/N4.1_ALERT_DISPATCHER_GUIDE.md) | Alert dispatcher | Ops/Admins |
| [Self-Healing Dashboard](features/SELF_HEALING_DASHBOARD.md) | Self-healing UI | Ops/Admins |
| [Feature Alignment Dashboard](features/FEATURE_ALIGNMENT_DASHBOARD_GUIDE.md) | Feature coverage | Product |
| [Feature Prioritization Algorithm](features/FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md) | Priority scoring | Product |
| [RAG Search Features](features/RAG_SEARCH_FEATURES.md) | RAG capabilities | Developers |
| [Track 5 Completion](features/TRACK_5_COMPLETION_SUMMARY.md) | Analytics track | Product |
| [Custom Dashboards](features/CUSTOM_DASHBOARDS_NEXT_STEPS.md) | Dashboard implementation | Developers |

### Cost Tracking (Complete Feature Set)
| Document | Purpose | Audience |
|----------|---------|----------|
| [Cost Tracking Start Here](features/cost-tracking/COST_TRACKING_START_HERE.md) | **Overview** | Everyone |
| [Cost Tracking Index](features/cost-tracking/COST_TRACKING_INDEX.md) | Documentation hub | Everyone |
| [Cost Tracking Quick Reference](features/cost-tracking/COST_TRACKING_QUICK_REFERENCE.md) | Quick reference | Users |
| [Cost Tracking Design](features/cost-tracking/COST_TRACKING_DESIGN.md) | System architecture | Developers |
| [Cost Tracking Schema](features/cost-tracking/COST_TRACKING_SCHEMA.md) | Database design | Developers |
| [Cost Tracking UI Design](features/cost-tracking/COST_TRACKING_UI_DESIGN.md) | UI specifications | UI developers |
| [Cost Tracking Implementation](features/cost-tracking/COST_TRACKING_IMPLEMENTATION_GUIDE.md) | Step-by-step guide | Developers |
| [Cost Tracking Components](features/cost-tracking/COST_TRACKING_COMPONENT_DETAILS.md) | Component API | Developers |

---

## 🧪 Testing & Quality Assurance

### Testing Documentation
| Document | Purpose | Audience |
|----------|---------|----------|
| [Testing Index](testing/README.md) | Testing hub | Developers |
| [E2E Testing Guide](../tests/e2e/TESTING_GUIDE.md) | End-to-end tests | QA/Developers |
| [E2E Quick Start](../tests/e2e/QUICKSTART.md) | Quick E2E setup | Developers |
| [E2E Setup](../tests/e2e/SETUP.md) | Test environment | Developers |
| [E2E Quick Reference](../tests/e2e/QUICK_REFERENCE.md) | Commands & patterns | Developers |
| [Load Testing](../tests/load/README.md) | Artillery load tests | QA/DevOps |
| [RAG Testing Guide](testing/RAG_TESTING_GUIDE.md) | RAG system tests | Developers |
| [Benchmark Quality Scoring](testing/BENCHMARK_QUALITY_SCORING.md) | Quality metrics | QA |
| [Alerts Integration Verification](testing/ALERTS_INTEGRATION_VERIFICATION.md) | Alert system tests | QA |
| [Bug Reporting Guide](testing/BUG_REPORTING_GUIDE.md) | Report issues | Everyone |
| [Bug Hunt Quick Reference](testing/BUG_HUNT_QUICK_REF.md) | Quick bug hunting | QA |
| [Performance API Testing](testing/PERFORMANCE_API_TESTING.md) | Performance tests | QA |

---

## 🔌 Integrations

### N8N Workflows
| Document | Purpose | Audience |
|----------|---------|----------|
| [N8N Workflows Overview](integrations/N8N_WORKFLOWS.md) | Automation overview | Ops/Admins |
| [Complete N8N Workflows](architecture/SBQC-Stack-Final/04-N8N-WORKFLOWS.md) | Full specifications (54KB) | Developers |
| [N8N Deployment](onboarding/n8n-deployment.md) | Workflow setup | Ops/Admins |
| [Ollama Node Setup](integrations/ollama_node_setup.md) | Ollama integration | Developers |

### DataAPI Integration
| Document | Purpose | Audience |
|----------|---------|----------|
| [DataAPI Tasks](architecture/SBQC-Stack-Final/02-DATAAPI-TASKS.md) | DataAPI features | Developers |
| [AgentX Tasks](architecture/SBQC-Stack-Final/03-AGENTX-TASKS.md) | AgentX features | Developers |

---

## 📊 Reports & Status

### Project Status
| Document | Purpose | Audience |
|----------|---------|----------|
| [Project Roadmap](../ROADMAP.md) | **Current status** (all tracks ✅) | Everyone |
| [Changelog](../CHANGELOG.md) | Version history | Everyone |
| [SBQC Audit Summary](architecture/SBQC-Stack-Final/00-AUDIT-SUMMARY.md) | Documentation audit | Internal |

### Implementation Reports
| Document | Purpose | Audience |
|----------|---------|----------|
| [Revised Plan Status](reports/REVISED_PLAN_STATUS.md) | v1.0.0 release | Historical |
| [V1.2 Enhancement Summary](reports/V1.2_ENHANCEMENT_SUMMARY.md) | v1.2 features | Historical |
| [Week 2 Summary](reports/WEEK2_COMPLETE_SUMMARY.md) | Progress report | Historical |
| [Wizard Consolidation](reports/WIZARD_CONSOLIDATION_FINAL_SUMMARY.md) | UI consolidation | Historical |
| [Partnership Progress Week 1](reports/PARTNERSHIP_PROGRESS_WEEK1.md) | Week 1 status | Historical |
| [Authentication Implementation](reports/AUTHENTICATION_IMPLEMENTATION.md) | Auth system | Historical |
| [Security Implementation](reports/SECURITY_IMPLEMENTATION.md) | Security features | Historical |
| [Performance Optimization](reports/PERFORMANCE_OPTIMIZATION.md) | Optimization work | Historical |
| [V3 Implementation](reports/v3-implementation.md) | RAG system | Historical |
| [V4 Implementation](reports/v4-implementation.md) | Analytics system | Historical |
| [N8N Ingestion](reports/n8n-ingestion.md) | Ingestion workflow | Historical |
| [N8N Prompt Improvement V4](reports/n8n-prompt-improvement-v4.md) | Prompt optimization | Historical |

---

## 🎯 AgentC (Automated Workflows)

### AgentC Documentation
| Document | Purpose | Audience |
|----------|---------|----------|
| [AgentC Overview](../AgentC/README.md) | Automated agent system | Developers |
| [Agent Personas](../AgentC/AGENT_PERSONAS.md) | Persona definitions | Developers |
| [N6.1 README](../AgentC/N6.1-README.md) | N6.1 workflow | Ops/Admins |
| [N6.1 Summary](../AgentC/N6.1-SUMMARY.md) | Status summary | Ops/Admins |
| [N6.1 Quick Reference](../AgentC/N6.1-QUICK-REFERENCE.md) | Quick reference | Users |
| [N6.1 Deployment Guide](../AgentC/N6.1-DEPLOYMENT-GUIDE.md) | Deployment steps | Ops/Admins |
| [Workflow Guide](../AgentC/WORKFLOW-GUIDE.md) | Workflow setup | Developers |
| [Workflow Testing Guide](../AgentC/WORKFLOW_TESTING_GUIDE.md) | Testing procedures | QA |
| [AgentC Troubleshooting](../AgentC/TROUBLESHOOTING.md) | Issue resolution | Ops/Admins |

---

## 🎨 UI Components

| Document | Purpose | Audience |
|----------|---------|----------|
| [Components Index](components/README.md) | Component documentation | UI developers |
| [Performance Metrics Dashboard](components/PerformanceMetricsDashboard.md) | Dashboard component | UI developers |
| [Template Tester](components/TemplateTester.md) | Testing component | UI developers |

---

## 🔮 Future Concepts

| Document | Purpose | Audience |
|----------|---------|----------|
| [BrainX System Prompt](future/BrainX-System-Prompt.md) | Future concept | Research |
| [SBQC Agent Personas](future/SBQC-Agent-Personas.md) | Future concepts | Research |
| [BrainX Deep Architecture](future/brainx-deep-architecture.md) | Architecture exploration | Research |
| [N8N Heavy Orchestration](future/n8n-heavy-orchestration.md) | Future orchestration | Research |

---

## 📦 Archive

Historical documentation moved to `/archive/` for reference:
- Implementation reports
- Progress summaries
- Historical test results
- Deprecated documentation

See [archive/](archive/) for complete list.

---

## 🆘 Quick Help

### Common Tasks

**Need to set up AgentX?**
→ [Quick Start Guide](onboarding/quickstart.md) → [Deployment Guide](architecture/SBQC-Stack-Final/05-DEPLOYMENT.md)

**Something broken?**
→ [Troubleshooting Guide](guides/TROUBLESHOOTING.md) → [Critical Gotchas](operations/CRITICAL_GOTCHAS.md)

**Want to contribute?**
→ [Contributing Guide](../CONTRIBUTING.md) → [Testing Patterns](patterns/TESTING_PATTERNS.md)

**Need API documentation?**
→ [API Reference](architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)

**Deploying to production?**
→ [Deployment Readiness Checklist](operations/DEPLOYMENT_READINESS_CHECKLIST.md)

---

## 📝 Documentation Standards

### File Naming Conventions
- Use UPPER_CASE for: README.md, INDEX.md, ROADMAP.md, CONTRIBUTING.md
- Use kebab-case for: feature-name.md, guide-name.md
- Use descriptive names: authentication.md (not auth.md)

### When to Update Documentation
- Adding/removing features → Update docs/INDEX.md, README.md, API reference
- Changing architecture → Update architecture docs
- New environment variables → Update DEPLOYMENT.md, .env.example
- Breaking changes → Update CHANGELOG.md, migration guide

### Documentation Hierarchy
- **Tier 1 (Essential):** README, INDEX, Quick Start (~10 files) - Read first
- **Tier 2 (Reference):** Architecture, API, Operations (~30 files) - Refer as needed
- **Tier 3 (Deep Dive):** Features, Testing, Reports (~50 files) - Expert reference
- **Tier 4 (Historical):** Archive (~100+ files) - Historical reference

---

## 🔗 External Resources

- **GitHub Repository:** [WindriderQc/AgentX](https://github.com/WindriderQc/AgentX)
- **Issues & Support:** [GitHub Issues](https://github.com/WindriderQc/AgentX/issues)
- **DataAPI Documentation:** See sibling repository for DataAPI-specific docs

---

## 📋 Documentation Maintenance

**Last Audit:** 2026-01-14
**Next Audit Due:** 2026-04-14 (Quarterly)
**Total Documentation Files:** 226 markdown files
**Documentation Health:** 🟡 Good (needs organization improvements)

**Known Issues:**
- ✅ Created docs/INDEX.md (was missing)
- ⚠️ Path references need standardization
- ⚠️ Some broken links need fixing
- ⚠️ Duplicate documentation needs consolidation

---

**Questions? Issues?**
- Check [Troubleshooting Guide](guides/TROUBLESHOOTING.md)
- Report bugs: [GitHub Issues](https://github.com/WindriderQc/AgentX/issues)
- For AI agents: See [CLAUDE.md](../CLAUDE.md)

---

*This documentation index is the canonical navigation hub for all AgentX documentation. Keep it updated as documentation changes.*
