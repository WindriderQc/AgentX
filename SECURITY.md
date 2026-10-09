# Security

AgentX is intended for local or private-LAN use. Application ports bind to
loopback; MongoDB and Qdrant stay on the internal Docker network. Configure the
[private LAN HTTPS gateway](docs/PARENTAL_ACCESS.md) before family access from
other devices. Public source visibility does not make the application suitable
for an internet-facing deployment.

Keep credentials, personal data and operator configuration outside the source
checkout. Use synthetic examples in public issues and pull requests. The
repository's MIT licence applies to code; bundled audio retains the individual
terms listed in its [credits](core/surfaces/household/public/sounds/CREDITS.md),
and the Data Toolbox map geometry those in [its own](core/surfaces/data-toolbox/public/geo/CREDITS.md).

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** action in this repository's Security tab
for a private report. Include the affected revision, a minimal synthetic
reproduction, expected behavior and impact. Do not include real credentials,
private transcripts or household data. Discuss potential vulnerabilities through
private reporting before posting exploit details in a public issue.

## Updates

Use a reviewed revision of the active main branch. There is no promised support
window for older releases. Dependency audit results and passing CI are useful
checks; they do not establish production or real-device acceptance.

Content AgentX reads (mail, documents, web results, retrieved knowledge) is
data, never instructions, and outbound actions need a human confirmation
enforced in code: see [ADR 0003](docs/adr/0003-ingested-content.md).
