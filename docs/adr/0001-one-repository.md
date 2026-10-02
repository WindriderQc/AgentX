# ADR 0001: one canonical AgentX repository

Accepted by the owner on 2026-09-16.

AgentX receives a new Git history. aiOPs and AgentX-Ecosystem remain archived
references; their former product/operations split is superseded.
Reusable capabilities and environment integrations live in the same codebase;
distribution is configured through profiles/capabilities. Personal content,
secrets and concrete machine configuration remain outside Git.

Preserve the current functional stack. Remove obsolete compatibility only when
consumer absence or a tested replacement is established. Unknown product or
capability decisions go to the owner, in grouped questions.

The former aiOPs, AgentX-Ecosystem and standalone Core/RAG/Benchmark/Data
repositories were archived on 2026-09-21, not deleted. Complete verified bundles
of their refs are kept outside Git. Archiving does not mean every old proposal
shipped; selected ones are tracked as AgentX issues.

Source publication requires an audit of current files, history and repository
metadata. Public source visibility does not expose a runtime.
