# AgentX

One canonical repository. Read README.md, docs/STATUS.md, docs/ARCHITECTURE.md
and docs/OPERATIONS.md before changing architecture.

- Keep Node/Express, MongoDB, Qdrant, Ollama and Docker. Record modernization ideas
  in MODERNIZATION.md instead of opportunistically replacing the stack.
- Generic conversation, inference/routing, memory/RAG, tools/tasks, attachments
  and events belong to Core capabilities. Surfaces and personas compose them.
- Nestor is the personal assistant. Household is the family surface. External
  harnesses are replaceable and must not become the canonical business or memory owner.
- Distribute the same code through profiles/capabilities. No parallel product/ops repository:
  an instance may keep a private instance repository for its own configuration,
  runbooks and assets, never product code (ADR 0001).
- Ask the owner, grouping questions, if an unknown affects keeping, deleting,
  merging a capability or changing product behavior. Preserve useful capabilities
  until their replacement has evidence.
- Never commit secrets, personal content, transcripts, memory stores, host inventories,
  machine-specific configuration, generated reports or runtime volumes here. Keep secret
  values outside Git entirely; only generic configuration examples belong here.
- Local/LAN only. Do not expose the application publicly. The source repository is
  public: every commit is published, so instance data, secrets and private assets
  stay in the private instance repository or outside Git (ADR 0001).
- Run existing relevant tests and wait for their completed result. Distinguish
  code/tests, containers, deployment and real-device acceptance.
- Keep commits in English and responses to the owner in French. One clear change
  per commit. Never rewrite ax/ Modelfiles or benchmarked num_ctx values.
- aiOPs and AgentX-Ecosystem are archived references. Do not edit them to implement
  new AgentX functionality. Historical governance is not imported here.
- Describe the system in the present tense. docs/STATUS.md is rewritten, never
  appended to; dated receipts and evidence stay outside Git. Track open work as
  issues, not as prose in documents.
- New source files stay under 700 lines (frontend 1,200). A file already over its
  limit must not grow: split it, or extract what you add. Split by responsibility,
  not by line count: only a file over 1,000 lines (frontend 1,500) is split on its
  own; below that, split it when you change it. Tests, fixtures and declarative
  files (schemas, static data, configuration) are exempt.
