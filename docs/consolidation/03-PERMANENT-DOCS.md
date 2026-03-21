# Permanent Documentation Set

## Definition

A permanent doc in this repository should meet all of these rules:

- it describes current behavior, not just a past milestone,
- it is expected to stay discoverable from the main doc hub,
- it can be updated incrementally as the code changes, and
- it is not a one-time handoff, generated report, or dated validation artifact.

## Root Permanent Docs

| File | Role |
|------|------|
| [`README.md`](/home/yb/codes/AgentX/README.md) | Public entry point |
| [`AGENTS.md`](/home/yb/codes/AgentX/AGENTS.md) | Agent workspace rules and critical implementation conventions |
| [`CLAUDE.md`](/home/yb/codes/AgentX/CLAUDE.md) | Companion AI workspace rules |
| [`CONTRIBUTING.md`](/home/yb/codes/AgentX/CONTRIBUTING.md) | Workflow and contribution norms |
| [`ROADMAP.md`](/home/yb/codes/AgentX/ROADMAP.md) | Project status and active roadmap narrative |

## Permanent `docs/` Areas

### Primary hubs

- [`docs/INDEX.md`](/home/yb/codes/AgentX/docs/INDEX.md)
- [`docs/architecture/README.md`](/home/yb/codes/AgentX/docs/architecture/README.md)
- [`docs/operations/README.md`](/home/yb/codes/AgentX/docs/operations/README.md)
- [`docs/testing/README.md`](/home/yb/codes/AgentX/docs/testing/README.md)
- [`docs/user-manual/README.md`](/home/yb/codes/AgentX/docs/user-manual/README.md)

### Permanent architecture/operations references

- backend overview
- startup sequence
- model registry and model routing
- multi-tenancy and RAG system
- authentication, deployment, response handling
- critical conventions and critical gotchas
- service-domain READMEs under `docs/services/`

### Permanent onboarding/guides

- onboarding quickstart and onboarding README
- troubleshooting docs
- self-healing quick start

## Not Permanent By Default

These are valid Markdown files, but they are not the permanent system-of-record:

- dated validation reports,
- handoff prompts,
- bug-squad instructions,
- generated audit reports,
- detailed one-off implementation reports,
- superseded plans,
- future proposals that intentionally describe unimplemented work.

## Maintenance Rule

When new Markdown is added:

1. put current, user-facing or operator-facing truth in the permanent set,
2. keep working plans in `docs/plans/` or another clearly non-canonical area,
3. move historical one-off artifacts to [`docs/archive/README.md`](/home/yb/codes/AgentX/docs/archive/README.md) once their useful information has been merged forward.

