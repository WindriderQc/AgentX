# OpenClaw model execution

This native plugin provides model execution without an agent loop and exposes
an expurgated model/agent catalogue to AgentX. Provider transports, authentication
and fixed parameters come from the installed OpenClaw SDK and configuration.

Install this directory with OpenClaw's existing local-plugin workflow. Enable
`agentx-model-execution` in its private plugin configuration. `agentIds` optionally
restricts the auth scopes and agent profiles exposed to AgentX. Set
`maxRequestCostNanodollars` for paid model calls; its default is zero. Never put
provider credentials or instance configuration in this directory.

Both execution routes require native gateway authentication. The gateway stays
private. AgentX's existing gateway URL/token identify the service. The native
agent Responses endpoint retains its existing agent mode and continuity path.

Run `npm test` here. The installed-SDK test is skipped when the native package is
unavailable. It uses the actual SDK registry, payload policy and streaming parser
with an injected native fetch port; it opens no provider socket. Qualify each
runtime update before refreshing benchmark pins.

See [execution sources](../../../docs/EXECUTION_SOURCES.md) for the API,
ownership, budgets, benchmark isolation and observable limitations.
