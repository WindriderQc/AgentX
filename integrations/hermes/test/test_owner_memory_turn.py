import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("owner_memory_turn", Path(__file__).resolve().parents[1] / "owner-memory-turn" / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

CORE = "http://127.0.0.1:3180"
TARGET = CORE + "/api/llm/v1"
LOCAL = {"provider": "custom", "base_url": TARGET, "model": "agentx-primary", "api_mode": "chat_completions"}
MODEL = {"provider": "custom", "base_url": TARGET, "default": "agentx-primary"}


class Hooks:
    def __init__(self):
        self.entries = {}

    def register_hook(self, name, handler):
        self.entries[name] = handler

    register_middleware = register_hook


class OwnerMemoryTurnTest(unittest.TestCase):
    def setUp(self):
        self.queries = []
        self.context = "Current note: new refractor."
        self.protected = True
        self.id = {"session_id": "owner-session", "turn_id": "one"}
        self.request = {"model": "agentx-primary", "messages": [
            {"role": "system", "content": "native persona"}, {"role": "user", "content": "question"}]}
        self.configure()

    def configure(self, **settings):
        registry = Hooks()
        plugin.register(registry, self.read, {"mcp_servers": {"agentx-owner": {"url": CORE + "/api/consumers/nestor/v1/mcp"}},
                                              "model": MODEL, **settings})
        self.hooks = registry.entries

    def read(self, query):
        self.queries.append(query)
        return {"authority": "agentx.core", "schema": plugin.SCHEMA, "operation": "turn-context",
                "policy": "Core owns current memory.", "context": self.context, "protectRecall": self.protected}

    def prepare(self, **kwargs):
        self.hooks["pre_llm_call"](platform="api_server", user_message="Which telescope do I use?", **{**self.id, **kwargs})

    def apply(self, **kwargs):
        return self.hooks["llm_request"](self.request, **{**self.id, **LOCAL, **kwargs})

    def tool(self, name="personal_memory", args=None, **kwargs):
        return self.hooks["pre_tool_call"](tool_name=name, args=args or {}, **{**self.id, **kwargs})

    def test_local_current_memory_is_ephemeral_and_refreshed_per_turn(self):
        self.prepare()
        before = self.apply()["request"]
        self.assertIn("new refractor", before["messages"][0]["content"])
        self.assertEqual(before["messages"][1:], self.request["messages"][1:])
        self.assertEqual(self.request["messages"][0]["content"], "native persona")
        self.assertIsNone(self.tool(args={"action": "search"}))
        self.assertEqual(self.tool("session_search")["message"], plugin.HISTORY_BLOCKED)
        self.apply()
        self.assertEqual(len(self.queries), 1)
        self.context = "Current notes: []"
        self.prepare(turn_id="two")
        after = self.apply(turn_id="two")["request"]
        self.assertIn("Current notes: []", after["messages"][0]["content"])
        self.assertNotIn("new refractor", after["messages"][0]["content"])
        self.assertEqual(len(self.queries), 2)

    def test_cloud_and_mixed_profiles_never_read_core_even_on_local_fallback(self):
        for settings in [{"model": {"provider": "openai-codex"}}, {"model": {}},
                         {"fallback_providers": [{"provider": "remote"}]}, {"fallback_model": "remote"},
                         {"model": {**MODEL, "base_url": TARGET + "?next=remote"}}]:
            with self.subTest(settings=settings):
                self.configure(**settings)
                self.prepare()
                self.assertIsNone(self.apply())
                self.assertIsNone(self.hooks["llm_request"]({"instructions": "persona", "input": []}, api_mode="codex_responses", **self.id))
                for name in ["session_search", "mcp_agentx_core_memory_search", "mcp__agentx_owner__source_read"]:
                    self.assertEqual(self.tool(name)["message"], plugin.LOCAL_ONLY)
                self.assertEqual(self.tool("tool_call", {"id": "openclaw:core:personal_memory"})["message"], plugin.LOCAL_ONLY)
                self.assertIsNone(self.tool("weather"))
        self.assertEqual(self.queries, [])

    def test_matching_cloud_urls_cannot_impersonate_a_local_core(self):
        for origin in ["https://public.invalid", "https://203.0.113.8", "http://user@127.0.0.1"]:
            self.configure(model={**MODEL, "base_url": origin + "/api/llm/v1"},
                           mcp_servers={"agentx-owner": {"url": origin + "/api/consumers/nestor/v1/mcp"}})
            self.prepare()
            self.assertIsNone(self.apply(base_url=origin + "/api/llm/v1"))
            self.assertEqual(self.tool()["message"], plugin.LOCAL_ONLY)
        self.assertEqual(self.queries, [])

    def test_permission_follows_actual_attempt_and_excludes_missing_routes_and_other_turns(self):
        self.prepare()
        self.assertEqual(self.tool()["message"], plugin.LOCAL_ONLY)
        for changes in [{"provider": "unknown"}, {"base_url": TARGET + ".invalid"}, {"model": "other"},
                        {"api_mode": "codex_responses"}, {"base_url": ""}]:
            self.assertIsNone(self.apply(**changes))
        self.assertFalse(self.queries)
        self.apply()
        self.assertIsNone(self.tool("source_read"))
        self.assertIsNone(self.apply(provider="external"))
        self.assertEqual(self.tool("source_read")["message"], plugin.LOCAL_ONLY)
        self.prepare(turn_id="child", parent_session_id="parent")
        self.assertIsNone(self.apply(turn_id="child"))
        self.assertEqual(self.tool(turn_id="child")["message"], plugin.LOCAL_ONLY)
        self.protected = False
        self.prepare(turn_id="history")
        self.apply(turn_id="history")
        self.assertIsNone(self.tool("session_search", turn_id="history"))
