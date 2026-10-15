from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_store import load, save
from history_import import entry_key, prepare, publish


class Response:
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self):
        return json.dumps(self.body).encode()


class HistoryImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {"threadId": "thread01", "evidenceHash": "a" * 64, "messages": [
            {"id": "message1", "internalDate": "1735732800000"},
            {"id": "message2", "internalDate": "1767268800000"}]}
        self.archive = SimpleNamespace(root=self.root, manifests=lambda: [self.manifest])
        for mid in ('message1', 'message2'):
            original = self.root / 'raw' / f'{mid}.eml'
            original.parent.mkdir(exist_ok=True)
            original.write_bytes(b'Synthetic source')
            save(self.root / 'raw-receipts' / f'{mid}.json', {'sha256': 'b' * 64,
                'bytes': original.stat().st_size, 'path': str(original.relative_to(self.root))})
        save(self.root / 'threads/thread01/original.json', {'thread': {'messages': [
            {'id': 'message1', 'labelIds': ['DRAFT']}, {'id': 'message2', 'labelIds': ['SENT']}]}})
        self.review = {'evidenceHash': 'a' * 64, 'actions': [
            {'messageId': 'message1', 'text': 'Synthetic first request', 'owner': 'Another person', 'due': 'vendredi', 'status': 'uncertain'},
            {'messageId': 'message2', 'text': 'Synthetic recent request', 'status': 'current'}],
            'memories': [], 'deliverables': [], 'invoices': [], 'unresolved': ['Synthetic thread-level question']}
        self.review_path = self.root / 'reviews/thread01.json'
        save(self.review_path, self.review)

    def test_preserves_actor_draft_and_written_date_without_creating_an_event_date(self):
        result = prepare(self.archive)
        first = result['entries'][0]
        self.assertEqual(first['actor'], 'Another person')
        self.assertEqual(first['source']['direction'], 'draft')
        self.assertEqual(first['eventDateAsWritten'], 'vendredi')
        self.assertNotIn('eventDate', first)
        self.assertNotIn('reviewState', first)
        self.assertEqual(result['counts']['threadQuestionsWithoutMessageAttribution'], 1)

    def test_cutoff_is_per_message_and_delivery_state_advances_the_next_batch(self):
        first = prepare(self.archive, maximum=1)
        second = prepare(self.archive, maximum=1, delivered={entry_key(first['entries'][0]): {'id': 'saved'}})
        self.assertEqual(second['entries'][0]['source']['messageId'], 'message2')
        cutoff = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.assertEqual(len(prepare(self.archive, before=cutoff)['entries']), 1)

    def test_stale_missing_and_oversized_findings_remain_reported_gaps(self):
        self.review['actions'][0]['text'] = 'x' * 4001
        self.review['actions'].append({'messageId': 'not-found', 'text': 'Orphaned source'})
        save(self.review_path, self.review)
        result = prepare(self.archive)
        self.assertEqual(result['counts']['findingsRequiringManualNormalization'], 1)
        self.assertEqual(result['counts']['findingsWithoutCurrentMessage'], 1)
        self.review['evidenceHash'] = 'old'
        save(self.review_path, self.review)
        self.assertEqual(prepare(self.archive)['counts']['staleOrMissingReviewThreads'], 1)

    def test_delivery_checks_exact_source_receipts_and_replays_only_undelivered_items(self):
        manifest = prepare(self.archive)
        state = self.root / 'delivery.json'
        calls = []
        def opener(request, **_):
            entries = json.loads(request.data)['entries']
            calls.extend(entries)
            return Response({'status': 'success', 'data': {'results': [
                {'sourceKey': entry_key(entry), 'entry': {'id': entry_key(entry)[:24], 'reviewState': 'candidate'}} for entry in entries]}})
        self.assertEqual(publish(manifest, 'http://127.0.0.1', state, opener=opener)['delivered'], 2)
        publish(manifest, 'http://127.0.0.1', state, opener=opener)
        self.assertEqual(len(calls), 2)

    def test_lost_or_mismatched_receipts_preserve_the_same_payload_for_reconciliation(self):
        manifest = prepare(self.archive)
        state = self.root / 'delivery.json'
        with self.assertRaises(RuntimeError):
            publish(manifest, 'http://127.0.0.1', state, opener=lambda *_args, **_kwargs: Response(
                {'status': 'success', 'data': {'results': [{'sourceKey': 'wrong', 'entry': {'id': 'some-id'}}]}}))
        self.assertEqual(load(state)['phase'], 'unconfirmed')
        self.assertEqual(load(state)['delivered'], {})


if __name__ == '__main__':
    unittest.main()
