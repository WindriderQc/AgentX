"""Observed model/token usage, independent of success and monetary telemetry."""

from typing import Any, Mapping


def attempt_usage(observation: Mapping[str, Any] | None,
                  routing: Mapping[str, Any] | None = None,
                  attribution: Mapping[str, Any] | None = None) -> dict[str, Any]:
    observed = observation or {}
    fields = ("inputTokens", "outputTokens", "cacheReadTokens", "totalTokens")
    usage = {key: observed.get(key) for key in fields}
    usage["modelCalls"] = observed.get("calls")
    usage["tokenStatus"] = observed.get("tokenStatus", "unknown" if any(
        usage[key] is None for key in fields) else "complete")
    models = observed.get("models") or []
    # The OpenClaw attribution alias is not the model that executed the request.
    actual = models[0] if len(models) == 1 and models[0] != "agentx-pipeline" else None
    if routing and routing.get("status") == "verified":
        actual = routing.get("effectiveModel")
    elif attribution and attribution.get("requestCount", 0) > 0 and (not models or models == ["agentx-pipeline"]):
        actual = attribution.get("effectiveModel")
    if usage["modelCalls"] is None and attribution and attribution.get("requestCount", 0) > 0:
        usage["modelCalls"] = attribution["requestCount"]
    usage["effectiveModel"] = actual
    return usage
