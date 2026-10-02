# Contributing to AgentX

Start with [README](README.md), [Status](docs/STATUS.md),
[Architecture](docs/ARCHITECTURE.md) and [Operations](docs/OPERATIONS.md).
Use one repository and the existing Node/Express, MongoDB, Qdrant, Ollama and
Docker stack. Core owns shared capabilities and canonical application data;
surfaces compose them and external integrations call them.

Discuss capability removal, ownership changes and product behavior in an issue
before implementing them. Put modernization proposals in
[MODERNIZATION.md](MODERNIZATION.md). Keep changes focused and commit messages
in English. Follow [AGENTS.md](AGENTS.md) for source file limits and repository
rules.

Use synthetic data in fixtures, screenshots and issue reports. Keep credentials,
personal content, transcripts, machine inventories, instance configuration and
runtime stores outside Git. Instance-owned sound packs use the external mount
in the [installation guide](docs/INSTALLATION.md#private-sound-packs).

Run the relevant completed test suites and packaging checks described in the
README. Tests, containers, deployments and real-device acceptance are separate
results. Report which you verified and any remaining limits in your pull request.
The public CI uses disposable GitHub-hosted runners and no private inference host.
