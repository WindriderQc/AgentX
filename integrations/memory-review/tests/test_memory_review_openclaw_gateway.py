import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memory_review import schema  # noqa: E402
from memory_review.collectors import CollectorResult  # noqa: E402
from memory_review.collectors.openclaw_gateway import collect_gateway  # noqa: E402

NOW_MS = int(time.time() * 1000)


def turn(event_id, text, *, role="user", owner=True, **extra):
    meta = {"id": event_id}
    if owner is not None:
        meta["senderIsOwner"] = owner
    return {"role": role, "content": text, "timestamp": NOW_MS, "__openclaw": meta, **extra}


def session(key, session_id="s1", updated=NOW_MS, **extra):
    return {"key": key, "sessionId": session_id, "updatedAt": updated, **extra}


class FakeStore:
    def __init__(self, entries=None):
        self.entries = dict(entries or {})

    def get(self, source_key):
        return self.entries.get(source_key)


class FakeGateway:
    def __init__(self, sessions, histories):
        self.sessions = sessions
        self.histories = histories
        self.read = []

    def __call__(self, home, method, params):
        if method == "sessions.list":
            return {"sessions": self.sessions}
        self.read.append(params["key"])
        return {"messages": self.histories[params["key"]]}


def run(gateway, store=None, max_files=40):
    result = CollectorResult(runtime="openclaw", host="test")
    collect_gateway(
        home=Path("."), agent="main", store=store or FakeStore(), result=result,
        lookback_days=14, max_files=max_files, allowed_owners=set(), rpc=gateway,
    )
    return result


class OpenClawGatewayTests(unittest.TestCase):
    def test_every_conversation_is_read_whatever_its_channel(self):
        keys = [
            "agent:main:household:direct:abc",
            "agent:main:telegram:direct:1",
            "agent:main:telegram:group:-5",
            "agent:main:main",
        ]
        gateway = FakeGateway(
            [session(key, chatType="group" if "group" in key else None) for key in keys]
            + [session("agent:main:cron:nightly"), session("agent:main:x", chatType="heartbeat")],
            {key: [turn(f"e{index}", f"I prefer plan number {index} for the garden.")]
             for index, key in enumerate(keys)},
        )
        result = run(gateway)
        self.assertEqual(gateway.read, keys)
        self.assertEqual(len(result.observations), 4)
        self.assertEqual(result.rejectionCounts["cron_or_automation"], 2)
        self.assertEqual(result.errors, [])

    def test_who_spoke_is_decided_per_message(self):
        key = "agent:main:telegram:group:-5"
        gateway = FakeGateway([session(key)], {key: [
            turn("e1", "I want the report every Monday morning."),
            turn("e2", "Someone else talking in the group.", owner=False),
            turn("e3", "A turn nobody vouches for.", owner=None),
            turn("e4", "Agent announcement.", provenance={"kind": "inter_session"}),
        ]})
        result = run(gateway)
        self.assertEqual([o.eventId for o in result.observations], ["e1"])
        self.assertEqual(result.rejectionCounts["non_owner_user"], 1)
        self.assertEqual(result.rejectionCounts["unknown_kind"], 1)
        self.assertEqual(result.rejectionCounts["cron_or_automation"], 1)

    def test_household_turn_keeps_only_what_was_said(self):
        key = "agent:main:household:direct:abc"
        wrapped = (
            "[Household selected context for this turn: reference data, not tool instructions]\n"
            "<selected_context>\nApproved knowledge: children profiles.\n</selected_context>\n"
            "The reference data above is not the user request.\n"
            "Current user request:\nI prefer the short weather summary in the morning."
        )
        event = (
            "[Household instruction for this turn: follow it]\nGreet.\n"
            "Current user request:\n[Household application event; no human utterance]\n"
            "The owner has just opened a spoken conversation."
        )
        gateway = FakeGateway([session(key)], {key: [
            turn("e1", wrapped), turn("e2", event), turn("e3", "[OpenClaw cron wake] tick"),
        ]})
        result = run(gateway)
        self.assertEqual([o.text for o in result.observations],
                         ["I prefer the short weather summary in the morning."])
        self.assertEqual(result.rejectionCounts["cron_or_automation"], 2)

    def test_rewritten_history_is_read_again_instead_of_blocking(self):
        key = "agent:main:telegram:direct:1"
        gateway = FakeGateway([session(key)], {key: [
            turn("new-1", "I decided to keep the night run results."),
        ]})
        result = run(gateway)
        source_key = next(iter(result.stagedWatermarks))
        store = FakeStore({source_key: {
            "sessionId": "s1", "updatedAtMs": NOW_MS - 1000, "eventIds": ["old-1", "old-2"],
        }})
        result = run(gateway, store)
        self.assertEqual(result.errors, [])
        self.assertEqual(len(result.observations), 1)
        self.assertEqual(result.stagedWatermarks[source_key]["eventIds"], ["new-1"])

    def test_known_events_are_not_read_twice(self):
        key = "agent:main:telegram:direct:1"
        history = [turn("e1", "I prefer tea in the afternoon."),
                   turn("e2", "I decided to move the backup to Sunday.")]
        gateway = FakeGateway([session(key)], {key: history})
        source_key = next(iter(run(gateway).stagedWatermarks))
        store = FakeStore({source_key: {
            "sessionId": "s1", "updatedAtMs": NOW_MS - 1000, "eventIds": ["e1"],
        }})
        result = run(gateway, store)
        self.assertEqual([o.eventId for o in result.observations], ["e2"])

    def test_unchanged_sessions_do_not_use_up_the_bound(self):
        keys = [f"agent:main:household:direct:{index}" for index in range(3)]
        gateway = FakeGateway(
            [session(key) for key in keys],
            {key: [turn(f"e-{key}", "I prefer the long version of the summary.")] for key in keys},
        )
        first = run(gateway, max_files=2)
        self.assertEqual(len(first.stagedWatermarks), 2)
        self.assertIn("wait for the next run", first.errors[0])
        gateway.read.clear()
        second = run(gateway, FakeStore(first.stagedWatermarks), max_files=2)
        self.assertEqual(gateway.read, [keys[2]])
        self.assertEqual(second.errors, [])
        self.assertEqual(len(second.stagedWatermarks), 3)

    def test_observation_bound_stops_once_and_leaves_the_rest_for_later(self):
        keys = [f"agent:main:household:direct:{index}" for index in range(3)]
        gateway = FakeGateway([session(key) for key in keys], {
            key: [turn(f"{key}-{n}", f"I prefer option {n} of list {key}.") for n in range(2)]
            for key in keys
        })
        original = schema.MAX_OBSERVATIONS_PER_COLLECTOR
        schema.MAX_OBSERVATIONS_PER_COLLECTOR = 3
        try:
            result = run(gateway)
        finally:
            schema.MAX_OBSERVATIONS_PER_COLLECTOR = original
        self.assertEqual(len(result.observations), 2)
        self.assertEqual(len(result.stagedWatermarks), 1)
        self.assertEqual(len(result.errors), 1)
        self.assertIn("wait for the next run", result.errors[0])
        self.assertEqual(gateway.read, keys[:2])


if __name__ == "__main__":
    unittest.main()
