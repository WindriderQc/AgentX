import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("owner_memory_turn", Path(__file__).resolve().parents[1] / "owner-memory-turn" / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class Hooks:
    def __init__(self):
        self.entries = {}

    def register_hook(self, name, handler):
        self.entries[name] = handler

    register_middleware = register_hook


class OwnerMemoryTurnTest(unittest.TestCase):
    def setUp(self):
        self.hooks = Hooks()
        self.queries = []
        self.context = "Current note: new refractor."
        self.protected = True
        plugin.register(self.hooks, self.read)
        self.id = {"session_id": "owner-session", "turn_id": "one"}

    def read(self, query):
        self.queries.append(query)
        return {"authority": "agentx.core", "schema": plugin.SCHEMA, "operation": "turn-context",
                "policy": "Core owns current memory.", "context": self.context, "protectRecall": self.protected}

    def prepare(self, **kwargs):
        self.hooks.entries["pre_llm_call"](platform="api_server", user_message="Which telescope do I use?", **{**self.id, **kwargs})

    def test_refresh_existing_session_for_each_turn_and_keep_provider_and_transcript_inputs(self):
        middleware = self.hooks.entries["llm_request"]
        request = {"instructions": "native persona", "input": [{"role": "user", "content": "question"}], "max_output_tokens": 500}
        self.prepare()
        before = middleware(request, api_mode="codex_responses", **self.id)["request"]
        self.assertIn("new refractor", before["instructions"])
        self.context = "Current notes: []"
        self.prepare(turn_id="two")
        after = middleware(request, api_mode="codex_responses", **{**self.id, "turn_id": "two"})["request"]
        self.assertIn("Current notes: []", after["instructions"])
        self.assertNotIn("new refractor", after["instructions"])
        self.assertEqual(request["instructions"], "native persona")
        self.assertEqual(after["input"], request["input"])
        self.assertEqual(len(self.queries), 2)

    def test_only_current_owner_turn_denies_history_and_fallback_preserves_native_messages(self):
        self.prepare()
        tool = self.hooks.entries["pre_tool_call"]
        self.assertEqual(tool(tool_name="session_search", **self.id)["action"], "block")
        self.assertIsNone(tool(tool_name="mcp__agentx_owner__personal_memory", args={"action": "search"}, **self.id))
        self.assertIsNone(tool(tool_name="session_search", session_id="other", turn_id="one"))
        self.prepare(turn_id="child", parent_session_id="owner-session")
        self.assertIsNone(tool(tool_name="session_search", **{**self.id, "turn_id": "child"}))
        self.protected = False
        self.prepare(turn_id="history")
        self.assertIsNone(tool(tool_name="session_search", **{**self.id, "turn_id": "history"}))
        original = [{"role": "system", "content": "native persona"}, {"role": "user", "content": "question"}]
        middleware = self.hooks.entries["llm_request"]
        payload = middleware({"messages": original}, api_mode="chat_completions", **self.id)["request"]
        self.assertIn("new refractor", payload["messages"][0]["content"])
        self.assertEqual(payload["messages"][1:], original[1:])
        self.assertEqual(original[0]["content"], "native persona")
