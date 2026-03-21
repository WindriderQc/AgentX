# Architecture & Technical References

Design documents and diagrams for the AgentX backend.

- [Backend Overview](./backend-overview.md): High-level design and runtime behavior.
- [Architecture Diagrams](./diagrams.md): Visuals for data flows, request lifecycles, and planned extensions.
- [Database Architecture](./database.md): Schema layout and persistence decisions.
- Specifications: See `../../specs/` for V3 RAG and V4 Analytics architecture specs.

## Core Architecture

- [Startup Sequence](./STARTUP_SEQUENCE.md) - Bootstrap order and initialization
- [Model Registry](./MODEL_REGISTRY.md) - Model categorization and metadata system
- [Model Routing](./MODEL_ROUTING.md) - Smart routing, failover, and host management
- [Multi-Tenancy](./MULTI_TENANCY.md) - Workspaces, RBAC, and data isolation
- [RAG System](./RAG_SYSTEM.md) - Vector store, retrieval, and contextual compression
- [Architecture Reality](./ARCHITECTURE_REALITY.md) - Current vs planned architecture assessment

## Feature Architecture

- [AB Test Architecture](./AB_Test_Architecture_Diagram.md) - A/B testing system design
- [Self-Healing Architecture](./SELF_HEALING_ARCHITECTURE.md) - Auto-recovery and health monitoring
- [V4 Analytics Architecture](./V4_ANALYTICS_ARCHITECTURE.md) - Analytics pipeline design
- [SBQC Expansion](./SBQC_EXPANSION_ARCHITECTURE.md) - SBQC stack growth plan
- [N6.1 Architecture](./N6.1-ARCHITECTURE.md) - N6.1 deployment architecture
- [n8n LLM Gateway](./n8n-llm-gateway.md) - n8n-based LLM routing gateway

## Security

- [Security Hardening Phase 2](./SECURITY_HARDENING_PHASE2.md) - Advanced security measures
- [Security Headers & CSP](./SECURITY_HEADERS_CSP.md) - HTTP security header configuration

## SBQC Stack

- [SBQC Overview](./SBQC-Stack-Final/00-OVERVIEW.md) - Stack overview
- [SBQC Stack README](./SBQC-Stack-Final/README.md) - Stack-specific navigation hub
- Historical validation artifacts now live in [../archive/README.md](../archive/README.md)
