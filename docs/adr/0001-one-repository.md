# ADR 0001: one canonical AgentX repository

## Product source

AgentX keeps reusable capabilities and environment integrations in one codebase.
Profiles and capabilities configure which services and surfaces an instance uses.
Core owns shared business capabilities and canonical application data; surfaces
and external runtimes compose or call them.

The stack is Node.js/Express, MongoDB, Qdrant, Ollama and Docker. Modernization
proposals belong in `MODERNIZATION.md`. Remove compatibility only when consumer
absence or a tested replacement is established. Ask the owner about unknowns
that affect keeping, deleting or merging a capability or changing behavior.

Source publication requires checking the source tree, reachable Git objects and
repository metadata. Public source visibility does not expose a runtime: the
application is intended for local or private-LAN use.

## Private instance configuration

An instance owner may keep a private instance repository beside the product
checkout. It holds configuration templates without secret values, external
harness settings, operating runbooks, service units, private assets and private
work tracking. Personal content, transcripts, memory stores, machine inventories,
generated reports, backups and runtime data stay outside the product repository.
Secret values stay outside Git entirely.

An instance repository holds no product code and is not a product fork. A
capability an instance needs is implemented in AgentX behind a profile or
capability, and the instance deploys a chosen product revision. External
harnesses may read instance settings and act through Core's bounded capabilities;
they do not own the product or its canonical data.

Instance-specific specialist identities and their instructions, questionnaires,
interpretations, protocols, techniques and evaluation criteria belong in the
private instance layer. Core retains genuinely reusable capabilities. A future
instance role consumes those capabilities; its existence does not require a
specialized built-in surface or a parallel implementation of Core.
