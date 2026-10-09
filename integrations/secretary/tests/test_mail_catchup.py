import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock
import urllib.error

HERE = Path(__file__).resolve().parents[1]


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


catchup = load_module("mail_catchup")
watchdog = load_module("openclaw_gmail_secretary_watchdog")


def review(summary="Page lue", **sections):
    return {"summary": summary, "actions": [], "memories": [], "deliverables": [], "invoices": [],
            "unresolved": [], **sections}


class FakeClient:
    def __init__(self, replies=None, busy=()):
        self.replies, self.busy_reasons, self.calls = replies, list(busy), []

    def busy(self):
        return self.busy_reasons.pop(0) if self.busy_reasons else None

    def propose(self, proposal):
        if getattr(self, "core_down", False):
            raise catchup.Busy("Core unreachable")
        self.proposed = getattr(self, "proposed", []) + [proposal["key"]]
        return "idea-" + proposal["key"][:6]

    def extract(self, system, prompt, light=False):
        self.calls.append({"prompt": prompt, "light": light, "system": system})
        reply = self.replies(prompt) if callable(self.replies) else review()
        if isinstance(reply, Exception):
            raise reply
        return reply


class FakeLock:
    def touch(self):
        pass


class CatchupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.threads = {}
        self.archive = catchup.Archive(self.root, self.gmail)

    def gmail(self, command):
        return self.threads[next(part for part in command if part in self.threads)]

    def thread(self, tid, body, labels=(), internal=None, scope=None):
        internal = internal or str(int(time.time() * 1000))
        self.threads[tid] = {"thread": {"messages": [{"id": tid + "-m", "body": body, "labelIds": list(labels),
                             "headers": {"subject": "Synthetic " + tid}, "internalDate": internal}]}}
        self.archive.collect_thread(tid)
        if scope:
            file = self.root / f"inventory-{scope}.json"
            inventory = catchup.load(file, {"complete": True, "messages": {}})
            inventory["messages"][tid + "-m"] = {"id": tid + "-m", "threadId": tid}
            catchup.save(file, inventory)

    def run_catchup(self, client, **options):
        options.setdefault("sleep", lambda _: None)
        return catchup.catchup(self.archive, client, FakeLock(), **options)

    def test_lanes_run_in_priority_order_and_record_without_the_agent_cursor(self):
        self.thread("thread-bulk1", "Promo synthetic", labels=["CATEGORY_PROMOTIONS"])
        self.thread("thread-mail1", "Ordinary synthetic mail")
        self.thread("thread-inv1", "Synthetic invoice mail", scope="invoices")
        self.thread("thread-con1", "Named correspondence", scope="contact")
        client = FakeClient()
        status = self.run_catchup(client)
        order = [next(t for t in self.threads if f"Synthetic {t}" in call["prompt"]) for call in client.calls]
        self.assertEqual(order, ["thread-con1", "thread-inv1", "thread-mail1", "thread-bulk1"])
        self.assertEqual([call["light"] for call in client.calls], [False, False, False, True])
        self.assertEqual((status["phase"], status["reviewed"], status["remaining"]), ("done", 4, 0))
        self.assertEqual(self.archive.native_status()["pendingTextPages"], 0)
        self.assertFalse((self.root / "native-worker.json").exists())
        self.assertIn('"namedCorrespondence": true', client.calls[0]["prompt"])

    def test_benchmark_or_maintenance_pauses_the_same_page_then_resumes(self):
        self.thread("thread-mail1", "Ordinary synthetic mail")
        slept = []
        client = FakeClient(busy=["benchmark running", "maintenance"])
        status = self.run_catchup(client, sleep=slept.append)
        self.assertEqual(slept, [catchup.PAUSE_SECONDS, catchup.PAUSE_SECONDS])
        self.assertEqual((status["reviewed"], len(client.calls)), (1, 1))
        self.assertNotIn("paused", catchup.load(self.root / catchup.STATUS_NAME))

    def test_invalid_model_output_is_logged_and_repeated_failures_stop_the_job(self):
        for index in range(catchup.MAX_CONSECUTIVE_FAILURES + 2):
            self.thread(f"thread-mail{index}", f"Synthetic mail {index}", internal=str(1000 + index))
        client = FakeClient(replies=lambda _: ValueError("Model output is not a JSON object"))
        status = self.run_catchup(client)
        self.assertEqual((status["phase"], status["failed"]), ("stopped", catchup.MAX_CONSECUTIVE_FAILURES))
        self.assertEqual(len(catchup.load(self.root / catchup.ERRORS_NAME)), catchup.MAX_CONSECUTIVE_FAILURES)
        self.assertEqual(list((self.root / "page-reviews").glob("*.json")) if (self.root / "page-reviews").exists() else [], [])

    def test_only_current_findings_from_recent_mail_are_queued_for_the_owner(self):
        self.thread("thread-recent", "Please send the signed form")
        self.thread("thread-old", "Please send the old form", internal="1000")
        action = {"text": "Envoyer le formulaire signé", "status": "current", "owner": "owner", "due": "unknown"}
        client = FakeClient(replies=lambda _: review(actions=[dict(action)]))
        status = self.run_catchup(client)
        proposals = catchup.load(self.root / catchup.PROPOSALS_NAME)
        self.assertEqual((status["proposals"], len(proposals)), (1, 1))
        self.assertEqual((proposals[0]["threadId"], proposals[0]["state"], proposals[0]["due"]), ("thread-recent", "queued", None))
        self.assertEqual((proposals[0]["state"], proposals[0]["ideaId"], len(proposals[0]["key"])), ("queued", "idea-" + proposals[0]["key"][:6], 32))
        self.assertEqual(client.proposed, [proposals[0]["key"]])
        saved = catchup.load(self.root / "reviews/thread-old.json")["actions"][0]
        self.assertEqual((saved["status"], saved["messageId"]), ("current", "thread-old-m"))

    def test_a_thread_changed_by_collection_is_skipped_without_a_model_call_or_failure(self):
        self.thread("thread-mail1", "Ordinary synthetic mail")
        client = FakeClient()
        original = catchup.pending_pages

        def collected_meanwhile(archive):
            queues = original(archive)
            self.threads["thread-mail1"]["thread"]["messages"].append(
                {"id": "thread-mail1-r", "body": "A new reply", "headers": {}, "internalDate": "2"})
            archive.collect_thread("thread-mail1")
            return queues
        with mock.patch.object(catchup, "pending_pages", collected_meanwhile):
            status = self.run_catchup(client)
        self.assertEqual((status["reviewed"], status["failed"], client.calls), (0, 0, []))
        self.assertEqual(self.archive.native_status()["pendingTextPages"], 2)

    def test_an_unreachable_core_keeps_proposals_pending_until_the_next_run(self):
        self.thread("thread-recent", "Please send the signed form")
        action = {"text": "Envoyer le formulaire", "status": "current", "owner": "owner", "due": "unknown"}
        client = FakeClient(replies=lambda _: review(actions=[dict(action)]))
        client.core_down = True
        self.run_catchup(client)
        self.assertEqual(catchup.load(self.root / catchup.PROPOSALS_NAME)[0]["state"], "pending")
        client.core_down = False
        self.run_catchup(client)
        self.assertEqual(catchup.load(self.root / catchup.PROPOSALS_NAME)[0]["state"], "queued")

    def test_review_normalizes_unknowns_and_cites_the_page_attachment(self):
        page = {"pageId": "p1", "messageId": "m1", "attachment": {"sha256": "a" * 64}}
        raw = review(invoices=[{"supplier": "Synthetic clinic", "grossAmount": "130,00", "insurer": "unknown"}],
                     memories=[{"text": " ", "status": "current"}, {"text": "Fait daté", "status": "bogus"}],
                     unresolved=["scan illisible", ""])
        value = catchup.to_review(page, raw)
        self.assertEqual(value["invoices"][0]["insurer"], None)
        self.assertEqual(value["invoices"][0]["attachmentSha256"], "a" * 64)
        self.assertEqual([m["status"] for m in value["memories"]], ["uncertain"])
        self.assertEqual(value["unresolved"], ["scan illisible"])

    def test_agent_turn_only_collects_while_the_catchup_lock_is_fresh(self):
        self.thread("thread-mail1", "Ordinary synthetic mail")
        for scope in catchup.QUERIES if hasattr(catchup, "QUERIES") else ("invoices", "mailbox"):
            catchup.save(self.root / f"inventory-{scope}.json", {"complete": True, "messages": {}, "headCheckedEpoch": time.time()})
        (self.root / catchup.LOCK_NAME).write_text("{}")
        with mock.patch.object(self.archive, "collect", return_value={"errors": []}):
            step = self.archive.native_next()
            self.assertEqual((step["outcome"], step.get("catchup")), ("empty", True))
            self.assertTrue(watchdog.catchup_running(self.root))
            (self.root / catchup.LOCK_NAME).unlink()
            self.assertFalse(watchdog.catchup_running(self.root))
            self.assertEqual(self.archive.native_next()["outcome"], "ready")


class StoreTests(unittest.TestCase):
    def test_concurrent_writers_never_share_a_temporary_file(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "native-status.json"
            names = []
            original = Path.replace

            def recording(self, destination):
                names.append(self.name)
                return original(self, destination)
            with mock.patch.object(Path, "replace", recording), mock.patch.object(catchup.os, "getpid", side_effect=[101, 202]):
                import evidence_store
                with mock.patch.object(evidence_store.os, "getpid", side_effect=[101, 202]):
                    evidence_store.save(target, {"writer": 1})
                    evidence_store.save(target, {"writer": 2})
            self.assertEqual(names, ["native-status.json.101.tmp", "native-status.json.202.tmp"])
            self.assertEqual(catchup.load(target), {"writer": 2})
            self.assertEqual(list(Path(temp).glob("*.tmp")), [])


class CoreClientTests(unittest.TestCase):
    def opener(self, *responses):
        calls = []

        def open_(request, timeout):
            calls.append(json.loads(request.data) if request.data else request.full_url)
            response = responses[len(calls) - 1]
            if isinstance(response, Exception):
                raise response
            reply = mock.MagicMock(status=200)
            reply.read.return_value = json.dumps(response).encode()
            reply.__enter__.return_value = reply
            return reply
        return open_, calls

    def test_schema_constrained_task_routed_request_and_light_model(self):
        open_, calls = self.opener({"message": {"content": json.dumps(review())}}, {"response": json.dumps(review())})
        client = catchup.CoreClient("http://core.invalid", "analysis", "small-model", "spare", opener=open_)
        self.assertEqual(client.extract("sys", "page")["summary"], "Page lue")
        client.extract("sys", "page", light=True)
        self.assertEqual((calls[0]["taskType"], calls[0]["format"], calls[0]["think"]), ("analysis", catchup.REVIEW_SCHEMA, False))
        self.assertEqual((calls[1]["model"], calls[1]["host"], "taskType" in calls[1]), ("small-model", "spare", False))

    def test_refusals_and_outages_pause_instead_of_failing(self):
        refused = urllib.error.HTTPError("http://core.invalid", 409, "claim", {"Retry-After": "30"}, io.BytesIO(b"{}"))
        open_, _ = self.opener(refused, urllib.error.URLError("down"), {"data": {"maintenance": None, "workloads": [{"kind": "benchmark"}]}})
        client = catchup.CoreClient("http://core.invalid", opener=open_)
        with self.assertRaises(catchup.Busy) as caught:
            client.extract("sys", "page")
        self.assertEqual(caught.exception.retry_after, 30)
        with self.assertRaises(catchup.Busy):
            client.extract("sys", "page")
        self.assertEqual(client.busy(), "benchmark running")

    def test_an_announced_recreate_pauses_the_job_before_its_next_page(self):
        open_, _ = self.opener({"data": {"maintenance": None, "workloads": [], "drain": {"scope": "core-recreate"}}},
                               {"data": {"maintenance": None, "workloads": [], "drain": None}})
        client = catchup.CoreClient("http://core.invalid", opener=open_)
        self.assertEqual(client.busy(), "deploy pending")
        self.assertIsNone(client.busy())


if __name__ == "__main__":
    unittest.main()
