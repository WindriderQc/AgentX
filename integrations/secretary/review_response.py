"""Known response-format failures, distinct from uncertain inference transport."""
import json


class ReviewInvalidOutput(ValueError):
    """A complete native HTTP response was received; do not repeat its call."""

    def __init__(self, reason, limits=None):
        super().__init__(reason)
        self.reason, self.limits = reason, limits or {}


def limits(reply, requested=None):
    def mapping(value):
        return value if isinstance(value, dict) else {}
    contract = mapping(mapping(reply.get("agentx_contract")).get("contextBudget"))
    reserved = mapping(contract.get("output")).get("reservedTokens")
    count = reply.get("eval_count")
    return {"requestedMaxOutputTokens": requested, "resolvedOutputReserve": reserved,
            "tokensOut": count, "done": reply.get("done"),
            "completionReason": reply.get("done_reason") or reply.get("stop_reason") or reply.get("finish_reason"),
            "atOutputLimit": type(count) is int and type(reserved) is int and count >= reserved}


def parse_content(reply, requested=None, capture=None):
    observed = limits(reply, requested)
    message = reply.get("message") if isinstance(reply.get("message"), dict) else {}
    content = message.get("content") or reply.get("response")
    if not isinstance(content, str):
        raise ReviewInvalidOutput("missing-model-content", observed)
    if capture:
        capture("model", content.encode("utf-8", errors="surrogatepass"), {"limits": observed})
    if observed["done"] is False or observed["completionReason"] in ("length", "max_tokens", "max_output_tokens", "token_limit"):
        raise ReviewInvalidOutput("incomplete-model-output", observed)
    try:
        value = json.loads(content)
    except (ValueError, UnicodeError) as error:
        raise ReviewInvalidOutput("invalid-model-json", observed) from error
    if not isinstance(value, dict):
        raise ReviewInvalidOutput("non-object-model-output", observed)
    return value
