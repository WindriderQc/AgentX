"""Ecosystem Memory Review — AgentX-owned confidence-tiered cross-runtime memory.

Collectors read runtime-local session evidence (Claude Code, Codex, OpenClaw,
Hermes) incrementally and read-only, sanitize and classify it, and submit
bounded observations to AgentX Core (``/api/memory-review/*``). Synthesis runs
through the AgentX Hermes proxy. Core alone evaluates the standing automation
policy; collectors cannot approve or write anything.

Usage: integrations/memory-review/README.md
"""

COLLECTOR_VERSION = "memory-review-collector/0.2.0"
PROMPT_VERSION = "memory-review-synthesis@2026-10-08-v3"
